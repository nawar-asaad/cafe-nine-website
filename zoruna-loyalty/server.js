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

// تسجيل زبون من استبيان رمز QR (أو من نموذج الورق عبر لوحة الإدارة)
app.post('/api/join', express.json(), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const phone = store.normalizePhone(b.phone);
  if (!name) return res.status(400).json({ error: 'اكتب اسمك رجاءً' });
  if (!phone) return res.status(400).json({ error: 'رقم الهاتف غير صحيح (مثال: 07701234567)' });
  if (b.consent !== true) return res.status(400).json({ error: 'نحتاج موافقتك حتى نرسل لك التحديثات' });

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
    subscribed: one('SELECT COUNT(*) n FROM customers WHERE opted_out = 0').n,
    appleDevices: one('SELECT COUNT(DISTINCT serial) n FROM apple_devices').n,
    visits: one('SELECT COALESCE(SUM(visits),0) n FROM customers').n,
    ratings: one(`SELECT ROUND(AVG(food),1) food, ROUND(AVG(service),1) service, ROUND(AVG(place),1) place,
                  COUNT(*) n FROM feedback`),
  });
});

admin.get('/customers', (req, res) => {
  const s = `%${String(req.query.q || '').trim()}%`;
  const rows = store.db
    .prepare(`SELECT id, name, phone, serial, stamps, visits, rewards, opted_out, created_at, last_visit_at,
                     (SELECT COUNT(*) FROM apple_devices d WHERE d.serial = c.serial) AS on_iphone
              FROM customers c WHERE name LIKE ? OR phone LIKE ? OR serial = ?
              ORDER BY COALESCE(last_visit_at, created_at) DESC LIMIT 200`)
    .all(s, s, String(req.query.q || ''));
  res.json(rows);
});

admin.get('/feedback', (req, res) => {
  res.json(
    store.db
      .prepare(`SELECT f.*, c.name, c.phone FROM feedback f LEFT JOIN customers c ON c.id = f.customer_id
                ORDER BY f.id DESC LIMIT 100`)
      .all(),
  );
});

// إدخال بيانات نموذج الاستبيان الورقي يدوياً
admin.post('/customers', (req, res) => {
  const b = req.body || {};
  const phone = store.normalizePhone(b.phone);
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name || !phone) return res.status(400).json({ error: 'الاسم أو الرقم غير صحيح' });
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

// تسجيل زيارة: الكاشير يبحث بالرقم أو يمسح رمز البطاقة
admin.post('/customers/:id/stamp', async (req, res) => {
  const r = store.addStamp(Number(req.params.id), config.loyalty.stampsForReward);
  if (!r) return res.sendStatus(404);
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
    for (const c of customers) {
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
  res.json({ recipients: customers.length, wallet, sms: sent });
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
