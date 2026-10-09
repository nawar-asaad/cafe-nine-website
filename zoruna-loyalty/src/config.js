// إعدادات المطعم: عدّل هذا الملف لكل مطعم جديد.
const path = require('node:path');
const fs = require('node:fs');

// تحميل بسيط لملف .env دون مكتبات إضافية
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const env = process.env;
const root = path.join(__dirname, '..');
const file = (p) => (p ? path.resolve(root, p) : '');

module.exports = {
  root,
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  adminPassword: env.ADMIN_PASSWORD || 'change-me',

  restaurant: {
    name: 'مطعم البصرة',
    nameEn: 'Basra Restaurant',
    city: 'البصرة',
    phone: '07700000000',
    lat: Number(env.RESTAURANT_LAT || 30.5085),
    lng: Number(env.RESTAURANT_LNG || 47.7804),
    // ألوان البطاقة
    background: '#14324a',
    foreground: '#ffffff',
    label: '#e9a820',
  },

  loyalty: {
    // عدد الزيارات (الأختام) للحصول على المكافأة
    stampsForReward: 8,
    reward: 'وجبة مجانية',
  },

  // الحد الأقصى لمسافة ظهور تنبيه آبل بالأمتار. آبل تحدد السقف الفعلي
  // (حوالي 100 متر لبطاقات المتاجر)، وهذه القيمة تستطيع تقليله فقط.
  appleMaxDistance: 1000,

  apple: {
    passTypeId: env.APPLE_PASS_TYPE_ID || '',
    teamId: env.APPLE_TEAM_ID || '',
    signerCert: file(env.APPLE_SIGNER_CERT),
    signerKey: file(env.APPLE_SIGNER_KEY),
    signerKeyPassphrase: env.APPLE_SIGNER_KEY_PASSPHRASE || undefined,
    wwdr: file(env.APPLE_WWDR_CERT),
  },

  google: {
    issuerId: env.GOOGLE_ISSUER_ID || '',
    serviceAccountFile: file(env.GOOGLE_SERVICE_ACCOUNT_FILE),
    classSuffix: 'zoruna_loyalty',
  },

  sms: {
    provider: env.SMS_PROVIDER || 'console',
    sender: env.SMS_SENDER || 'Zoruna',
    twilio: { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM },
    httpUrl: env.SMS_HTTP_URL || '',
  },

  dbFile: path.join(root, 'data', 'zoruna.db'),
};
