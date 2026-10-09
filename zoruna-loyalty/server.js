// خادم «زورونا»: صفحة الاستبيان والتسجيل، البطاقات، ولوحة الإدارة.
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const config = require('./src/config');
const store = require('./src/db');
const apple = require('./src/apple');
const google = require('./src/google');
const sms = require('./src/sms');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const pub = path.join(__dirname, 'public');
const page = (name) => (req, res) => res.sendFile(path.join(pub, name));

// ---------- صفحات الزبون ----------
app.get('/', page('join.html'));
app.get('/c/:serial', page('card.html'));
app.get('/stop/:serial', page('stop.html'));
app.use(express.static(pub, { index: false }));
app.use('/wallet', apple.router);

app.get('/api/info', (req, res) => {
  res.json({
    name: config.restaurant.name,
    stampsForReward: config.loyalty.stampsForReward,
    reward: config.loyalty.reward,
  });
});

// الرقم اختياري. إذا كُتب يجب أن يكون صحيحاً، ويحتاج موافقة على الرسائل.
// يرجع { phone } أو { error }
function readPhone(b, requireConsent) {
  const raw = String(b.phone || '').trim();
  if (!raw) return { phone: null };
  const phone = store.normalizePhone(raw);
  if (!phone) return { error: 'رقم الهاتف غير صحيح (مثال: 07701234567)' };
  if (requireConsent && b.consent !== true) return { error: 'أشّر على الموافقة حتى نحفظ رقمك، أو امسح الرقم' };
  return { phone };
}

// تسجيل زبون من استبيان رمز QR
app.post('/api/join', express.json(), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'اكتب اسمك رجاءً' });
  const { phone, error } = readPhone(b, true);
  if (error) return res.status(400).json({ error });

  const c = store.upsertCustomer({ name, phone, source: 'qr' });
  if (b.food || b.service || b.place || b.comment) store.addFeedback(c.id, b);
  res.json({ serial: c.serial, cardUrl: `/c/${c.serial}` });
});

app.get('/api/card/:serial', (req, res) => {
  const c = store.getBySerial(req.params.serial);
  if (!c) return res.sendStatus(404);
  let googleUrl = null;
  if (google.isConfigured()) googleUrl = google.saveUrl(c);
  res.json({
    name: c.name,
    code: store.cardCode(c),
    hasPhone: Boolean(c.phone),
    stamps: c.stamps,
    rewards: c.rewards,
    optedOut: Boolean(c.opted_out),
    stampsForReward: config.loyalty.stampsForReward,
    reward: config.loyalty.reward,
    restaurant: config.restaurant.name,
    apple: apple.isConfigured(),
    googleUrl,
  });
});

// الزبون يضيف رقمه لاحقاً من صفحة بطاقته (لاسترجاعها إذا ضاع تلفونه)
app.post('/api/card/:serial/phone', express.json(), (req, res) => {
  const c = store.getBySerial(req.params.serial);
  if (!c) return res.sendStatus(404);
  const { phone, error } = readPhone(req.body || {}, true);
  if (error || !phone) return res.status(400).json({ error: error || 'اكتب رقمك' });
  if (!store.setPhone(c.id, phone)) {
    return res.status(409).json({ error: 'هذا الرقم مسجّل ببطاقة ثانية. راجع الكاشير حتى يرجّعلك بطاقتك' });
  }
  res.sendStatus(200);
});

app.get('/pass/:serial.pkpass', async (req, res, next) => {
  try {
    const c = store.getBySerial(req.params.serial);
    if (!c) return res.sendStatus(404);
    if (!apple.isConfigured()) return res.status(503).send('Apple Wallet غير مُعدّ بعد');
    res.set('Content-Type', 'application/vnd.apple.pkpass');
    res.set('Content-Disposition', 'attachment; filename="card.pkpass"');
    res.send(await apple.buildPass(c));
  } catch (e) {
    next(e);
  }
});

