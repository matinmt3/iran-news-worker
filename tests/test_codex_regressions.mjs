import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

let source = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
source = source.replace('export default {', 'globalThis.__worker = {');
const context = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, Date, Intl, JSON, Math, RegExp,
  String, Number, Boolean, Array, Object, Set, Map, Promise, Error, TypeError, Uint8Array, Uint32Array,
  AbortController, Blob, FormData, Response, Request, Headers, ReadableStream, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('unexpected fetch'); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'worker.js' });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('RSS entries are normalized newest-first even when XML is ascending', () => {
  const xml = `<rss><channel><title>Feed</title>
    <item><title>Old</title><link>https://example.com/old</link><pubDate>Wed, 15 Jul 2026 10:00:00 GMT</pubDate></item>
    <item><title>New</title><link>https://example.com/new</link><pubDate>Fri, 17 Jul 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = context.parseFeed(xml, 'https://example.com/feed');
  assert.equal(JSON.stringify(items.map((item) => item.title)), JSON.stringify(['New', 'Old']));
});

test('Atom prefers alternate article link over self link', () => {
  const xml = `<feed><title>Feed</title><entry><title>Story</title>
    <link rel="self" href="https://example.com/feed"/>
    <link type="application/atom+xml" href="https://example.com/story" rel="alternate"/>
    <updated>2026-07-17T10:00:00Z</updated></entry></feed>`;
  assert.equal(context.parseFeed(xml, 'https://example.com/feed')[0].url, 'https://example.com/story');
});

test('relative RSS media resolves against the final feed URL', () => {
  const xml = `<rss><channel><item><title>Story</title><link>/story</link>
    <enclosure url="../img/photo.jpg" type="image/jpeg"/></item></channel></rss>`;
  const item = context.parseFeed(xml, 'https://example.com/rss/feed.xml')[0];
  assert.equal(item.media[0].value, 'https://example.com/img/photo.jpg');
});

test('RSS items without GUIDs get distinct fallback cursors', () => {
  const xml = `<rss><channel><item><title>A</title><link>https://example.com/</link><pubDate>2026-07-16T10:00:00Z</pubDate></item>
    <item><title>B</title><link>https://example.com/</link><pubDate>2026-07-17T10:00:00Z</pubDate></item></channel></rss>`;
  const items = context.parseFeed(xml, 'https://example.com/rss');
  assert.notEqual(items[0].id, items[1].id);
});

test('RSS parser keeps a bounded burst larger than the old five-item window', () => {
  const entries = Array.from({ length: 20 }, (_, index) => `<item><title>Story ${index}</title><link>https://example.com/${index}</link><pubDate>2026-07-${String(1 + index).padStart(2, '0')}T10:00:00Z</pubDate></item>`).join('');
  const items = context.parseFeed(`<rss><channel>${entries}</channel></rss>`, 'https://example.com/feed');
  assert.equal(items.length, 20);
});

test('hashtag filters match whole normalized tokens', () => {
  assert.equal(context.passesSourceHashtagFilters({ exclude_tags: '#war', include_tags: '' }, 'award winners announced').ok, true);
  assert.equal(context.passesSourceHashtagFilters({ include_tags: '#iran', exclude_tags: '' }, 'Iranian officials spoke').ok, false);
  assert.equal(context.passesSourceHashtagFilters({ include_tags: '#iran', exclude_tags: '' }, 'Iran officials spoke').ok, true);
});

test('template token removal keeps other fields on the same line', () => {
  const out = context.removeTemplateLines('<b>{title}</b> — {date}\n{source}', ['{date}']);
  assert.match(out, /\{title\}/);
  assert.doesNotMatch(out, /\{date\}/);
});

test('special-use IPv6 addresses are rejected before fetch', () => {
  assert.equal(context.normalizePublicHttpUrl('http://[fec0::1]/'), '');
  assert.equal(context.normalizePublicHttpUrl('http://[ff02::1]/'), '');
});

test('expired users are excluded from automated SQL paths', () => {
  assert.match(source, /JOIN users u ON u\.telegram_id = s\.user_id[\s\S]*ACTIVE_LICENSE_SQL/);
  assert.match(source, /JOIN users u ON u\.telegram_id=d\.user_id/);
  assert.match(source, /EXISTS \(\s*SELECT 1 FROM users u WHERE u\.telegram_id=user_settings\.user_id/);
});

test('finalizeNewsStatus preserves skipped terminal state', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() { return /SELECT COUNT/.test(sql) ? { total: 1, pending: 0, published: 0, failed: 0, ambiguous: 0, filtered: 0, skipped: 1, rejected: 0, deleted: 0 } : null; },
            async run() { calls.push({ sql, args }); return { meta: { changes: 1 } }; },
          };
        },
      };
    },
  };
  const status = await context.finalizeNewsStatus(7, { DB });
  assert.equal(status, 'skipped');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'skipped');
});

