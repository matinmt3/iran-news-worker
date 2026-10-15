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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('private Telegram source replacement preserves the matched row and removes only exact duplicates', async () => {
  const calls = [];
  context.fetch = async (url) => {
    const method = String(url).split('/').pop();
    if (method === 'getChat') return jsonResponse({ ok: true, result: { id: -100222, type: 'channel', title: 'Private channel' } });
    if (method === 'getMe') return jsonResponse({ ok: true, result: { id: 999 } });
    if (method === 'getChatMember') return jsonResponse({ ok: true, result: { status: 'administrator', can_post_messages: true } });
    throw new Error(`unexpected Telegram method: ${method}`);
  };
  const DB = {
    prepare(sql) {
      const text = String(sql);
      return {
        bind(...args) {
          calls.push({ sql: text, args });
          return {
            async run() { return { meta: { changes: 1 } }; },
            async first() {
              if (/SELECT id FROM sources/i.test(text)) return { id: 7 };
              return null;
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };

  await context.saveTelegramSource('user-1', '-100222', { DB, TELEGRAM_BOT_TOKEN: 'test-token' });
  const updateCall = calls.find((call) => /UPDATE sources SET type='telegram'/i.test(call.sql));
  assert.ok(updateCall, 'the existing source row should be updated instead of deleted');
  assert.equal(updateCall.args.at(-2), 7);
  assert.equal(updateCall.args.at(-1), 'user-1');

  const deleteCall = calls.find((call) => /DELETE FROM sources/i.test(call.sql));
  assert.ok(deleteCall, 'duplicate source rows should be cleaned up');
  assert.match(deleteCall.sql, /user_id\s*=\s*\?/i);
  assert.match(deleteCall.sql, /id\s*<>\s*\?/i);
  assert.match(deleteCall.sql, /chat_id/i);
  assert.deepEqual(deleteCall.args, ['user-1', 7, '-100222']);
  assert.doesNotMatch(deleteCall.sql, /DELETE FROM sources WHERE user_id\s*=\s*\?\s+AND\s+type/i);
});

test('missing or inactive delivery destination is finalized as failed', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      const text = String(sql);
      return {
        bind(...args) {
          calls.push({ sql: text, args });
          return {
            async first() {
              if (/FROM news_deliveries d JOIN news_items/i.test(text)) return null;
              if (/SELECT\s+d\.news_id,\s*d\.user_id,\s*n\.is_test/i.test(text)) return { news_id: 10, user_id: 'user-1', is_test: 0 };
              if (/SELECT COUNT\(\*\) AS c/i.test(text)) return { c: 0 };
              return null;
            },
            async run() { return { meta: { changes: 1 } }; },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  const oldFinalize = context.finalizeNewsStatus;
  const oldMetric = context.incrementMetric;
  let finalized = 0;
  context.finalizeNewsStatus = async () => { finalized += 1; };
  context.incrementMetric = async () => {};
  try {
    const result = await context.publishOneDelivery(55, { DB });
    assert.equal(result, false);
    assert.ok(calls.some((call) => /UPDATE\s+news_deliveries[\s\S]*status='failed'/i.test(call.sql)));
    assert.equal(finalized, 1);
  } finally {
    context.finalizeNewsStatus = oldFinalize;
    context.incrementMetric = oldMetric;
  }
});

test('destination picker requests no destructive bot permission and requires the user to be able to promote it', () => {
  const bot = JSON.parse(JSON.stringify(context.requestedChannelAdminRights()));
  const user = JSON.parse(JSON.stringify(context.requestedUserChannelAdminRights()));
  assert.equal(bot.can_post_messages, true);
  assert.equal(bot.can_delete_messages, false);
  assert.equal(bot.can_edit_messages, false);
  assert.equal(bot.can_promote_members, false);
  assert.equal(bot.can_change_info, false);
  assert.equal(bot.can_restrict_members, false);
  assert.equal(user.can_post_messages, true);
  assert.equal(user.can_promote_members, true);
});

let passed = 0;
const failures = [];
for (const t of tests) {
  try { await t.fn(); passed += 1; console.log(`PASS - ${t.name}`); }
  catch (error) { failures.push({ name: t.name, error: error?.stack || String(error) }); console.error(`FAIL - ${t.name}\n${error?.stack || error}`); }
}
console.log(`\nAUDIT REGRESSIONS TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
