// بطاقة Google Wallet لهواتف أندرويد.
// نضع موقع المطعم في merchantLocations، فيرسل Google Wallet تنبيهاً على شاشة القفل
// عند اقتراب الزبون. نص هذا التنبيه يكتبه Google (اسم البرنامج)، أما الرسائل التي
// نرسلها نحن (addMessage) فتظهر بنصّنا البصراوي كاملاً.
const fs = require('node:fs');
const crypto = require('node:crypto');
const config = require('./config');
const { pickGreeting } = require('./greetings');

const { google, restaurant, loyalty } = config;
const API = 'https://walletobjects.googleapis.com/walletobjects/v1';

let account = null;
function serviceAccount() {
  if (!account && google.serviceAccountFile && fs.existsSync(google.serviceAccountFile)) {
    account = JSON.parse(fs.readFileSync(google.serviceAccountFile, 'utf8'));
  }
  return account;
}

const isConfigured = () => Boolean(google.issuerId && serviceAccount());
const classId = () => `${google.issuerId}.${google.classSuffix}`;
const objectId = (c) => `${google.issuerId}.${c.serial.replace(/-/g, '_')}`;

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
function signJwt(payload) {
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount().private_key);
  return `${unsigned}.${sig.toString('base64url')}`;
}

let cachedToken = { value: '', exp: 0 };
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.exp - 60 > now) return cachedToken.value;
  const sa = serviceAccount();
  const assertion = signJwt({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Google OAuth: ${res.status} ${await res.text()}`);
  const j = await res.json();
  cachedToken = { value: j.access_token, exp: now + j.expires_in };
  return cachedToken.value;
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) throw new Error(`Google Wallet ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 404 ? null : res.json();
}

const ar = (value) => ({ defaultValue: { language: 'ar', value } });
const location = () => [{ latitude: restaurant.lat, longitude: restaurant.lng }];

function loyaltyClass() {
  return {
    id: classId(),
    issuerName: restaurant.name,
    localizedIssuerName: ar(restaurant.name),
    programName: restaurant.name,
    localizedProgramName: ar(`بطاقة ولاء ${restaurant.name}`),
    programLogo: { sourceUri: { uri: `${config.publicUrl}/logo.png` } },
    hexBackgroundColor: restaurant.background,
    countryCode: 'IQ',
    reviewStatus: 'UNDER_REVIEW',
    merchantLocations: location(),
  };
}

function loyaltyObject(c) {
  return {
    id: objectId(c),
    classId: classId(),
    state: 'ACTIVE',
    accountId: c.phone,
    accountName: c.name,
    loyaltyPoints: {
      label: `زياراتك من ${loyalty.stampsForReward}`,
      balance: { int: c.stamps },
    },
    secondaryLoyaltyPoints: { label: 'المكافآت', balance: { int: c.rewards } },
    barcode: { type: 'QR_CODE', value: c.serial, alternateText: c.phone.slice(-4) },
    merchantLocations: location(),
    textModulesData: [
      { id: 'news', header: 'آخر الأخبار', body: c.message || pickGreeting(c.updated_at + c.id) },
      { id: 'how', header: 'شلون تشتغل البطاقة؟', body: `كل زيارة ختم، و${loyalty.stampsForReward} أختام = ${loyalty.reward}.` },
    ],
  };
}

// رابط «أضف إلى Google Wallet»: يحتوي البطاقة كاملة موقّعة، فلا نحتاج إنشاءها مسبقاً
function saveUrl(c) {
  const sa = serviceAccount();
  const jwt = signJwt({
    iss: sa.client_email,
    aud: 'google',
    typ: 'savetowallet',
    origins: [config.publicUrl],
    payload: { loyaltyObjects: [loyaltyObject(c)] },
  });
  return `https://pay.google.com/gp/v/save/${jwt}`;
}

async function ensureClass() {
  const existing = await api('GET', `/loyaltyClass/${classId()}`);
  if (existing) return api('PATCH', `/loyaltyClass/${classId()}`, loyaltyClass());
  return api('POST', '/loyaltyClass', loyaltyClass());
}

// تحديث البطاقة بعد ختم أو رسالة جديدة (إن لم يحفظها الزبون بعد، لا شيء يحدث)
async function updateObject(c) {
  if (!isConfigured()) return false;
  const r = await api('PATCH', `/loyaltyObject/${objectId(c)}`, loyaltyObject(c));
  return Boolean(r);
}

// رسالة تظهر للزبون كإشعار. Google يسمح بعدد محدود من الإشعارات يومياً لكل بطاقة.
async function notify(c, header, body) {
  if (!isConfigured()) return false;
  const r = await api('POST', `/loyaltyObject/${objectId(c)}/addMessage`, {
    message: { id: `m${Date.now()}`, header, body, messageType: 'TEXT_AND_NOTIFY' },
  });
  return Boolean(r);
}

module.exports = { isConfigured, saveUrl, ensureClass, updateObject, notify };
