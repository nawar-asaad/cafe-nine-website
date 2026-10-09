// قاعدة البيانات: SQLite المدمجة في Node (لا تحتاج خادماً منفصلاً).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = new DatabaseSync(process.env.ZORUNA_DB || config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS customers (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    phone         TEXT UNIQUE,              -- اختياري: لاسترجاع البطاقة وللعروض
    serial        TEXT NOT NULL UNIQUE,
    auth_token    TEXT NOT NULL,
    stamps        INTEGER NOT NULL DEFAULT 0,
    visits        INTEGER NOT NULL DEFAULT 0,
    rewards       INTEGER NOT NULL DEFAULT 0,
    message       TEXT NOT NULL DEFAULT '',
    consent_at    TEXT,                     -- موافقة على الرسائل (فقط لمن أعطى رقمه)
    opted_out     INTEGER NOT NULL DEFAULT 0,
    source        TEXT NOT NULL DEFAULT 'qr',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    last_visit_at TEXT,
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
    food        INTEGER,
    service     INTEGER,
    place       INTEGER,
    comment     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- أجهزة آيفون المسجّلة لاستقبال تحديثات البطاقة
  CREATE TABLE IF NOT EXISTS apple_devices (
    device_id  TEXT NOT NULL,
    push_token TEXT NOT NULL,
    serial     TEXT NOT NULL REFERENCES customers(serial) ON DELETE CASCADE,
    PRIMARY KEY (device_id, serial)
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id         INTEGER PRIMARY KEY,
    text       TEXT NOT NULL,
    channels   TEXT NOT NULL,
    wallet     INTEGER NOT NULL DEFAULT 0,
    sms        INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// توحيد أرقام الهواتف العراقية: 07xx… أو 7xx… أو 9647xx… ← ‎+9647xx…
function normalizePhone(input) {
  let d = String(input || '')
    .replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
    .replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c))
    .replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('964')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return /^7\d{9}$/.test(d) ? `+964${d}` : null;
}

// رمز قصير للبطاقة يظهر تحت رمز QR، يكتبه الكاشير إذا تعذّر المسح
const cardCode = (c) => c.serial.slice(0, 6).toUpperCase();

const token = () => crypto.randomBytes(24).toString('base64url');

const q = {
  byPhone: db.prepare('SELECT * FROM customers WHERE phone = ?'),
  bySerial: db.prepare('SELECT * FROM customers WHERE serial = ?'),
  byId: db.prepare('SELECT * FROM customers WHERE id = ?'),
  insert: db.prepare(`INSERT INTO customers (name, phone, serial, auth_token, consent_at, source)
                      VALUES (?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END, ?)`),
  rename: db.prepare(`UPDATE customers SET name = ?, opted_out = 0, consent_at = datetime('now'),
                      updated_at = unixepoch() WHERE id = ?`),
  feedback: db.prepare('INSERT INTO feedback (customer_id, food, service, place, comment) VALUES (?, ?, ?, ?, ?)'),
};

// الرقم اختياري: من يعطي رقمه تُربط بطاقته به (ونرجعها له إذا سجّل من جديد)،
// ومن لا يعطيه تُنشأ له بطاقة جديدة لا تحمل إلا اسمه.
function upsertCustomer({ name, phone = null, source = 'qr' }) {
  const existing = phone ? q.byPhone.get(phone) : null;
  if (existing) {
    q.rename.run(name, existing.id);
    return q.byId.get(existing.id);
  }
  const serial = crypto.randomUUID();
  q.insert.run(name, phone, serial, token(), phone ? 1 : 0, source);
  return q.bySerial.get(serial);
}

function addFeedback(customerId, { food, service, place, comment }) {
  const r = (v) => (Number(v) >= 1 && Number(v) <= 5 ? Number(v) : null);
  q.feedback.run(customerId, r(food), r(service), r(place), String(comment || '').slice(0, 1000));
}

// إضافة رقم لبطاقة موجودة (الزبون سجّل بلا رقم ثم غيّر رأيه)
function setPhone(customerId, phone) {
  const other = q.byPhone.get(phone);
  if (other && other.id !== customerId) return null;
  db.prepare(`UPDATE customers SET phone = ?, opted_out = 0, consent_at = datetime('now'),
              updated_at = unixepoch() WHERE id = ?`).run(phone, customerId);
  return q.byId.get(customerId);
}

// هل أخذ الزبون ختماً اليوم؟ «اليوم» بتوقيت المطعم (offset مثل '+3 hours' لبغداد)
function stampedToday(c, offset) {
  if (!c.last_visit_at) return false;
  return db.prepare('SELECT date(?, ?) = date(\'now\', ?) AS same').get(c.last_visit_at, offset, offset).same === 1;
}

// تسجيل زيارة: ختم واحد باليوم، ومكافأة عند اكتمال البطاقة
function addStamp(customerId, stampsForReward, offset = '+3 hours') {
  const c = q.byId.get(customerId);
  if (!c) return null;
  if (stampedToday(c, offset)) return { customer: c, alreadyToday: true };
  let stamps = c.stamps + 1;
  let rewards = c.rewards;
  if (stamps >= stampsForReward) {
    stamps = 0;
    rewards += 1;
  }
  db.prepare(`UPDATE customers SET stamps = ?, rewards = ?, visits = visits + 1,
              last_visit_at = datetime('now'), updated_at = unixepoch() WHERE id = ?`)
    .run(stamps, rewards, customerId);
  return { customer: q.byId.get(customerId), earnedReward: rewards > c.rewards, alreadyToday: false };
}

function redeemReward(customerId) {
  const r = db.prepare(`UPDATE customers SET rewards = rewards - 1, updated_at = unixepoch()
                        WHERE id = ? AND rewards > 0`).run(customerId);
  return r.changes ? q.byId.get(customerId) : null;
}

module.exports = {
  db,
  normalizePhone,
  cardCode,
  upsertCustomer,
  addFeedback,
  addStamp,
  setPhone,
  redeemReward,
  getBySerial: (s) => q.bySerial.get(s),
  getById: (id) => q.byId.get(id),
};
