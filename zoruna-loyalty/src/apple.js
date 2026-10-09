// بطاقة Apple Wallet: تولّد ملف ‎.pkpass وتخدم واجهة تحديث البطاقات وترسل تنبيهات APNs.
//
// الفكرة الأساسية: نضع موقع المطعم داخل البطاقة (locations + relevantText)، فيعرض
// الآيفون نفسه العبارة البصراوية على شاشة القفل عند اقتراب الزبون، دون أي تطبيق
// ودون أن يعرف الخادم موقع الزبون إطلاقاً.
const fs = require('node:fs');
const http2 = require('node:http2');
const path = require('node:path');
const express = require('express');
const { PKPass } = require('passkit-generator');
const config = require('./config');
const store = require('./db');
const { pickGreeting } = require('./greetings');

const { apple, restaurant, loyalty } = config;

function isConfigured() {
  return Boolean(
    apple.passTypeId && apple.teamId &&
    [apple.signerCert, apple.signerKey, apple.wwdr].every((f) => f && fs.existsSync(f)),
  );
}

const read = (f) => fs.readFileSync(f);
const assetDir = path.join(config.root, 'assets', 'pass');
const assets = () =>
  Object.fromEntries(
    fs.readdirSync(assetDir).filter((f) => f.endsWith('.png')).map((f) => [f, read(path.join(assetDir, f))]),
  );

function stampsLine(c) {
  return '●'.repeat(c.stamps) + '○'.repeat(Math.max(0, loyalty.stampsForReward - c.stamps));
}

