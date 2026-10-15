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
  'scheduledWorkPhaseForTime', 'selectSourcePollingBatch', 'runScheduledWorkPhase',
  'isCloudflareSubrequestLimitError', 'canSafelyDeferSubrequestLimit', 'readStoredSchemaVersion',
]) assert.equal(typeof context[name], 'function', `${name} must exist`);

assert.equal(context.scheduledWorkPhaseForTime(new Date('2026-07-20T18:00:00Z')), 'queue');
assert.equal(context.scheduledWorkPhaseForTime(new Date('2026-07-20T18:01:00Z')), 'source');
assert.equal(context.scheduledWorkPhaseForTime(new Date('2026-07-20T18:02:00Z')), 'queue');
assert.equal(context.scheduledWorkPhaseForTime(new Date('2026-07-20T18:03:00Z')), 'maintenance');

const parsed = [5, 4, 3, 2, 1].map((id) => ({ id: String(id) }));
const batch1 = context.selectSourcePollingBatch(parsed, null, 2, false);
assert.equal(JSON.stringify(Array.from(batch1.items, (item) => item.id)), JSON.stringify(['1','2']), 'oldest unseen items must be processed first');
assert.equal(batch1.checkpoint.id, '2');
assert.equal(batch1.remaining, 3);
const batch2 = context.selectSourcePollingBatch(parsed, '2', 2, false);
assert.equal(JSON.stringify(Array.from(batch2.items, (item) => item.id)), JSON.stringify(['3','4']));
assert.equal(batch2.checkpoint.id, '4');
assert.equal(batch2.remaining, 1);

assert.equal(context.isCloudflareSubrequestLimitError(new Error('Too many subrequests by single Worker invocation.')), true);
assert.equal(context.isCloudflareSubrequestLimitError(new Error('Bad Request: chat not found')), false);
assert.equal(context.canSafelyDeferSubrequestLimit(new Error('Too many subrequests by single Worker invocation.')), true);
const ambiguousBudgetError = new Error('Too many subrequests after Telegram write');
ambiguousBudgetError.deliveryAmbiguous = true;
assert.equal(context.canSafelyDeferSubrequestLimit(ambiguousBudgetError), false);

{
  let batches = 0;
  const versionMatch = originalSource.match(/const APP_SCHEMA_VERSION = (\d+);/);
  assert.ok(versionMatch);
  const expectedVersion = Number(versionMatch[1]);
  const env = { DB: {
    prepare(sql) {
      assert.match(String(sql), /app_schema_meta/i);
      return { async first() { return { schema_version: expectedVersion }; } };
    },
    async batch() { batches += 1; },
  } };
  const version = await context.readStoredSchemaVersion(env);
  assert.equal(version, expectedVersion);
  assert.equal(batches, 0, 'schema fast path must not run migration batches');
}


{
  const calls = [];
  const originals = {
    recoverStaleProcessing: context.recoverStaleProcessing,
    repairLegacyQueuedSchedules: context.repairLegacyQueuedSchedules,
    processDueNewsQueue: context.processDueNewsQueue,
    processAllPollingSources: context.processAllPollingSources,
  };
  context.recoverStaleProcessing = async () => { calls.push('recover'); return {}; };
  context.repairLegacyQueuedSchedules = async () => { calls.push('repair'); return {}; };
  context.processDueNewsQueue = async (_env, _user, _news, max) => { calls.push(`queue:${max}`); return {}; };
  context.processAllPollingSources = async () => { calls.push('source'); return {}; };
  try {
    await context.runScheduledWorkPhase('queue', {});
  } finally {
    Object.assign(context, originals);
  }
  assert.equal(calls.includes('source'), false, 'queue phase must not poll external sources');
  assert.ok(calls.some((value) => value.startsWith('queue:')));
}

{
  const calls = [];
  const originals = {
    processDueNewsQueue: context.processDueNewsQueue,
    processAllPollingSources: context.processAllPollingSources,
  };
  context.processDueNewsQueue = async () => { calls.push('queue'); return {}; };
  context.processAllPollingSources = async (_env, maxSources, _user, options) => {
    calls.push({ maxSources, options });
    return {};
  };
  try {
    await context.runScheduledWorkPhase('source', {});
  } finally {
    Object.assign(context, originals);
  }
  assert.equal(calls.includes('queue'), false, 'source phase must not publish deliveries');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].maxSources, 1);
  assert.equal(calls[0].options.itemLimit, 1);
  assert.equal(calls[0].options.deferDelivery, true);
}

assert.match(originalSource, /options\.deferDelivery/,
  'scheduled source ingestion must support queue-only ingestion');
assert.match(originalSource, /recoverWebhookUpdates\(env,\s*1\)/,
  'maintenance must recover only one potentially expensive webhook update per invocation');
assert.match(originalSource, /sendMessageWithAmbiguityGuard\(env,\s*destination\.chat_id/,
  'digest writes must use the same duplicate-prevention guard as ordinary news');
assert.match(originalSource, /telegramAccepted\s*\|\|\s*error\?\.deliveryAmbiguous/,
  'digest transport ambiguity must stop automatic retry');
assert.match(originalSource, /processAllPollingSources\(env,[^\n]+\{[^}]*itemLimit[^}]*deferDelivery:\s*true/s,
  'source cron phase must defer delivery and cap items');
assert.match(originalSource, /if\s*\(options\.deferDelivery\s*===\s*true[\s\S]{0,200}return\s*\{\s*sent:\s*false,\s*queued:\s*true/,
  'deferred ingestion must leave delivery for a later queue phase');
assert.match(originalSource, /CLOUDFLARE_SUBREQUEST_LIMIT/,
  'diagnostics must classify the Cloudflare subrequest limit');
assert.match(originalSource, /isCloudflareSubrequestLimitError\(error\)[\s\S]{0,1000}attempt_count=COALESCE\(attempt_count,0\)/,
  'platform-budget deferral must preserve the delivery attempt count');
assert.doesNotMatch(originalSource, /code='MEDIA_PARTIAL_FAILURE'[\s\S]{0,300}news_deliveries WHERE status='published'/,
  'published text must not hide an unresolved partial-media incident');
assert.match(originalSource, /stage='source_poll'[\s\S]{0,300}auto_paused_at IS NOT NULL/,
  'migration must resolve repetitive polling events for quarantined sources');

assert.match(originalSource, /conditions\s*=\s*\["status='open'",\s*"code<>'MEDIA_PARTIAL_FAILURE'"\]/,
  'terminal reconciliation must keep partial-media incidents reportable');

console.log('PASS bounded scheduled phases, lossless source batching, schema fast path, and subrequest retry protection');
