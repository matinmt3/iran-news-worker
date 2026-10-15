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
const K1 = 'AIzaSy_TEST_KEY_111111111111111111111';
const K2 = 'AIzaSy_TEST_KEY_222222222222222222222';
const K3 = 'AIzaSy_TEST_KEY_333333333333333333333';

function successPayload(text = 'ok') {
  return new Response(JSON.stringify({
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 3, total_output_tokens: 2, total_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('default model is the stable 3.1 Flash-Lite', () => {
  assert.equal(context.getGeminiModel({}), 'gemini-3.1-flash-lite');
});

test('custom model may be configured safely', () => {
  assert.equal(context.getGeminiModel({ GEMINI_MODEL: 'gemini-3.1-flash-lite' }), 'gemini-3.1-flash-lite');
});

test('invalid custom model falls back to default', () => {
  assert.equal(context.getGeminiModel({ GEMINI_MODEL: '../../bad model' }), 'gemini-3.1-flash-lite');
});

test('JSON array API key secret is parsed', () => {
  assert.deepEqual(Array.from(context.parseGeminiApiKeyList(JSON.stringify([K1, K2]))), [K1, K2]);
});

test('newline and comma API key secret is parsed', () => {
  assert.deepEqual(Array.from(context.parseGeminiApiKeyList(`${K1}\n${K2},${K3}`)), [K1, K2, K3]);
});

test('key pool combines list, legacy key and numbered keys without duplicates', () => {
  const keys = Array.from(context.getGeminiApiKeys({
    GEMINI_API_KEYS: JSON.stringify([K1, K2]),
    GEMINI_API_KEY: K1,
    GEMINI_API_KEY_1: K3,
    GEMINI_API_KEY_2: K2,
  }));
  assert.deepEqual(keys, [K1, K2, K3]);
});

test('short and whitespace-containing keys are rejected', () => {
  assert.equal(context.normalizeGeminiApiKey('short'), '');
  assert.equal(context.normalizeGeminiApiKey('abc def ghi jkl mno pqr stu'), '');
});

test('Gemini request uses x-goog-api-key header and configured model', async () => {
  let seenUrl = '';
  let seenKey = '';
  context.fetch = async (url, options) => {
    seenUrl = String(url);
    seenKey = options.headers['x-goog-api-key'];
    return successPayload('hello');
  };
  const result = await context.geminiGenerate('test', { GEMINI_API_KEYS: K1, GEMINI_MODEL: 'gemini-2.5-flash-lite' });
  assert.equal(result, 'hello');
  assert.equal(seenUrl, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(seenKey, K1);
});

test('429 on one key automatically falls through to another key', async () => {
  const seen = [];
  context.fetch = async (_url, options) => {
    seen.push(options.headers['x-goog-api-key']);
    if (seen.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return successPayload('rotated');
  };
  const result = await context.geminiGenerate('rotate', { GEMINI_API_KEYS: JSON.stringify([K1, K2]) });
  assert.equal(result, 'rotated');
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});

test('temporary 5xx failure rotates to next key', async () => {
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('temporary', { status: 503 });
    return successPayload('recovered');
  };
  assert.equal(await context.geminiGenerate('retry', { GEMINI_API_KEYS: `${K1}\n${K2}` }), 'recovered');
  assert.equal(calls, 2);
});

test('explicit three-attempt cap rotates through three retryable keys', async () => {
  const seen = [];
  context.fetch = async (_url, options) => {
    seen.push(options.headers['x-goog-api-key']);
    if (seen.length === 1) return new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 });
    if (seen.length === 2) return new Response(JSON.stringify({ error: { message: 'temporary auth failure' } }), { status: 401 });
    return successPayload('third-key');
  };
  const result = await context.geminiGenerate('three keys', {
    GEMINI_API_KEYS: `${K1},${K2},${K3}`,
    AI_MAX_KEYS_PER_PROVIDER: '3',
  });
  assert.equal(result, 'third-key');
  assert.equal(seen.length, 3);
  assert.equal(new Set(seen).size, 3);
});

test('non-retryable 400 does not waste all keys', async () => {
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 });
  };
  await assert.rejects(() => context.geminiGenerate('bad', { GEMINI_API_KEYS: `${K1}\n${K2}` }), /HTTP 400/);
  assert.equal(calls, 1);
});

test('JSON mode parses structured response', async () => {
  context.fetch = async () => successPayload('{"publish":true,"title":"خبر"}');
  const result = await context.geminiGenerate('json', { GEMINI_API_KEY: K1 }, false, true);
  assert.equal(result.publish, true);
  assert.equal(result.title, 'خبر');
});

test('invalid JSON output rotates to another key', async () => {
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    if (calls === 1) return successPayload('not-json');
    return successPayload('{"ok":true}');
  };
  const result = await context.geminiGenerate('json retry', { GEMINI_API_KEYS: `${K1}\n${K2}` }, false, true);
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('all-key failure error never contains raw API keys', async () => {
  context.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 });
  let error;
  try { await context.geminiGenerate('fail', { GEMINI_API_KEYS: `${K1}\n${K2}` }); }
  catch (e) { error = e; }
  assert.ok(error);
  assert.match(error.message, /2 کلید/);
  assert.equal(error.message.includes(K1), false);
  assert.equal(error.message.includes(K2), false);
});

test('empty key pool produces clear configuration error', async () => {
  await assert.rejects(() => context.geminiGenerate('x', {}), /هیچ کلید Gemini تنظیم نشده/);
});

test('max output tokens defaults lower to reduce quota use', async () => {
  let payload;
  context.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return successPayload('ok');
  };
  await context.geminiGenerate('x', { GEMINI_API_KEY: K1 }, false, false);
  assert.equal(payload.generation_config.max_output_tokens, 1000);
  await context.geminiGenerate('x', { GEMINI_API_KEY: K1 }, false, true).catch(() => {});
  assert.equal(payload.generation_config.max_output_tokens, 1400);
});

test('custom output token cap is accepted within safe range', async () => {
  let payload;
  context.fetch = async (_url, options) => { payload = JSON.parse(options.body); return successPayload('ok'); };
  await context.geminiGenerate('x', { GEMINI_API_KEY: K1, GEMINI_MAX_OUTPUT_TOKENS: '700' });
  assert.equal(payload.generation_config.max_output_tokens, 700);
});

test('oversized prompt is capped before sending', async () => {
  let payload;
  context.fetch = async (_url, options) => { payload = JSON.parse(options.body); return successPayload('ok'); };
  await context.geminiGenerate('x'.repeat(40000), { GEMINI_API_KEY: K1 });
  assert.equal(payload.input.length, 30000);
});

let passed = 0;
const failures = [];
for (const t of tests) {
  try { await t.fn(); passed += 1; console.log(`PASS - ${t.name}`); }
  catch (error) { failures.push({ name: t.name, error: error?.stack || String(error) }); console.error(`FAIL - ${t.name}\n${error?.stack || error}`); }
}
console.log(`\nGEMINI POOL TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
