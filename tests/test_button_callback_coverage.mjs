import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');

function generatedCallbacks(code) {
  const out = [];
  const rx = /callback_data\s*:\s*([`"'])(.*?)(?<!\\)\1/gs;
  let m;
  while ((m = rx.exec(code))) out.push(m[2]);
  return out;
}

function exactHandlers(code) {
  const out = new Set();
  for (const rx of [/case\s+["']([^"']+)["']\s*:/g, /data\s*===\s*["']([^"']+)["']/g]) {
    let m;
    while ((m = rx.exec(code))) out.add(m[1]);
  }
  return out;
}

function prefixHandlers(code) {
  const out = new Set();
  const rx = /data\.startsWith\(["']([^"']+)["']\)/g;
  let m;
  while ((m = rx.exec(code))) out.add(m[1]);
  return out;
}

const generated = generatedCallbacks(source);
const exact = exactHandlers(source);
const prefixes = prefixHandlers(source);

function isHandled(value) {
  if (!value.includes('${')) return exact.has(value) || [...prefixes].some((p) => value.startsWith(p));
  const literalPrefix = value.split('${', 1)[0];
  return [...prefixes].some((p) => literalPrefix.startsWith(p) || p.startsWith(literalPrefix));
}

const unhandled = [...new Set(generated.filter((value) => !isHandled(value)))].sort();
assert.deepEqual(unhandled, [], `Unhandled generated callbacks:\n${unhandled.join('\n')}`);

for (const value of generated) {
  // Telegram callback_data is limited to 64 bytes. Substitute realistic numeric IDs.
  const concrete = value
    .replaceAll('${prefix}', 'source:123')
    .replace(/\$\{[^}]+\}/g, '123');
  assert.ok(Buffer.byteLength(concrete, 'utf8') <= 64, `callback_data exceeds Telegram 64-byte limit: ${concrete}`);
}

assert.match(source, /callback_data:\s*["']owner_live_selftest["']/, 'owner panel must expose live self-test button');
assert.ok(exact.has('owner_live_selftest'), 'owner_live_selftest must have an exact callback handler');

console.log(`PASS callback coverage: ${new Set(generated).size} unique generated callbacks; 0 orphaned`);
