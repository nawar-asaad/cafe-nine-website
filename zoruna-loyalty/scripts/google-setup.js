// تشغيل مرة واحدة: ينشئ (أو يحدّث) فئة بطاقة الولاء في Google Wallet.
const google = require('../src/google');

if (!google.isConfigured()) {
  console.error('اضبط GOOGLE_ISSUER_ID و GOOGLE_SERVICE_ACCOUNT_FILE في ملف .env أولاً');
  process.exit(1);
}
google.ensureClass().then(
  (c) => console.log('تم إعداد فئة البطاقة:', c.id, '| حالة المراجعة:', c.reviewStatus),
  (e) => { console.error(e.message); process.exit(1); },
);
