import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

let source = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const originalSource = source;
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

for (const name of [
  'registerSourcePollFailure', 'markSourcePollSuccess', 'showOwnerFaultySources',
  'showOwnerFaultySourceDetail', 'reactivateFaultySourceForOwner', 'deleteFaultySourceForOwner',
]) assert.equal(typeof context[name], 'function', `${name} must exist`);

assert.match(originalSource, /const SOURCE_AUTO_PAUSE_ERROR_THRESHOLD = 10;/, 'threshold must be 10 consecutive errors');
assert.match(originalSource, /auto_paused_at TEXT/);
assert.match(originalSource, /auto_paused_reason TEXT/);
assert.match(originalSource, /UPDATE sources SET active=0[\s\S]*WHERE error_count>=\?[\s\S]*last_error_at/,
  'existing actively failing sources above the threshold must be quarantined during migration');
assert.match(originalSource, /owner_faulty_sources/);
assert.match(originalSource, /owner_faulty_source_delete_confirm:/);
assert.match(originalSource, /owner_faulty_source_delete:/);
assert.match(originalSource, /owner_faulty_source_reactivate:/);
const state = {
  id: 54, user_id: '8192431691', active: 1, error_count: 9,
  auto_paused_at: null, auto_paused_reason: null,
};
const calls = [];
const env = {
  DB: {
    prepare(sql) {
      const text = String(sql);
      return {
        bind(...args) {
          calls.push({ sql: text, args });
          return {
            async run() {
              if (/UPDATE sources SET[\s\S]*error_count=error_count\+1/i.test(text)) {
                state.error_count += 1;
                if (state.error_count >= 10) {
                  state.active = 0;
                  state.auto_paused_at = '2026-07-20 18:00:00';
                  state.auto_paused_reason = String(args[0]);
                }
              }
              if (/error_count=0/i.test(text)) {
                state.error_count = 0;
                state.active = 1;
                state.auto_paused_at = null;
                state.auto_paused_reason = null;
              }
              return { meta: { changes: 1 } };
            },
            async first() {
              if (/SELECT id,user_id,active,error_count/i.test(text)) return { ...state };
              return null;
            },
          };
        },
      };
    },
  },
};

const failure = await context.registerSourcePollFailure(
  { ...state, title: 'DW RSS', type: 'rss' },
  new Error('در فید RSS آیتمی پیدا نشد'),
  '2026-07-20T18:05:00.000Z',
  '2026-07-20T18:01:00.000Z',
  env,
);
assert.equal(failure.errorCount, 10);
assert.equal(failure.autoPaused, true);
assert.equal(state.active, 0, 'source must be disabled on the tenth consecutive failure');
assert.ok(state.auto_paused_at);
assert.ok(calls.some((call) => /active=CASE WHEN error_count\+1>=\?/i.test(call.sql)));

await context.markSourcePollSuccess(54, '2026-07-20T18:10:00.000Z', '2026-07-20T18:01:00.000Z', env);
assert.equal(state.error_count, 0, 'a successful poll resets the consecutive failure count');
assert.equal(state.auto_paused_at, null);
assert.ok(calls.some((call) => /error_count=0/i.test(call.sql)));

assert.match(originalSource, /SELECT[\s\S]*FROM sources s[\s\S]*LEFT JOIN users u[\s\S]*s\.error_count>=\?/);
assert.match(originalSource, /deleteSourceForUser\(source\.id, source\.user_id, env\)/,
  'owner deletion must delete the source belonging to its actual user');
assert.match(originalSource, /resolveDiagnosticsByScope\(\{ sourceId: source\.id/,
  'deleting a faulty source must resolve its open diagnostics');

console.log('PASS owner faulty-source quarantine, review, reactivation, and confirmed deletion');
