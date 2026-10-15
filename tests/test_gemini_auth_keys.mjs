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
const AQ1 = `AQ.${'a'.repeat(44)}`;
const AQ2 = `AQ.${'b'.repeat(44)}`;
const AIZA = `AIza${'c'.repeat(35)}`;

function interactionPayload(text = 'OK') {
  return new Response(JSON.stringify({
    id: 'interaction-test',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    usage: { total_input_tokens: 7, total_output_tokens: 3, total_tokens: 10 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('version is 2.10.3', () => assert.match(source, /2\.10\.3-faithful-always-on/));
test('AQ auth key is recognized', () => assert.equal(context.getGeminiKeyType(AQ1), 'auth'));
test('AIza key is recognized as standard', () => assert.equal(context.getGeminiKeyType(AIZA), 'standard'));
test('unknown long token is not mislabeled', () => assert.equal(context.getGeminiKeyType('x'.repeat(40)), 'unknown'));
test('AQ key defaults to Interactions API', () => assert.equal(context.getGeminiApiMode({}, AQ1), 'interactions'));
test('AIza key defaults to Interactions', () => assert.equal(context.getGeminiApiMode({}, AIZA), 'interactions'));
test('explicit Interactions mode overrides standard key', () => assert.equal(context.getGeminiApiMode({ GEMINI_API_MODE: 'interactions' }, AIZA), 'interactions'));
test('comma-separated AQ keys are parsed', () => assert.deepEqual(Array.from(context.parseGeminiApiKeyList(`${AQ1},${AQ2}`)), [AQ1, AQ2]));
test('GOOGLE_API_KEYS alias is supported', () => assert.deepEqual(Array.from(context.getGeminiApiKeys({ GOOGLE_API_KEYS: `${AQ1},${AQ2}` })), [AQ1, AQ2]));
test('GOOGLE_API_KEY and GEMINI_API_KEY deduplicate', () => assert.deepEqual(Array.from(context.getGeminiApiKeys({ GOOGLE_API_KEY: AQ1, GEMINI_API_KEY: AQ1 })), [AQ1]));

test('comma-separated keys in singular GEMINI_API_KEY are split', () => {
  assert.deepEqual(Array.from(context.getGeminiApiKeys({ GEMINI_API_KEY: `${AQ1},${AQ2}` })), [AQ1, AQ2]);
});

test('comma-separated keys in numbered variables are split', () => {
  assert.deepEqual(Array.from(context.getGeminiApiKeys({ GEMINI_API_KEY_1: `${AQ1},${AQ2}` })), [AQ1, AQ2]);
});

test('zero-width characters around AQ keys are removed', () => {
  assert.equal(context.normalizeGeminiApiKey(`\uFEFF${AQ1}\u200B`), AQ1);
  assert.equal(context.getGeminiKeyType(`\uFEFF${AQ1}\u200B`), 'auth');
});

test('unknown key format defaults to Interactions rather than models', () => {
  assert.equal(context.getGeminiApiMode({}, 'x'.repeat(40)), 'interactions');
});

test('Gemini thinking defaults to compatible low and accepts only high override', () => {
  assert.equal(context.getGeminiThinkingLevel({}), 'low');
  assert.equal(context.getGeminiThinkingLevel({ GEMINI_THINKING_LEVEL: 'high' }), 'high');
  assert.equal(context.getGeminiThinkingLevel({ GEMINI_THINKING_LEVEL: 'minimal' }), 'low');
  assert.equal(context.getGeminiThinkingLevel({ GEMINI_THINKING_LEVEL: 'unsupported' }), 'low');
  assert.equal(context.getGeminiThinkingLevel({ GEMINI_MODEL: 'gemini-2.5-flash-lite' }), '');
});

test('legacy Gemini 2.5 requests omit the Gemini 3 thinking_level field', async () => {
  let body;
  context.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return interactionPayload('legacy-compatible');
  };
  const out = await context.geminiGenerate('legacy model', {
    GEMINI_API_KEY: AQ1,
    GEMINI_MODEL: 'gemini-2.5-flash-lite',
  });
  assert.equal(out, 'legacy-compatible');
  assert.equal(body.generation_config.thinking_level, undefined);
});

test('AQ secret is redacted from arbitrary text', () => assert.equal(context.redactAiSecrets(`bad ${AQ1}`), 'bad [REDACTED]'));

test('AQ generation uses Interactions endpoint and x-goog-api-key', async () => {
  let seen;
  context.fetch = async (url, options) => {
    seen = { url: String(url), options, body: JSON.parse(options.body) };
    return interactionPayload('hello');
  };
  const out = await context.geminiGenerate('test prompt', { GEMINI_API_KEYS: AQ1, GEMINI_MODEL: 'gemini-3.1-flash-lite' });
  assert.equal(out, 'hello');
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(seen.options.headers['x-goog-api-key'], AQ1);
  assert.equal(seen.body.model, 'gemini-3.1-flash-lite');
  assert.equal(seen.body.input, 'test prompt');
  assert.equal(seen.body.store, false);
  assert.equal(seen.body.generation_config.max_output_tokens, 1000);
  assert.equal(seen.body.generation_config.thinking_level, 'low');
});

test('AQ JSON mode uses response_format and parses JSON', async () => {
  let body;
  context.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return interactionPayload('{"ok":true,"kind":"news"}');
  };
  const out = await context.geminiGenerate('classify', { GEMINI_API_KEY: AQ1 }, false, true);
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'news');
  assert.equal(body.response_format.type, 'text');
  assert.equal(body.response_format.mime_type, 'application/json');
});

test('AQ search mode uses Google Search tool', async () => {
  let body;
  context.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return interactionPayload('grounded');
  };
  const out = await context.geminiGenerate('latest', { GEMINI_API_KEY: AQ1 }, true, false);
  assert.equal(out, 'grounded');
  assert.deepEqual(JSON.parse(JSON.stringify(body.tools)), [{ type: 'google_search' }]);
});

test('Interactions output parser ignores thought steps', () => {
  const payload = {
    steps: [
      { type: 'thought', summary: { type: 'text', text: 'private thought' } },
      { type: 'model_output', content: [{ type: 'text', text: 'final ' }, { type: 'text', text: 'answer' }] },
    ],
    usage: { total_input_tokens: 12, total_output_tokens: 4 },
  };
  const parsed = context.parseGeminiResponsePayload(payload, 'interactions');
  assert.equal(parsed.output, 'final answer');
  assert.equal(parsed.promptTokens, 12);
  assert.equal(parsed.outputTokens, 4);
});

test('AQ key ignores forced legacy mode and stays on Interactions', async () => {
  let seenUrl = '';
  context.fetch = async (url) => { seenUrl = String(url); return interactionPayload('recovered'); };
  const out = await context.geminiGenerate('x', { GEMINI_API_KEY: AQ1, GEMINI_API_MODE: 'generateContent' });
  assert.equal(out, 'recovered');
  assert.equal(seenUrl, 'https://generativelanguage.googleapis.com/v1beta/interactions');
});

test('AQ health check performs a bounded Interactions probe with enough output budget', async () => {
  let seen;
  context.fetch = async (url, options) => {
    seen = { url: String(url), options, body: JSON.parse(options.body) };
    return interactionPayload('OK');
  };
  const out = await context.checkSingleAiKey('gemini', AQ1, 1, { GEMINI_MODEL: 'gemini-3.1-flash-lite' });
  assert.equal(out.ok, true);
  assert.equal(out.keyType, 'auth');
  assert.equal(out.endpointMode, 'interactions');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.body.generation_config.max_output_tokens, 256);
  assert.equal(seen.body.generation_config.thinking_level, 'low');
});

