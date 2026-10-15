import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const workerPath = new URL('../worker.js', import.meta.url);
let source = fs.readFileSync(workerPath, 'utf8');
source = source.replace('export default {', 'globalThis.__worker = {');
const context = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, Date, Intl, JSON, Math, RegExp,
  String, Number, Boolean, Array, Object, Set, Map, Promise, Error, TypeError, Uint8Array, Uint32Array,
  AbortController, Blob, FormData, Response, Request, Headers, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('unexpected fetch'); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'worker.js' });

assert.equal(typeof context.runOwnerLiveSelfTest, 'function', 'live self-test function must exist');
assert.equal(typeof context.formatOwnerLiveSelfTestReport, 'function', 'live self-test formatter must exist');
const ownerButtons = context.ownerKeyboard().inline_keyboard.flat().map((b) => b.callback_data);
assert.ok(ownerButtons.includes('owner_live_selftest'), 'owner panel must expose live self-test');

const sqlLog = [];
const sourceRow = { id: 1, user_id: '100', type: 'rss', title: 'Source', url: 'https://example.com/rss', active: 1 };
const destinationRow = { id: 1, user_id: '100', type: 'channel', title: 'Destination', chat_id: '-1001', active: 1 };
class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() {
    sqlLog.push(['first', this.sql, this.args]);
    const q = this.sql.toLowerCase();
    if (q.includes('select 1')) return { ok: 1 };
    if (q.includes('count(*)') && q.includes('sources')) return { count: 1 };
    if (q.includes('count(*)') && q.includes('destination_channels')) return { count: 1 };
    if (q.includes('count(*)') && q.includes('news_deliveries')) return { count: 0 };
    return null;
  }
  async all() {
    sqlLog.push(['all', this.sql, this.args]);
    const q = this.sql.toLowerCase();
    if (q.includes('from sources')) return { results: [sourceRow] };
    if (q.includes('from destination_channels')) return { results: [destinationRow] };
    return { results: [] };
  }
  async run() { sqlLog.push(['run', this.sql, this.args]); return { meta: { changes: 1 } }; }
}
const DB = { prepare: (sql) => new Stmt(sql), batch: async (items) => Promise.all(items.map((x) => x.run())) };
const env = {
  DB, OWNER_ID: '100', TELEGRAM_BOT_TOKEN: 'token', WEBHOOK_SECRET: 'w'.repeat(40), ADMIN_SECRET: 'a'.repeat(40),
  AI_PROVIDER_ORDER: 'cloudflare', CLOUDFLARE_AI_MODEL: '@cf/zai-org/glm-4.7-flash',
  AI: { run: async () => ({ response: 'OK', usage: { prompt_tokens: 2, completion_tokens: 1 } }) },
};
context.telegram = async (_env, method) => {
  if (method === 'getMe') return { ok: true, result: { id: 10, username: 'test_bot', first_name: 'Test' } };
  if (method === 'getWebhookInfo') return { ok: true, result: { url: 'https://example.workers.dev/webhook', pending_update_count: 0 } };
  throw new Error(`unexpected telegram method ${method}`);
};
context.recordAiHealthResult = async () => {};
context.checkStoredDestinationAccess = async () => ({ ok: true, title: 'Destination' });
context.fetchLatestItemFromSource = async () => ({ id: 'x', title: 'خبر نمونه', body: 'متن', source: 'Source', url: 'https://example.com/n' });

const result = await context.runOwnerLiveSelfTest('100', env);
assert.equal(result.ok, true, JSON.stringify(result));
const names = result.checks.map((x) => x.key);
for (const key of ['runtime', 'database', 'telegram_bot', 'telegram_webhook', 'ai', 'destinations', 'sources']) {
  assert.ok(names.includes(key), `missing live check ${key}`);
}
assert.ok(result.checks.every((x) => typeof x.ok === 'boolean'));
const report = context.formatOwnerLiveSelfTestReport(result);
assert.match(report, /تست زنده کامل/);
assert.match(report, /Telegram/);
assert.ok(!report.includes(env.TELEGRAM_BOT_TOKEN));
assert.ok(!report.includes(env.WEBHOOK_SECRET));
assert.ok(!report.includes(env.ADMIN_SECRET));

const warningEnv = { ...env, ADMIN_SECRET: '' };
const warning = await context.runOwnerLiveSelfTest('100', warningEnv);
assert.equal(warning.ok, true);
assert.ok(warning.checks.some((x) => x.key === 'runtime' && x.ok && /هشدار.*ADMIN_SECRET/.test(x.detail)));


const invalidAdminEnv = { ...env, ADMIN_SECRET: 'short-secret' };
const invalidAdmin = await context.runOwnerLiveSelfTest('100', invalidAdminEnv);
assert.equal(invalidAdmin.ok, true, 'invalid ADMIN_SECRET must be a warning, not a failed runtime check');
assert.ok(invalidAdmin.checks.some((x) => x.key === 'runtime' && x.ok && /هشدار.*ADMIN_SECRET.*نامعتبر/.test(x.detail)));

const shortWebhookEnv = { ...env, WEBHOOK_SECRET: 'short', ADMIN_SECRET: 'short-secret' };
const shortWebhook = await context.runOwnerLiveSelfTest('100', shortWebhookEnv);
assert.equal(shortWebhook.ok, true, 'short but Telegram-safe secrets must not fail the full self-test');
assert.ok(shortWebhook.checks.some((x) => x.key === 'runtime' && x.ok && /WEBHOOK_SECRET کوتاه/.test(x.detail)));

console.log('PASS owner live self-test behavior');
