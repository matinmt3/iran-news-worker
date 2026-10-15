import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

let source = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
source = source.replace('export default {', 'globalThis.__worker = {');
const context = {
  console: { log() {}, error() {}, warn() {} }, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams,
  Date, Intl, JSON, Math, RegExp, String, Number, Boolean, Array, Object, Set, Map, Promise, Error, TypeError,
  Uint8Array, Uint32Array, AbortController, Blob, FormData, Response, Request, Headers, ReadableStream,
  setTimeout, clearTimeout, fetch: async () => { throw new Error('unexpected fetch'); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'worker.js' });

let checks = 0;
function check(condition, message) { checks += 1; assert.ok(condition, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }

// Exhaustive Gregorian calendar validation for the supported years.
for (let year = 2000; year <= 2100; year++) {
  for (let month = 1; month <= 12; month++) {
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= maxDay; day++) {
      const input = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T12:34:56Z`;
      equal(context.normalizeNewsDate(input), `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}T12:34:56.000Z`, `valid date ${input}`);
    }
    equal(context.normalizeNewsDate(`${year}-${String(month).padStart(2,'0')}-${String(maxDay + 1).padStart(2,'0')}T00:00:00Z`), null, 'invalid day rejected');
  }
}

// Every minute of a day: equal start/end means quiet hours are disabled.
for (let minute = 0; minute < 1440; minute++) {
  const d = new Date(Date.UTC(2026, 6, 17, Math.floor(minute / 60), minute % 60));
  equal(context.adjustForQuietHours(d, '05:00', '05:00', 0).toISOString(), d.toISOString(), 'equal quiet window');
}

// Every minute against a normal and overnight window.
for (let minute = 0; minute < 1440; minute++) {
  const d = new Date(Date.UTC(2026, 6, 17, Math.floor(minute / 60), minute % 60));
  const normal = context.adjustForQuietHours(d, '01:00', '07:00', 0);
  if (minute >= 60 && minute < 420) equal(normal.getUTCHours() * 60 + normal.getUTCMinutes(), 420, 'normal quiet target');
  else equal(normal.toISOString(), d.toISOString(), 'normal quiet outside');
  const overnight = context.adjustForQuietHours(d, '23:00', '07:00', 0);
  if (minute >= 1380 || minute < 420) {
    equal(overnight.getUTCHours() * 60 + overnight.getUTCMinutes(), 420, 'overnight target');
    check(overnight > d, 'overnight target must be future');
  } else equal(overnight.toISOString(), d.toISOString(), 'overnight outside');
}

// Large deterministic fuzz/property pass over pure helpers.
let seed = 0x9e3779b9;
function rand() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; }
function randomText(length) {
  const chars = 'abcXYZ0123456789 <>/&\"\'_-.:;!?آبپتثجچحخدذرزژسشصضطظعغفقکگلمنوهی';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(rand() * chars.length)];
  return out;
}
for (let i = 0; i < 10000; i++) {
  const p = Math.floor(rand() * 21) - 8;
  const normalized = context.normalizeSourcePriority(p);
  check(normalized >= 1 && normalized <= 5, 'priority range');

  const text = randomText(Math.floor(rand() * 100));
  const escaped = context.escapeHtml(text);
  check(!escaped.includes('<'), 'escaped HTML has no raw <');
  check(!escaped.includes('>'), 'escaped HTML has no raw >');
  const truncated = context.truncatePlainText(text, 32);
  check(truncated.length <= 32, 'truncate length');
  equal(context.normalizeForDedupe(text), context.normalizeForDedupe(text).toLowerCase(), 'dedupe lowercase');

  const token = Math.floor(rand() * 0xffffffff).toString(36);
  equal(context.safeEqual(token, token), token.length > 0, 'safeEqual identity');
  if (token.length) equal(context.safeEqual(token, `${token}x`), false, 'safeEqual different length');
}

// Public URL normalization and private-address rejection at scale.
for (let i = 1; i <= 10000; i++) {
  const url = `https://news-${i}.example.com/path/${i}?a=${i}&b=x`;
  equal(context.normalizePublicHttpUrl(url), url, 'public URL stable');
}
for (let i = 1; i <= 254; i++) {
  equal(context.normalizePublicHttpUrl(`http://10.0.0.${i}/x`), '', '10/8 blocked');
  equal(context.normalizePublicHttpUrl(`http://192.168.1.${i}/x`), '', '192.168/16 blocked');
  equal(context.normalizePublicHttpUrl(`http://127.0.0.${i}/x`), '', 'loopback blocked');
  equal(context.normalizePublicHttpUrl(`http://169.254.1.${i}/x`), '', 'link local blocked');
}

// Telegram username boundary and normalization checks.
for (let len = 5; len <= 32; len++) {
  const name = `A${'b'.repeat(len - 1)}`;
  equal(context.extractTelegramUsername(`@${name}`), name.toLowerCase(), 'valid username');
  equal(context.extractTelegramUsername(`https://t.me/${name}`), name.toLowerCase(), 'valid Telegram URL');
}
for (let len = 0; len < 5; len++) equal(context.extractTelegramUsername(`@${'a'.repeat(len)}`), '', 'short username rejected');
for (let len = 33; len <= 80; len++) equal(context.extractTelegramUsername(`@${'a'.repeat(len)}`), '', 'long username rejected');

// Media deduplication remains bounded and stable under repeated inputs.
for (let i = 0; i < 1000; i++) {
  const list = [];
  for (let j = 0; j < 30; j++) list.push({ type: j % 2 ? 'photo' : 'video', value: `https://cdn.example.com/${j % 7}.${j % 2 ? 'jpg' : 'mp4'}`, source: 'url' });
  const out = context.normalizeMediaList(list);
  check(out.length <= 10, 'media list cap');
  equal(new Set(out.map(x => `${x.type}:${x.value}`)).size, out.length, 'media dedupe');
}

console.log(`STRESS/PROPERTY CHECKS: ${checks} | PASSED: ${checks} | FAILED: 0`);
