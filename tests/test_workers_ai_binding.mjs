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
const G1 = 'gsk_TEST_KEY_111111111111111111111111';
const M1 = 'AIzaSy_TEST_KEY_111111111111111111111';

function aiBinding(run) {
  return { run };
}

test('default Workers AI model is current multilingual GLM Flash', () => {
  assert.equal(context.getCloudflareAiModel({}), '@cf/zai-org/glm-4.7-flash');
});

test('safe custom Workers AI model is accepted and unsafe value is rejected', () => {
  assert.equal(context.getCloudflareAiModel({ CLOUDFLARE_AI_MODEL: '@cf/openai/gpt-oss-20b' }), '@cf/openai/gpt-oss-20b');
  assert.equal(context.getCloudflareAiModel({ CLOUDFLARE_AI_MODEL: '../../bad model' }), '@cf/zai-org/glm-4.7-flash');
});

test('Workers AI binding is available without API keys', () => {
  const env = { AI: aiBinding(async () => ({ response: 'ok' })) };
  assert.equal(context.hasWorkersAiBinding(env), true);
  assert.deepEqual(Array.from(context.getAiProviderOrder(env)), ['cloudflare']);
});

test('configured provider order accepts cloudflare aliases', () => {
  const env = { AI: aiBinding(async () => ({})), GROQ_API_KEY: G1, GEMINI_API_KEY: M1, AI_PROVIDER_ORDER: 'cf,gemini,workers-ai,groq' };
  assert.deepEqual(Array.from(context.getAiProviderOrder(env)), ['cloudflare', 'gemini', 'groq']);
});

test('Workers AI generation uses env.AI.run with messages and parses chat completion output', async () => {
  let seen;
  const env = {
    AI: aiBinding(async (model, input) => {
      seen = { model, input };
      return { choices: [{ message: { content: 'پاسخ کلادفلر' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } };
    }),
  };
  const out = await context.cloudflareAiGenerate('خبر را خلاصه کن', env);
  assert.equal(out, 'پاسخ کلادفلر');
  assert.equal(seen.model, '@cf/zai-org/glm-4.7-flash');
  assert.equal(seen.input.messages[0].role, 'system');
  assert.equal(seen.input.messages[1].content, 'خبر را خلاصه کن');
  assert.equal(seen.input.stream, false);
  assert.equal(seen.input.chat_template_kwargs.enable_thinking, false);
  assert.equal(seen.input.chat_template_kwargs.clear_thinking, true);
});

test('Workers AI content-parts response shape is parsed', async () => {
  const env = { AI: aiBinding(async () => ({
    choices: [{ message: { content: [{ type: 'text', text: 'پاسخ چندبخشی' }] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
  })) };
  assert.equal(await context.cloudflareAiGenerate('x', env), 'پاسخ چندبخشی');
});

test('Workers AI native response shape is parsed', async () => {
  const env = { AI: aiBinding(async () => ({ response: 'native-ok', usage: { prompt_tokens: 1, completion_tokens: 1 } })) };
  assert.equal(await context.cloudflareAiGenerate('x', env), 'native-ok');
});

test('Workers AI JSON mode requests json_object and validates output', async () => {
  let input;
  const env = { AI: aiBinding(async (_model, body) => {
    input = body;
    return { choices: [{ message: { content: '{"publish":true}' } }], usage: {} };
  }) };
  const out = await context.cloudflareAiGenerate('json', env, false, true);
  assert.equal(out.publish, true);
  assert.equal(input.response_format.type, 'json_object');
});

test('aiGenerate falls back to Workers AI after Groq and Gemini failures', async () => {
  context.fetch = async (url) => {
    if (String(url).includes('api.groq.com')) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 });
    return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 });
  };
  const env = {
    GROQ_API_KEY: G1,
    GEMINI_API_KEY: M1,
    AI_PROVIDER_ORDER: 'groq,gemini,cloudflare',
    AI: aiBinding(async () => ({ response: 'cf-ok', usage: {} })),
  };
  assert.equal(await context.aiGenerate('fallback', env), 'cf-ok');
});

test('aiGenerate advances to the next provider when a valid JSON response fails fidelity validation', async () => {
  const originals = {
    gemini: context.geminiGenerate,
    cloudflare: context.cloudflareAiGenerate,
    groq: context.groqGenerate,
  };
  const calls = [];
  try {
    context.geminiGenerate = async () => { calls.push('gemini'); return { translated_text: 'ساختگی' }; };
    context.cloudflareAiGenerate = async () => { calls.push('cloudflare'); return { translated_text: 'ترجمه دقیق', good: true }; };
    context.groqGenerate = async () => { calls.push('groq'); return { translated_text: 'نباید فراخوانی شود' }; };
    const env = {
      GEMINI_API_KEY: M1,
      GROQ_API_KEY: G1,
      AI_PROVIDER_ORDER: 'gemini,cloudflare,groq',
      AI: aiBinding(async () => ({})),
    };
    const result = await context.aiGenerate('translate', env, false, true, null, {
      validateResult: (candidate) => ({ ok: candidate.good === true, reasons: candidate.good ? [] : ['new_context_claim'] }),
    });
    assert.equal(result._ai_provider, 'cloudflare');
    assert.equal(result.translated_text, 'ترجمه دقیق');
    assert.deepEqual(calls, ['gemini', 'cloudflare']);
  } finally {
    context.geminiGenerate = originals.gemini;
    context.cloudflareAiGenerate = originals.cloudflare;
    context.groqGenerate = originals.groq;
  }
});

test('singular and numbered Groq variables accept multiple comma-separated keys', () => {
  const G2 = 'gsk_TEST_KEY_222222222222222222222222';
  const G3 = 'gsk_TEST_KEY_333333333333333333333333';
  assert.deepEqual(Array.from(context.getGroqApiKeys({ GROQ_API_KEY: `${G1},${G2}`, GROQ_API_KEY_1: G3 })), [G1, G2, G3]);
});

test('Workers AI health check uses the configured binding and model', async () => {
  let called = 0;
  const env = { AI: aiBinding(async (model, input) => {
    called += 1;
    assert.equal(model, '@cf/zai-org/glm-4.7-flash');
    assert.ok(Array.isArray(input.messages));
    assert.equal(input.chat_template_kwargs.enable_thinking, false);
    assert.equal(input.chat_template_kwargs.clear_thinking, true);
    return { response: 'OK', usage: {} };
  }) };
  const result = await context.checkWorkersAiBinding(env);
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'cloudflare');
  assert.equal(called, 1);
});

