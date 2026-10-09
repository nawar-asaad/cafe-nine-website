const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZORUNA_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zoruna-')), 't.db');
process.env.ADMIN_PASSWORD = 'secret';
const app = require('../server');
const { normalizePhone } = require('../src/db');

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

test('join requires consent, then creates a card', async () => {
  await new Promise((r) => setTimeout(r, 50));
  let r = await post('/api/join', { name: 'علي', phone: '07701234567' });
  assert.strictEqual(r.status, 400);
  r = await post('/api/join', { name: 'علي', phone: '07701234567', consent: true, food: 5, comment: 'زين' });
  assert.strictEqual(r.status, 200);
  const { serial } = await r.json();
  const card = await (await fetch(`${base}/api/card/${serial}`)).json();
  assert.strictEqual(card.name, 'علي');
  assert.strictEqual(card.stamps, 0);
});

test('admin is password protected and stamps cards up to a reward', async () => {
  assert.strictEqual((await fetch(`${base}/api/admin/customers`)).status, 401);
  const [c] = await (await fetch(`${base}/api/admin/customers?q=علي`, { headers: auth })).json();
  let last;
  for (let i = 0; i < 8; i++) last = await (await post(`/api/admin/customers/${c.id}/stamp`, {}, auth)).json();
  assert.strictEqual(last.earnedReward, true);
  assert.strictEqual(last.customer.stamps, 0);
  assert.strictEqual(last.customer.rewards, 1);
});

test('broadcast skips customers who opted out', async () => {
  const [c] = await (await fetch(`${base}/api/admin/customers`, { headers: auth })).json();
  await post('/api/join', { name: 'زينب', phone: '07809999999', consent: true });
  await fetch(`${base}/api/stop/${c.serial}`, { method: 'POST' });
  const r = await (await post('/api/admin/broadcast', { text: 'هلا', channels: ['sms'] }, auth)).json();
  assert.deepStrictEqual(r, { recipients: 1, wallet: 0, sms: 1 });
});
