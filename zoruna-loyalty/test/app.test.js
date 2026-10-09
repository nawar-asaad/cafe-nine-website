const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZORUNA_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zoruna-')), 't.db');
process.env.ADMIN_PASSWORD = 'secret';
const app = require('../server');
const { normalizePhone, db } = require('../src/db');

let base;
const server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const auth = { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };
const post = (p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('normalizes Iraqi phone numbers', () => {
  assert.strictEqual(normalizePhone('07701234567'), '+9647701234567');
  assert.strictEqual(normalizePhone('+964 770 123 4567'), '+9647701234567');
  assert.strictEqual(normalizePhone('٠٧٧٠١٢٣٤٥٦٧'), '+9647701234567');
  assert.strictEqual(normalizePhone('12345'), null);
});

test('join works without a phone number', async () => {
  await new Promise((r) => setTimeout(r, 50));
  const r = await post('/api/join', { name: 'حسن', food: 4 });
  assert.strictEqual(r.status, 200);
  const { serial } = await r.json();
  const card = await (await fetch(`${base}/api/card/${serial}`)).json();
  assert.strictEqual(card.hasPhone, false);
  assert.strictEqual(card.code, serial.slice(0, 6).toUpperCase());
  // تسجيلان بلا رقم ينشئان بطاقتين منفصلتين
  const r2 = await (await post('/api/join', { name: 'حسن' })).json();
  assert.notStrictEqual(r2.serial, serial);
});

test('a phone number needs consent and must be valid', async () => {
  assert.strictEqual((await post('/api/join', { name: 'علي', phone: '07701234567' })).status, 400);
  assert.strictEqual((await post('/api/join', { name: 'علي', phone: '123', consent: true })).status, 400);
  const r = await post('/api/join', { name: 'علي', phone: '07701234567', consent: true, food: 5, comment: 'زين' });
  assert.strictEqual(r.status, 200);
  const { serial } = await r.json();
  const card = await (await fetch(`${base}/api/card/${serial}`)).json();
  assert.strictEqual(card.name, 'علي');
  assert.strictEqual(card.hasPhone, true);
  // نفس الرقم يرجّع نفس البطاقة (استرجاع الأختام)
  const again = await (await post('/api/join', { name: 'علي', phone: '+9647701234567', consent: true })).json();
  assert.strictEqual(again.serial, serial);
});

test('a phone can be added to a card later, but not one used by another card', async () => {
  const { serial } = await (await post('/api/join', { name: 'مريم' })).json();
  assert.strictEqual((await post(`/api/card/${serial}/phone`, { phone: '07701234567', consent: true })).status, 409);
  assert.strictEqual((await post(`/api/card/${serial}/phone`, { phone: '07711111111' })).status, 400);
  assert.strictEqual((await post(`/api/card/${serial}/phone`, { phone: '07711111111', consent: true })).status, 200);
  assert.strictEqual((await (await fetch(`${base}/api/card/${serial}`)).json()).hasPhone, true);
});

test('admin is password protected', async () => {
  assert.strictEqual((await fetch(`${base}/api/admin/customers`)).status, 401);
});

test('cashier can find a card by its short code', async () => {
  const { serial } = await (await post('/api/join', { name: 'كرار' })).json();
  const rows = await (await fetch(`${base}/api/admin/customers?q=${serial.slice(0, 6).toUpperCase()}`, { headers: auth })).json();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].serial, serial);
});

test('only one stamp per card per day, reward after a full card', async () => {
  const [c] = await (await fetch(`${base}/api/admin/customers?q=علي`, { headers: auth })).json();
  const stamp = () => post(`/api/admin/customers/${c.id}/stamp`, {}, auth);
  const yesterday = () => db.prepare("UPDATE customers SET last_visit_at = datetime('now', '-1 day') WHERE id = ?").run(c.id);

  assert.strictEqual((await stamp()).status, 200);
  const second = await stamp();
  assert.strictEqual(second.status, 409);
  let last;
  for (let i = 1; i < 8; i++) {
    yesterday();
    last = await (await stamp()).json();
  }
  assert.strictEqual(last.earnedReward, true);
  assert.strictEqual(last.customer.stamps, 0);
  assert.strictEqual(last.customer.rewards, 1);
});

test('SMS goes only to customers with a phone who did not opt out', async () => {
  const [ali] = await (await fetch(`${base}/api/admin/customers?q=علي`, { headers: auth })).json();
  await post('/api/join', { name: 'زينب', phone: '07809999999', consent: true });
  await fetch(`${base}/api/stop/${ali.serial}`, { method: 'POST' });
  const r = await (await post('/api/admin/broadcast', { text: 'هلا', channels: ['sms'] }, auth)).json();
  // زينب ومريم عندهن رقم؛ علي أوقف الرسائل؛ الباقين بلا رقم
  assert.strictEqual(r.sms, 2);
  assert.strictEqual(r.withPhone, 2);
});