// الزبون يوقف الرسائل النصية من الرابط المرفق بكل رسالة
app.post('/api/stop/:serial', (req, res) => {
  const r = store.db
    .prepare('UPDATE customers SET opted_out = 1, updated_at = unixepoch() WHERE serial = ?')
    .run(req.params.serial);
  res.sendStatus(r.changes ? 200 : 404);
});

// صورة QR (للورقة المطبوعة وللبطاقة)
app.get('/qr.svg', async (req, res) => {
  const data = String(req.query.d || `${config.publicUrl}/`).slice(0, 500);
  res.type('image/svg+xml').send(await QRCode.toString(data, { type: 'svg', margin: 1 }));
});

// ---------- لوحة الإدارة (محمية بكلمة مرور) ----------
function adminAuth(req, res, next) {
  const [scheme, value] = (req.get('Authorization') || '').split(' ');
  const [user, pass] = Buffer.from(value || '', 'base64').toString().split(':');
  const expected = Buffer.from(config.adminPassword);
  const given = Buffer.from(pass || '');
  if (scheme === 'Basic' && user === 'admin' && given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Zoruna admin", charset="UTF-8"').sendStatus(401);
}

app.get('/admin', adminAuth, page('admin.html'));
app.get('/print', adminAuth, page('print.html'));
const admin = express.Router();
admin.use(adminAuth, express.json());
app.use('/api/admin', admin);

admin.get('/summary', (req, res) => {
  const one = (sql) => store.db.prepare(sql).get();
  res.json({
    publicUrl: config.publicUrl,
    apple: apple.isConfigured(),
    google: google.isConfigured(),
    smsProvider: config.sms.provider,
    customers: one('SELECT COUNT(*) n FROM customers').n,
    subscribed: one('SELECT COUNT(*) n FROM customers WHERE phone IS NOT NULL AND opted_out = 0').n,
    appleDevices: one('SELECT COUNT(DISTINCT serial) n FROM apple_devices').n,
    visits: one('SELECT COALESCE(SUM(visits),0) n FROM customers').n,
    ratings: one(`SELECT ROUND(AVG(food),1) food, ROUND(AVG(service),1) service, ROUND(AVG(place),1) place,
                  COUNT(*) n FROM feedback`),
  });
});

admin.get('/customers', (req, res) => {
  const text = String(req.query.q || '').trim();
  const s = `%${text}%`;
  // البحث برمز البطاقة القصير (6 أحرف) أو بالرقم التسلسلي الكامل من مسح QR
  const serialPrefix = text.length >= 4 ? `${text.toLowerCase()}%` : '\u0000';
  const rows = store.db
    .prepare(`SELECT id, name, phone, serial, stamps, visits, rewards, opted_out, created_at, last_visit_at,
                     (SELECT COUNT(*) FROM apple_devices d WHERE d.serial = c.serial) AS on_iphone
              FROM customers c WHERE name LIKE ? OR phone LIKE ? OR serial LIKE ?
              ORDER BY COALESCE(last_visit_at, created_at) DESC LIMIT 200`)
    .all(s, s, serialPrefix);
  res.json(rows.map((r) => ({ ...r, code: store.cardCode(r) })));
});

admin.get('/feedback', (req, res) => {
  res.json(
    store.db
      .prepare(`SELECT f.*, c.name, c.phone FROM feedback f LEFT JOIN customers c ON c.id = f.customer_id
                ORDER BY f.id DESC LIMIT 100`)
      .all(),
  );
});

// إدخال بيانات نموذج الاستبيان الورقي يدوياً.
// الموظف يكتب الرقم فقط إذا أشّر الزبون على خانة الموافقة في الورقة.
admin.post('/customers', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'اكتب الاسم' });
  const { phone, error } = readPhone(b, false);
  if (error) return res.status(400).json({ error });
  const c = store.upsertCustomer({ name, phone, source: 'paper' });
  store.addFeedback(c.id, b);
  res.json(c);
});

async function syncWallets(c, notifyText) {
  const results = { apple: 0, google: false };
  try {
    results.apple = await apple.pushUpdates([c.serial]);
  } catch (e) {
    console.error('[apple]', e.message);
  }
  try {
    results.google = await google.updateObject(c);
    if (notifyText) await google.notify(c, config.restaurant.name, notifyText);
  } catch (e) {
    console.error('[google]', e.message);
  }
  return results;
}