async function buildPass(customer) {
  // نستخدم updated_at بذرةً لاختيار العبارة: كل تحديث للبطاقة يأتي بعبارة جديدة
  const greeting = pickGreeting(customer.updated_at + customer.id);
  const webService = config.publicUrl.startsWith('https://')
    ? { webServiceURL: `${config.publicUrl}/wallet`, authenticationToken: customer.auth_token }
    : {};

  const pass = new PKPass(
    assets(),
    {
      wwdr: read(apple.wwdr),
      signerCert: read(apple.signerCert),
      signerKey: read(apple.signerKey),
      signerKeyPassphrase: apple.signerKeyPassphrase,
    },
    {
      formatVersion: 1,
      passTypeIdentifier: apple.passTypeId,
      teamIdentifier: apple.teamId,
      serialNumber: customer.serial,
      organizationName: restaurant.name,
      description: `بطاقة ولاء ${restaurant.name}`,
      logoText: restaurant.name,
      backgroundColor: restaurant.background,
      foregroundColor: restaurant.foreground,
      labelColor: restaurant.label,
      sharingProhibited: true,
      maxDistance: config.appleMaxDistance,
      ...webService,
    },
  );

  pass.type = 'storeCard';
  pass.headerFields.push({ key: 'rewards', label: 'المكافآت', value: customer.rewards });
  pass.primaryFields.push({
    key: 'stamps',
    label: `زياراتك (${customer.stamps} من ${loyalty.stampsForReward})`,
    value: stampsLine(customer),
    changeMessage: 'صار عندك ختم جديد: %@',
  });
  pass.secondaryFields.push({ key: 'name', label: 'الاسم', value: customer.name });
  pass.auxiliaryFields.push({ key: 'reward', label: 'المكافأة', value: loyalty.reward });
  pass.backFields.push(
    // تغيّر هذا الحقل يُظهر للزبون إشعاراً بنص الرسالة (changeMessage)
    { key: 'news', label: 'آخر الأخبار', value: customer.message || greeting, changeMessage: '%@' },
    { key: 'how', label: 'شلون تشتغل البطاقة؟', value: `كل زيارة ختم، و${loyalty.stampsForReward} أختام = ${loyalty.reward}. اعرض البطاقة على الكاشير.` },
    { key: 'phone', label: 'هاتف المطعم', value: restaurant.phone },
    { key: 'privacy', label: 'الخصوصية', value: 'المطعم لا يعرف موقعك. الهاتف نفسه يقارن موقعك بموقع المطعم ويعرض التذكير. لإيقاف التذكير: أطفئ «اقتراحات على شاشة القفل» من إعدادات البطاقة أو احذفها.' },
  );
  pass.setLocations({ latitude: restaurant.lat, longitude: restaurant.lng, relevantText: greeting });
  pass.setBarcodes({ message: customer.serial, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1', altText: customer.phone.slice(-4) });

  return pass.getAsBuffer();
}

// ---------- إرسال تنبيه تحديث إلى أجهزة آيفون (APNs) ----------
// يكفي إرسال طلب فارغ؛ الآيفون بعدها يطلب البطاقة الجديدة من الخادم ويعرض changeMessage.
function pushTokensFor(serials) {
  if (!serials.length) return [];
  const rows = store.db
    .prepare(`SELECT DISTINCT push_token FROM apple_devices WHERE serial IN (${serials.map(() => '?').join(',')})`)
    .all(...serials);
  return rows.map((r) => r.push_token);
}

async function pushUpdates(serials) {
  if (!isConfigured()) return 0;
  const tokens = pushTokensFor(serials);
  if (!tokens.length) return 0;

  const client = http2.connect('https://api.push.apple.com', {
    cert: read(apple.signerCert),
    key: read(apple.signerKey),
    passphrase: apple.signerKeyPassphrase,
  });
  client.on('error', (e) => console.error('[apns]', e.message));

  const send = (tokenHex) =>
    new Promise((resolve) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${tokenHex}`,
        'apns-topic': apple.passTypeId,
        'content-type': 'application/json',
      });
      req.on('response', (h) => {
        const status = h[':status'];
        // 410 = الجهاز حذف البطاقة أو لم يعد صالحاً
        if (status === 410) store.db.prepare('DELETE FROM apple_devices WHERE push_token = ?').run(tokenHex);
        resolve(status === 200);
      });
      req.on('error', () => resolve(false));
      req.end('{}');
    });

  let ok = 0;
  for (const t of tokens) ok += (await send(t)) ? 1 : 0;
  client.close();
  return ok;
}

// ---------- واجهة الويب التي يستدعيها الآيفون (PassKit Web Service) ----------
const router = express.Router();
router.use(express.json());

function authorized(req, serial) {
  const c = store.getBySerial(serial);
  const header = req.get('Authorization') || '';
  return c && header === `ApplePass ${c.auth_token}` ? c : null;
}

// تسجيل جهاز لاستقبال التحديثات
router.post('/v1/devices/:deviceId/registrations/:passTypeId/:serial', (req, res) => {
  const c = authorized(req, req.params.serial);
  if (!c || req.params.passTypeId !== apple.passTypeId) return res.sendStatus(401);
  const pushToken = String(req.body?.pushToken || '');
  if (!/^[0-9a-f]{32,200}$/i.test(pushToken)) return res.sendStatus(400);
  const r = store.db
    .prepare('INSERT OR REPLACE INTO apple_devices (device_id, push_token, serial) VALUES (?, ?, ?)')
    .run(req.params.deviceId, pushToken, c.serial);
  res.sendStatus(r.changes ? 201 : 200);
});

// الآيفون يسأل: أي البطاقات تغيّرت منذ آخر مرة؟
router.get('/v1/devices/:deviceId/registrations/:passTypeId', (req, res) => {
  const since = Number(req.query.passesUpdatedSince || 0);
  const rows = store.db
    .prepare(`SELECT c.serial, c.updated_at FROM apple_devices d JOIN customers c ON c.serial = d.serial
              WHERE d.device_id = ? AND c.updated_at > ?`)
    .all(req.params.deviceId, since);
  if (!rows.length) return res.sendStatus(204);
  res.json({
    serialNumbers: rows.map((r) => r.serial),
    lastUpdated: String(Math.max(...rows.map((r) => r.updated_at))),
  });
});

// تنزيل النسخة الأحدث من البطاقة
router.get('/v1/passes/:passTypeId/:serial', async (req, res) => {
  const c = authorized(req, req.params.serial);
  if (!c) return res.sendStatus(401);
  res.set('Content-Type', 'application/vnd.apple.pkpass');
  res.set('Last-Modified', new Date(c.updated_at * 1000).toUTCString());
  res.send(await buildPass(c));
});

router.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serial', (req, res) => {
  const c = authorized(req, req.params.serial);
  if (!c) return res.sendStatus(401);
  store.db.prepare('DELETE FROM apple_devices WHERE device_id = ? AND serial = ?').run(req.params.deviceId, c.serial);
  res.sendStatus(200);
});

router.post('/v1/log', (req, res) => {
  console.log('[wallet log]', req.body?.logs);
  res.sendStatus(200);
});

module.exports = { isConfigured, buildPass, pushUpdates, router };