test('digest scheduling does not query future queue reservations', async () => {
  let queried = 0;
  const DB = { prepare() { queried += 1; return { bind() { return { async first() { return null; } }; } }; } };
  const result = await context.computeDeliveryScheduleWithQueue('morning_digest', { timezone_offset_minutes: 210, quiet_start: '', quiet_end: '' }, { min_interval_minutes: 0 }, { id: 1, min_interval_minutes: 0 }, { DB }, new Date('2026-07-17T05:00:00Z'));
  assert.ok(result instanceof Date);
  assert.equal(queried, 0);
});

test('audio media uses Telegram sendAudio', async () => {
  let payload;
  context.fetch = async (_url, options) => { payload = JSON.parse(options.body); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); };
  const result = await context.sendMediaReference({ TELEGRAM_BOT_TOKEN: 'test-token' }, 1, '', { type: 'audio', value: 'file-id' });
  assert.equal(result.ok, true);
  assert.equal(payload.audio, 'file-id');
});

test('admin endpoint validation rejects short secrets and accepts Bearer', () => {
  const short = context.validateAdminRequest(new Request('https://example.com', { headers: { Authorization: 'Bearer short' } }), { ADMIN_SECRET: 'short' });
  assert.equal(short.status, 503);
  const secret = 'A'.repeat(32);
  const ok = context.validateAdminRequest(new Request('https://example.com', { headers: { Authorization: `Bearer ${secret}` } }), { ADMIN_SECRET: secret });
  assert.equal(ok.ok, true);
});

test('Telegram retry metadata is bounded and quiet-hour retries are shifted', () => {
  assert.equal(context.retryAfterSeconds({ parameters: { retry_after: 1200 } }), 1200);
  assert.equal(context.retryAfterSeconds({ parameters: { retry_after: 999999 } }), 86400);
  const shifted = context.adjustForQuietHours(new Date('2026-07-17T23:30:00Z'), '23:00', '07:00', 0);
  assert.equal(shifted.toISOString(), '2026-07-18T07:00:00.000Z');
});

test('webhook inbox is durable and stale claims are reclaimable', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS webhook_updates/);
  assert.match(source, /payload_json TEXT/);
  assert.match(source, /INSERT OR IGNORE INTO webhook_updates \(update_id, payload_json, claimed_at\)/);
  assert.match(source, /claimed_at IS NULL OR datetime\(claimed_at\) < datetime\('now','-5 minutes'\)/);
  assert.match(source, /async function recoverWebhookUpdates/);
});

test('send-time destination reservation defers overdue rows', async () => {
  const updates = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return { async run() { updates.push({ sql, args }); return { meta: { changes: 1 } }; } };
        },
      };
    },
  };
  const future = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const result = await context.reserveDestinationSlot({
    is_test: 0, dest_id: 5, delivery_id: 9, last_sent_at: future,
    source_min_interval: 0, dest_min_interval: 15, publication_mode: 'immediate',
  }, { quiet_start: '', quiet_end: '', timezone_offset_minutes: 0 }, { DB });
  assert.equal(result.deferred, true);
  assert.match(updates[0].sql, /UPDATE news_deliveries SET status='queued'/);
});

test('dismiss callbacks cannot delete already published deliveries', () => {
  assert.match(source, /status IN \('failed','ambiguous','filtered','skipped'\)/);
  assert.match(source, /status IN \('queued','processing','failed','ambiguous','filtered','skipped','rejected'\)/);
});

test('webhook rejects a body above the bounded limit', async () => {
  let called = false;
  const response = await context.__worker.fetch(new Request('https://example.com/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'x' },
    body: `{"update_id":1,"text":"${'x'.repeat(1024 * 1024)}"}`,
  }), { WEBHOOK_SECRET: 'x' }, { waitUntil() { called = true; } });
  assert.equal(response.status, 413);
  assert.equal(called, false);
});

let passed = 0;
const failures = [];
for (const item of tests) {
  try { await item.fn(); passed += 1; console.log(`PASS - ${item.name}`); }
  catch (error) { failures.push({ name: item.name, error: error?.stack || String(error) }); console.error(`FAIL - ${item.name}\n${error?.stack || error}`); }
}
console.log(`\nCODEX REGRESSION TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