test('empty GLM response reports finish reason and reasoning-token diagnostics', async () => {
  const env = { AI: aiBinding(async () => ({
    choices: [{ message: { content: null }, finish_reason: 'length' }],
    usage: { prompt_tokens: 5, completion_tokens: 32, completion_tokens_details: { reasoning_tokens: 32 } },
  })) };
  await assert.rejects(
    () => context.cloudflareAiGenerate('x', env),
    /finish_reason=length.*reasoning_tokens=32|reasoning_tokens=32.*finish_reason=length/,
  );
});

test('missing binding produces a clear configuration error', async () => {
  await assert.rejects(() => context.cloudflareAiGenerate('x', {}), /Workers AI|binding|AI/);
});

test('health-check collection includes Workers AI without external keys', async () => {
  const env = { AI: aiBinding(async () => ({ response: 'OK', usage: {} })) };
  const results = await context.runAiApiHealthChecks(env);
  assert.equal(results.length, 1);
  assert.equal(results[0].provider, 'cloudflare');
  assert.equal(results[0].ok, true);
});

test('D1 analytics schema and migration include cloudflare_calls', () => {
  assert.match(source, /cloudflare_calls INTEGER NOT NULL DEFAULT 0/);
  assert.match(source, /\["cloudflare_calls", "cloudflare_calls INTEGER NOT NULL DEFAULT 0"\]/);
  assert.match(source, /cloudflare:\s*"cloudflare_calls"/);
});

test('Wrangler example declares the AI binding and Cloudflare model', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc.example', import.meta.url), 'utf8'));
  assert.equal(config.ai.binding, 'AI');
  assert.equal(config.vars.CLOUDFLARE_AI_MODEL, '@cf/zai-org/glm-4.7-flash');
  assert.match(config.vars.AI_PROVIDER_ORDER, /cloudflare/);
});

let passed = 0;
const failures = [];
for (const t of tests) {
  try { await t.fn(); passed += 1; console.log(`PASS - ${t.name}`); }
  catch (error) { failures.push({ name: t.name, error: error?.stack || String(error) }); console.error(`FAIL - ${t.name}\n${error?.stack || error}`); }
}
console.log(`\nWORKERS AI BINDING TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
