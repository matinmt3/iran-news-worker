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

assert.equal(typeof context.canonicalizeNewsUrl, 'function', 'canonicalizeNewsUrl must exist');
assert.equal(typeof context.buildDestinationDedupeCandidate, 'function', 'destination candidate builder must exist');
assert.equal(typeof context.findDestinationDuplicate, 'function', 'destination-scoped duplicate lookup must exist');
assert.equal(typeof context.buildIngestionFingerprints, 'function', 'source-scoped ingestion fingerprint builder must exist');

assert.equal(
  context.canonicalizeNewsUrl('HTTPS://Example.COM/news/42/?utm_source=telegram&utm_medium=social#part'),
  'https://example.com/news/42',
  'tracking parameters, fragment and trailing slash must be removed',
);
assert.equal(
  context.canonicalizeNewsUrl('https://example.com/news?id=42&fbclid=abc&ref=telegram'),
  'https://example.com/news?id=42',
  'real query identifiers must be preserved while tracking parameters are removed',
);

const item = { id: 'post-10', title: 'خبر مهم درباره بازار ارز', body: 'قیمت ارز امروز در بازار کاهش پیدا کرد', url: 'https://example.com/n/10' };
const one = await context.buildIngestionFingerprints({ id: 1 }, item, [], false);
const two = await context.buildIngestionFingerprints({ id: 2 }, item, [], false);
assert.notEqual(one.ingestionFingerprint, two.ingestionFingerprint, 'same story from different sources must not collide at ingestion');
assert.equal(one.contentFingerprint, two.contentFingerprint, 'destination comparison fingerprint must remain source-independent');

class HistoryStatement {
  constructor(sql, rowsByDestination) { this.sql = sql; this.rowsByDestination = rowsByDestination; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async all() {
    const destinationId = Number(this.args[1] ?? this.args[0]);
    return { results: this.rowsByDestination.get(destinationId) || [] };
  }
  async first() { return null; }
  async run() { return { meta: { changes: 1 } }; }
}
const exactCandidate = await context.buildDestinationDedupeCandidate({
  user_id: '100', source_id: 7, external_id: 'source-55', title: 'حمله موشکی به اطراف آبادان',
  body: 'یک نقطه در اطراف آبادان هدف حمله موشکی قرار گرفت و گزارشی از مجروحان منتشر نشد.',
  url: 'https://isna.ir/news/55?utm_source=tg', dedupe_text: '', content_fingerprint: '',
});
const rowsByDestination = new Map([
  [1, [{ id: 9, source_id: 99, source_external_id: 'other', canonical_url: 'https://isna.ir/news/55',
    exact_fingerprint: exactCandidate.contentFingerprint, title: exactCandidate.title,
    dedupe_text: exactCandidate.dedupeText, posted_at: new Date().toISOString() }]],
  [2, []],
]);
const env = { DB: { prepare: (sql) => new HistoryStatement(sql, rowsByDestination) } };
const exactMatch = await context.findDestinationDuplicate('100', 1, exactCandidate, { ai_dedupe: 0 }, env);
assert.ok(exactMatch, 'same canonical URL already in this destination must be duplicate');
assert.match(exactMatch.reason, /لینک|دقیق/i);
const otherDestination = await context.findDestinationDuplicate('100', 2, exactCandidate, { ai_dedupe: 0 }, env);
assert.equal(otherDestination, null, 'history from destination 1 must never suppress destination 2');

const similarCandidate = await context.buildDestinationDedupeCandidate({
  user_id: '100', source_id: 8, external_id: 'new-source-id', title: 'حمله موشکی در اطراف شهر آبادان',
  body: 'در اطراف آبادان یک نقطه هدف حمله موشکی قرار گرفت. این حمله مجروحی نداشت.',
  url: 'https://another.example/story/900',
});
const similarityRows = new Map([[1, [{ id: 10, source_id: 7, source_external_id: 'old', canonical_url: '',
  exact_fingerprint: '', title: 'حمله موشکی به اطراف آبادان',
  dedupe_text: exactCandidate.dedupeText, posted_at: new Date().toISOString() }]]]);
const similarityEnv = { DB: { prepare: (sql) => new HistoryStatement(sql, similarityRows) } };
const semanticMatch = await context.findDestinationDuplicate('100', 1, similarCandidate, { ai_dedupe: 0 }, similarityEnv);
assert.ok(semanticMatch, 'strongly similar wording for the same event in the same destination must be duplicate');

const unrelatedCandidate = await context.buildDestinationDedupeCandidate({
  user_id: '100', source_id: 9, external_id: 'different', title: 'نتایج مسابقات فوتبال اروپا',
  body: 'تیم میزبان با دو گل پیروز شد و به مرحله بعد رفت.', url: 'https://sports.example/1',
});
const unrelated = await context.findDestinationDuplicate('100', 1, unrelatedCandidate, { ai_dedupe: 0 }, similarityEnv);
assert.equal(unrelated, null, 'unrelated news must not be suppressed just because some words are common');


const observedLog = [];
class ObservedStmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async all() {
    if (/FROM destination_channels/i.test(this.sql)) {
      return { results: [{ id: 31, user_id: '100', chat_id: '-10031', username: 'dest' }] };
    }
    return { results: [] };
  }
  async run() { observedLog.push({ sql: this.sql, args: this.args }); return { meta: { changes: 1 } }; }
}
const observedEnv = {
  DB: {
    prepare: (sql) => new ObservedStmt(sql),
    batch: async (statements) => Promise.all(statements.map((statement) => statement.run())),
  },
};
const observedCount = await context.recordObservedDestinationPosts({
  message_id: 808,
  date: 1784462400,
  chat: { id: -10031, username: 'dest', title: 'Destination' },
  text: 'خبر دستی درباره بازار ارز\nجزئیات کامل',
  entities: [{ type: 'text_link', offset: 0, length: 4, url: 'https://news.example/item/88?utm_source=telegram' }],
}, observedEnv);
assert.equal(observedCount, 1, 'manual destination posts must be indexed even when they are not configured as a source');
const observedInsert = observedLog.find((entry) => /INSERT OR IGNORE INTO destination_post_history/i.test(entry.sql));
assert.ok(observedInsert, 'manual channel post must create a destination history row');
assert.ok(observedInsert.args.includes('https://news.example/item/88'), 'manual post source link must be canonicalized in history');
assert.ok(observedInsert.args.includes('808'), 'Telegram destination message ID must be stored');

const statement = context.recordPublishedDestinationHistory({ DB: { prepare: (sql) => new ObservedStmt(sql) } }, {
  user_id: '100', dest_id: 31, chat_id: '-10031', news_id: 501,
}, exactCandidate, [909], 'bot');
assert.match(statement.sql, /destination_post_history/i);
assert.ok(statement.args.includes(501));
assert.ok(statement.args.includes('909'));

assert.match(originalSource, /CREATE TABLE IF NOT EXISTS destination_post_history/, 'destination history table must be created');
assert.match(originalSource, /await recordObservedDestinationPosts\(post, env\)/, 'channel posts must be observed before source-only routing');
assert.match(originalSource, /findDestinationDuplicate\(row\.user_id, row\.dest_id/, 'single delivery must check only its destination history');
assert.match(originalSource, /recordPublishedDestinationHistory/, 'successful publications must be recorded in destination history');
assert.doesNotMatch(originalSource, /findAdvancedDuplicate\(userId, fingerprint, dedupeText, item, settings, env\)/, 'global user-wide semantic dedupe must not run during ingestion');

console.log('PASS destination-scoped dedupe behavior');
