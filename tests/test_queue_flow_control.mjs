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

test('immediate scheduling uses actual successful send time, not future queued rows', async () => {
  let queries = 0;
  const DB = {
    prepare() {
      queries += 1;
      return { bind() { return { async first() { return { latest: '2026-07-21T20:00:00.000Z' }; } }; } };
    },
  };
  const now = new Date('2026-07-20T16:00:00.000Z');
  const result = await context.computeDeliveryScheduleWithQueue(
    'immediate',
    { timezone_offset_minutes: 210, quiet_start: '', quiet_end: '', min_interval_minutes: 0 },
    { min_interval_minutes: 0 },
    { id: 1, min_interval_minutes: 0, last_sent_at: null },
    { DB },
    now,
  );
  assert.equal(queries, 0, 'future queued rows must not push new items hours ahead');
  assert.equal(result.toISOString(), now.toISOString());
});

test('send-time lock never writes destination last_sent_at before Telegram success', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      const text = String(sql);
      return {
        bind(...args) {
          calls.push({ sql: text, args });
          return {
            async run() { return { meta: { changes: 1 } }; },
            async first() { return null; },
          };
        },
      };
    },
  };
  const result = await context.reserveDestinationSlot({
    is_test: 0, dest_id: 5, delivery_id: 9, last_sent_at: null,
    source_min_interval: 0, dest_min_interval: 0, publication_mode: 'immediate',
  }, { quiet_start: '', quiet_end: '', timezone_offset_minutes: 0 }, { DB });

  assert.equal(result.ok, true);
  assert.ok(result.lockToken, 'a transient destination lock must be acquired');
  assert.ok(calls.some((call) => /destination_send_locks/i.test(call.sql)), 'D1 destination lock must be used');
  assert.equal(calls.some((call) => /UPDATE\s+destination_channels\s+SET\s+last_sent_at/i.test(call.sql)), false,
    'last_sent_at is only allowed after Telegram accepts the message');
});

function queueDb(rows) {
  return {
    prepare(sql) {
      const text = String(sql);
      return {
        bind() {
          return {
            async all() { return /SELECT\s+d\.\*/i.test(text) ? { results: rows } : { results: [] }; },
            async run() { return { meta: { changes: 1 } }; },
            async first() { return null; },
          };
        },
      };
    },
  };
}

test('one successful publish per destination per queue run prevents bursts', async () => {
  const rows = [
    { id: 1, destination_id: 10, publication_mode: 'immediate' },
    { id: 2, destination_id: 10, publication_mode: 'immediate' },
    { id: 3, destination_id: 20, publication_mode: 'immediate' },
  ];
  const original = context.publishOneDelivery;
  const called = [];
  context.publishOneDelivery = async (id) => { called.push(id); return true; };
  try {
    await context.processDueNewsQueue({ DB: queueDb(rows) });
  } finally {
    context.publishOneDelivery = original;
  }
  assert.deepEqual(called, [1, 3]);
});

test('a failed news item does not block the next news for the same destination', async () => {
  const rows = [
    { id: 1, destination_id: 10, publication_mode: 'immediate' },
    { id: 2, destination_id: 10, publication_mode: 'immediate' },
  ];
  const original = context.publishOneDelivery;
  const called = [];
  context.publishOneDelivery = async (id) => { called.push(id); return id === 2; };
  try {
    await context.processDueNewsQueue({ DB: queueDb(rows) });
  } finally {
    context.publishOneDelivery = original;
  }
  assert.deepEqual(called, [1, 2]);
});

test('destination send lock schema is migrated in D1', () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS destination_send_locks/);
  assert.match(source, /destination_id INTEGER PRIMARY KEY/);
  assert.match(source, /lock_token TEXT NOT NULL/);
  assert.match(source, /acquireDestinationSendLock\(row\.dest_id, env, 600\)/);
});

test('Telegram retry_after keeps only the affected destination paused', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      const text = String(sql);
      return {
        bind(...args) {
          calls.push({ sql: text, args });
          return { async run() { return { meta: { changes: 1 } }; } };
        },
      };
    },
  };
  await context.releaseDestinationSendLock(5, 'lock-token', { DB }, 180);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE destination_send_locks SET locked_until=datetime\('now', \?\)/);
  assert.deepEqual(calls[0].args, ['+180 seconds', 5, 'lock-token']);
});

test('legacy future queue chains are recalculated from successful send state', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      const text = String(sql);
      return {
        bind(...args) {
          calls.push({ sql: text, args });
          return {
            async all() {
              if (/FROM news_deliveries d/i.test(text)) return { results: [{
                id: 91,
                scheduled_at: '2099-01-01T00:00:00.000Z',
                publication_mode: 'immediate',
                source_min_interval: 0,
                dest_id: 5,
                dest_min_interval: 0,
                last_sent_at: null,
                settings_min_interval: 0,
                quiet_start: '', quiet_end: '', timezone_offset_minutes: 210,
              }] };
              return { results: [] };
            },
            async run() { return { meta: { changes: 1 } }; },
          };
        },
      };
    },
  };
  const result = await context.repairLegacyQueuedSchedules({ DB }, 50);
  assert.equal(result.repaired, 1);
  const update = calls.find((call) => /UPDATE news_deliveries SET scheduled_at=\?/i.test(call.sql));
  assert.ok(update);
  assert.ok(Date.parse(update.args[0]) < Date.parse('2099-01-01T00:00:00.000Z'));
});

let passed = 0;
const failures = [];
for (const item of tests) {
  try { await item.fn(); passed += 1; console.log(`PASS - ${item.name}`); }
  catch (error) { failures.push({ name: item.name, error: error?.stack || String(error) }); console.error(`FAIL - ${item.name}\n${error?.stack || error}`); }
}
console.log(`\nQUEUE FLOW CONTROL TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
