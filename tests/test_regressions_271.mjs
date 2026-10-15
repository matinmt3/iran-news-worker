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

test('strict ISO date rejects February 30', () => assert.equal(context.normalizeNewsDate('2026-02-30T10:00:00Z'), null));
test('strict ISO date rejects April 31', () => assert.equal(context.normalizeNewsDate('2026-04-31 10:00:00'), null));
test('strict ISO date accepts leap day', () => assert.equal(context.normalizeNewsDate('2024-02-29T10:00:00Z'), '2024-02-29T10:00:00.000Z'));
test('strict ISO date rejects non-leap day', () => assert.equal(context.normalizeNewsDate('2025-02-29T10:00:00Z'), null));
test('strict ISO date rejects invalid hour', () => assert.equal(context.normalizeNewsDate('2026-07-17T24:00:00Z'), null));
test('strict ISO date rejects invalid timezone', () => assert.equal(context.normalizeNewsDate('2026-07-17T10:00:00+24:00'), null));
test('negative epoch is rejected', () => assert.equal(context.normalizeNewsDate(-1), null));

test('maxRedirects zero rejects first redirect', async () => {
  let calls = 0;
  context.fetch = async () => { calls += 1; return new Response('', { status: 302, headers: { location: '/next' } }); };
  await assert.rejects(() => context.fetchPublicResource('https://example.com/start', {}, { maxRedirects: 0 }), /Too many redirects/i);
  assert.equal(calls, 1);
});

test('initDb concurrent calls never share request-bound D1 promises', async () => {
  vm.runInContext('dbInitialized = false', context);
  let batches = 0;
  const DB = {
    batch: async () => { batches += 1; await new Promise(r => setTimeout(r, 5)); return []; },
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return /^PRAGMA table_info/.test(sql) ? { results: [] } : { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
        async first() { return null; },
      };
    },
  };
  await Promise.all([context.initDb({ DB }), context.initDb({ DB }), context.initDb({ DB })]);
  assert.equal(batches, 3);
});

test('initDb caches only completed state and can retry a failure', async () => {
  vm.runInContext('dbInitialized = false', context);
  let batches = 0;
  const DB = {
    async batch() { batches += 1; if (batches === 1) throw new Error('temporary D1 error'); return []; },
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return /^PRAGMA table_info/.test(sql) ? { results: [] } : { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
        async first() { return null; },
      };
    },
  };
  await assert.rejects(() => context.initDb({ DB }), /temporary D1 error/);
  await context.initDb({ DB });
  assert.equal(batches, 2);
});

test('digest with only missing news fails permanently without sending', async () => {
  const batches = [];
  let sent = 0;
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() { return { meta: { changes: 1 } }; },
            async first() {
              if (/SELECT \* FROM destination_channels/.test(sql)) return { id: 5, chat_id: '-1005', show_source: 1, show_link: 1 };
              if (/SELECT \* FROM news_items/.test(sql)) return null;
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
    async batch(statements) { batches.push(statements); return []; },
  };
  const oldSettings = context.ensureSettings;
  const oldMetric = context.incrementMetric;
  const oldFinalize = context.finalizeNewsStatus;
  const oldSend = context.sendMessage;
  context.ensureSettings = async () => ({ show_source: 1, show_link: 1, show_footer: 0, footer_text: '' });
  context.incrementMetric = async () => {};
  context.finalizeNewsStatus = async () => {};
  context.sendMessage = async () => { sent += 1; return { ok: true }; };
  const result = await context.publishDigestDeliveries([{ id: 1, news_id: 99, user_id: '7', destination_id: 5, publication_mode: 'morning_digest', attempt_count: 0 }], { DB });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { published: 0, failed: 1 });
  assert.equal(sent, 0);
  assert.equal(batches.length, 1);
  context.ensureSettings = oldSettings;
  context.incrementMetric = oldMetric;
  context.finalizeNewsStatus = oldFinalize;
  context.sendMessage = oldSend;
});

let passed = 0;
const failures = [];
for (const t of tests) {
  try { await t.fn(); passed += 1; console.log(`PASS - ${t.name}`); }
  catch (error) { failures.push({ name: t.name, error: error?.stack || String(error) }); console.error(`FAIL - ${t.name}\n${error?.stack || error}`); }
}
console.log(`\nREGRESSION 2.9.0 TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