test('standard Gemini health check also uses Interactions', async () => {
  let seen;
  context.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return interactionPayload('OK');
  };
  const out = await context.checkSingleAiKey('gemini', AIZA, 1, { GEMINI_MODEL: 'gemini-2.5-flash-lite' });
  assert.equal(out.ok, true);
  assert.equal(out.keyType, 'standard');
  assert.equal(out.endpointMode, 'interactions');
  assert.equal(seen.options.method, 'POST');
});

test('legacy Gemini 2.5 health probe omits the Gemini 3 thinking_level field', async () => {
  let body;
  context.fetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return interactionPayload('OK');
  };
  const out = await context.checkSingleAiKey('gemini', AQ1, 1, { GEMINI_MODEL: 'gemini-2.5-flash-lite' });
  assert.equal(out.ok, true);
  assert.equal(body.generation_config.thinking_level, undefined);
});

test('empty Interactions probe reports response status and step types', async () => {
  context.fetch = async () => new Response(JSON.stringify({
    status: 'completed',
    steps: [{ type: 'thought', summary: { type: 'text', text: 'internal' } }],
  }), { status: 200 });
  const out = await context.checkSingleAiKey('gemini', AQ1, 1, { GEMINI_MODEL: 'gemini-3.1-flash-lite' });
  assert.equal(out.ok, false);
  assert.equal(out.status, 'empty_probe');
  assert.match(out.error, /status=completed/);
  assert.match(out.error, /steps=thought/);
});

test('AQ health failure never leaks key', async () => {
  context.fetch = async () => new Response(JSON.stringify({ error: { message: `invalid ${AQ1}` } }), { status: 401 });
  const out = await context.checkSingleAiKey('gemini', AQ1, 1, {});
  assert.equal(out.ok, false);
  assert.equal(out.error.includes(AQ1), false);
  assert.match(out.error, /REDACTED/);
});

test('AQ rotation proceeds to second key after 429', async () => {
  const seen = [];
  context.fetch = async (_url, options) => {
    seen.push(options.headers['x-goog-api-key']);
    if (seen.length === 1) return new Response('{"error":{"message":"quota"}}', { status: 429 });
    return interactionPayload('second-key');
  };
  const out = await context.geminiGenerate('rotate auth', { GEMINI_API_KEYS: `${AQ1},${AQ2}` });
  assert.equal(out, 'second-key');
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});

let passed = 0;
const failures = [];
for (const t of tests) {
  try { await t.fn(); passed += 1; console.log(`PASS - ${t.name}`); }
  catch (error) { failures.push({ name: t.name, error: error?.stack || String(error) }); console.error(`FAIL - ${t.name}\n${error?.stack || error}`); }
}
console.log(`\nGEMINI AUTH TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