// تسجيل زيارة: الكاشير يمسح رمز البطاقة أو يبحث بالاسم أو الرقم. ختم واحد باليوم.
admin.post('/customers/:id/stamp', async (req, res) => {
  const r = store.addStamp(Number(req.params.id), config.loyalty.stampsForReward, config.loyalty.timezoneOffset);
  if (!r) return res.sendStatus(404);
  if (r.alreadyToday) return res.status(409).json({ error: 'هذا الزبون أخذ ختم اليوم. الختم الجاي باچر إن شاء الله' });
  const text = r.earnedReward
    ? `مبروك! كمّلت البطاقة وصارت عندك ${config.loyalty.reward} 🎉`
    : null;
  await syncWallets(r.customer, text);
  res.json(r);
});

admin.post('/customers/:id/redeem', async (req, res) => {
  const c = store.redeemReward(Number(req.params.id));
  if (!c) return res.status(400).json({ error: 'لا توجد مكافأة' });
  await syncWallets(c);
  res.json(c);
});

admin.delete('/customers/:id', (req, res) => {
  store.db.prepare('DELETE FROM customers WHERE id = ?').run(Number(req.params.id));
  res.sendStatus(200);
});

// حملة: رسالة لكل المشتركين عبر البطاقة (إشعار على شاشة القفل) و/أو SMS
admin.post('/broadcast', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 300);
  const channels = new Set(Array.isArray(req.body?.channels) ? req.body.channels : []);
  if (!text) return res.status(400).json({ error: 'اكتب نص الرسالة' });

  const customers = store.db.prepare('SELECT * FROM customers WHERE opted_out = 0').all();
  let wallet = 0;
  let sent = 0;

  if (channels.has('wallet')) {
    // تغيّر حقل «آخر الأخبار» في البطاقة يجعل الآيفون يعرض النص كإشعار
    store.db.prepare('UPDATE customers SET message = ?, updated_at = unixepoch() WHERE opted_out = 0').run(text);
    try {
      wallet += await apple.pushUpdates(customers.map((c) => c.serial));
    } catch (e) {
      console.error('[apple]', e.message);
    }
    if (google.isConfigured()) {
      for (const c of customers) {
        try {
          if (await google.updateObject({ ...c, message: text })) {
            await google.notify(c, config.restaurant.name, text);
            wallet += 1;
          }
        } catch (e) {
          console.error('[google]', e.message);
        }
      }
    }
  }

  if (channels.has('sms')) {
    for (const c of customers.filter((x) => x.phone)) {
      try {
        if (await sms.send(c.phone, sms.withOptOut(text, c.serial))) sent += 1;
      } catch (e) {
        console.error('[sms]', e.message);
      }
    }
  }

  store.db
    .prepare('INSERT INTO campaigns (text, channels, wallet, sms) VALUES (?, ?, ?, ?)')
    .run(text, [...channels].join(','), wallet, sent);
  res.json({ recipients: customers.length, withPhone: customers.filter((c) => c.phone).length, wallet, sms: sent });
});

admin.get('/campaigns', (req, res) => {
  res.json(store.db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 50').all());
});

admin.get('/export.csv', (req, res) => {
  const rows = store.db.prepare('SELECT name, phone, visits, stamps, rewards, opted_out, created_at, last_visit_at FROM customers').all();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [Object.keys(rows[0] || { name: 0, phone: 0 }).join(','), ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n');
  res.type('text/csv; charset=utf-8').attachment('customers.csv').send(`﻿${csv}`);
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'حدث خطأ في الخادم' });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`زورونا يعمل على ${config.publicUrl}`);
    console.log(`Apple Wallet: ${apple.isConfigured() ? 'جاهز' : 'غير مُعدّ'} | Google Wallet: ${google.isConfigured() ? 'جاهز' : 'غير مُعدّ'} | SMS: ${config.sms.provider}`);
  });
}

module.exports = app;
