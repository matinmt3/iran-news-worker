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
const G2 = 'gsk_TEST_KEY_222222222222222222222222';
const M1 = 'AIzaSy_TEST_KEY_111111111111111111111';

// Static/provider configuration.
test('version is 2.10.3', () => assert.match(source, /2\.10\.3-faithful-always-on/));
test('default Groq model is cost efficient GPT-OSS 20B', () => assert.equal(context.getGroqModel({}), 'openai/gpt-oss-20b'));
test('safe custom Groq model accepted', () => assert.equal(context.getGroqModel({ GROQ_MODEL: 'openai/gpt-oss-120b' }), 'openai/gpt-oss-120b'));
test('unsafe Groq model rejected', () => assert.equal(context.getGroqModel({ GROQ_MODEL: '../../bad model' }), 'openai/gpt-oss-20b'));
test('auto provider order prefers Gemini then Groq when Workers AI is unavailable', () => assert.deepEqual(Array.from(context.getAiProviderOrder({ GROQ_API_KEY: G1, GEMINI_API_KEY: M1 })), ['gemini', 'groq']));
test('configured provider order is honored', () => assert.deepEqual(Array.from(context.getAiProviderOrder({ AI_PROVIDER_ORDER: 'gemini,groq', GROQ_API_KEY: G1, GEMINI_API_KEY: M1 })), ['gemini', 'groq']));
test('unconfigured providers are omitted', () => assert.deepEqual(Array.from(context.getAiProviderOrder({ AI_PROVIDER_ORDER: 'groq,gemini', GEMINI_API_KEY: M1 })), ['gemini']));
test('per-provider AI attempt cap leaves Free-plan subrequest headroom', () => {
  assert.equal(context.maxAiKeyAttemptsPerProvider({}), 2);
  assert.equal(context.maxAiKeyAttemptsPerProvider({ AI_MAX_KEYS_PER_PROVIDER: '3' }), 3);
});

// 120 key-pool tests.
for (let i = 1; i <= 40; i++) {
  const key = `gsk_generated_${String(i).padStart(3, '0')}_${'x'.repeat(24)}`;
  test(`Groq key normalization ${i}`, () => assert.equal(context.normalizeGroqApiKey(` "${key}" `), key));
}
for (let i = 1; i <= 40; i++) {
  const keyA = `gsk_a_${i}_${'a'.repeat(24)}`;
  const keyB = `gsk_b_${i}_${'b'.repeat(24)}`;
  test(`Groq comma/newline parsing ${i}`, () => assert.deepEqual(Array.from(context.parseGroqApiKeyList(`${keyA},\n${keyB}`)), [keyA, keyB]));
}
for (let i = 1; i <= 40; i++) {
  const key = `gsk_dedupe_${i}_${'d'.repeat(24)}`;
  test(`Groq pool deduplicates ${i}`, () => assert.deepEqual(Array.from(context.getGroqApiKeys({ GROQ_API_KEYS: JSON.stringify([key, key]), GROQ_API_KEY_1: key })), [key]));
}

// Groq request, rotation, JSON and provider fallback.
test('Groq request uses Bearer auth and official chat-completions endpoint', async () => {
  let seen;
  context.fetch = async (url, options) => {
    seen = { url: String(url), options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'hello' } }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  assert.equal(await context.groqGenerate('test', { GROQ_API_KEY: G1 }), 'hello');
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(seen.options.headers.Authorization, `Bearer ${G1}`);
  assert.equal(seen.body.model, 'openai/gpt-oss-20b');
  assert.ok(Number.isInteger(seen.body.max_completion_tokens));
  assert.equal('max_tokens' in seen.body, false);
  assert.equal(seen.body.reasoning_effort, 'low');
  assert.equal(seen.body.include_reasoning, false);
  assert.equal('reasoning_format' in seen.body, false);
});
test('Groq JSON mode requests json_object and parses it', async () => {
  let payload;
  context.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"publish":true}' } }], usage: {} }), { status: 200 });
  };
  const out = await context.groqGenerate('json', { GROQ_API_KEY: G1 }, false, true);
  assert.equal(out.publish, true);
  assert.equal(payload.response_format.type, 'json_object');
});
test('Groq rotates on 429', async () => {
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 });
  };
  assert.equal(await context.groqGenerate('rotate', { GROQ_API_KEYS: `${G1}\n${G2}` }), 'ok');
  assert.equal(calls, 2);
});
test('Groq errors do not leak keys', async () => {
  context.fetch = async () => new Response(JSON.stringify({ error: { message: 'quota' } }), { status: 429 });
  let error;
  try { await context.groqGenerate('x', { GROQ_API_KEYS: `${G1}\n${G2}` }); } catch (e) { error = e; }
  assert.ok(error);
  assert.equal(error.message.includes(G1), false);
  assert.equal(error.message.includes(G2), false);
});
test('Groq redacts a key echoed by the provider error', async () => {
  context.fetch = async () => new Response(JSON.stringify({ error: { message: `invalid key ${G1}` } }), { status: 401 });
  let error;
  try { await context.groqGenerate('x', { GROQ_API_KEY: G1 }); } catch (e) { error = e; }
  assert.ok(error);
  assert.equal(error.message.includes(G1), false);
  assert.match(error.message, /REDACTED/);
});
test('aiGenerate falls back from Groq failure to Gemini', async () => {
  context.fetch = async (url) => {
    if (String(url).includes('api.groq.com')) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 });
    return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'gemini-ok' }] }], usage: {} }), { status: 200 });
  };
  const out = await context.aiGenerate('fallback', { GROQ_API_KEY: G1, GEMINI_API_KEY: M1, AI_PROVIDER_ORDER: 'groq,gemini' });
  assert.equal(out, 'gemini-ok');
});

// Categories: all masks, aliases and labels.
const categoryIds = ['war_security', 'economy', 'schools', 'major_events'];
for (let mask = 1; mask < 16; mask++) {
  const selected = categoryIds.filter((_, index) => mask & (1 << index));
  test(`category JSON normalization mask ${mask}`, () => assert.deepEqual(Array.from(context.normalizeSelectedCategories(JSON.stringify(selected))), selected));
  test(`category array normalization mask ${mask}`, () => assert.deepEqual(Array.from(context.normalizeSelectedCategories(selected)), selected));
}
const aliases = [
  ['war', 'war_security'], ['security', 'war_security'], ['جنگ', 'war_security'], ['امنیت', 'war_security'],
  ['economic', 'economy'], ['market', 'economy'], ['اقتصاد', 'economy'], ['اقتصادی', 'economy'],
  ['school', 'schools'], ['education', 'schools'], ['مدرسه', 'schools'], ['آموزش', 'schools'],
  ['important', 'major_events'], ['event', 'major_events'], ['حادثه', 'major_events'], ['مهم', 'major_events'],
];
for (const [alias, expected] of aliases) test(`category alias ${alias}`, () => assert.deepEqual(Array.from(context.normalizeModelCategories([alias])), [expected]));

// 240 local classifier tests: 60 per category.
const categorySamples = {
  war_security: ['حمله موشکی به پایگاه نظامی گزارش شد', 'ارتش درباره درگیری مرزی هشدار داد', 'انفجار امنیتی و عملیات پهپادی رخ داد'],
  economy: ['بانک مرکزی نرخ ارز و دلار را اعلام کرد', 'تورم و قیمت طلا در بازار افزایش یافت', 'بودجه و مالیات جدید تصویب شد'],
  schools: ['مدارس فردا تعطیل شد و امتحان لغو شد', 'آموزش و پرورش برنامه کنکور را اعلام کرد', 'معلمان و دانش آموزان به کلاس بازگشتند'],
  major_events: ['زلزله شدید باعث هشدار عمومی شد', 'سیل و بحران امدادرسانی را آغاز کرد', 'آتش سوزی گسترده و عملیات نجات رخ داد'],
};
for (const [id, samples] of Object.entries(categorySamples)) {
  for (let i = 0; i < 60; i++) {
    const text = `${samples[i % samples.length]} شماره ${i}`;
    test(`local category ${id} ${i}`, () => {
      const out = context.classifyNewsLocally({ title: text, body: text });
      assert.ok(Array.from(out.categories).includes(id));
      assert.ok(out.importance >= 55);
    });
  }
}

// 80 miscellaneous/promotional rejection checks.
const misc = ['جشن تولد بازیگر مشهور', 'نتیجه مسابقه فوتبال دوستانه', 'فال روزانه و طالع بینی', 'فروش ویژه با کد تخفیف'];
for (let i = 0; i < 80; i++) {
  const text = `${misc[i % misc.length]} ${i}`;
  test(`miscellaneous rejection ${i}`, () => {
    const out = context.fallbackTransform({ title: text, body: text }, { selected_categories: JSON.stringify(categoryIds), min_importance: 55, content_mode: 'summary' });
    assert.equal(out.publish, false);
  });
}

test('sports transfer-price story is rejected even though it contains economy words', () => {
  const text = 'قیمت انتقال بازیکن فوتبال در بازار افزایش یافت';
  const out = context.fallbackTransform({ title: text, body: text }, { selected_categories: '["economy"]', min_importance: 35, content_mode: 'summary' });
  assert.equal(out.publish, false);
});
test('urgent school closure is not rejected because a sports event is mentioned', () => {
  const text = 'مدارس شهر به دلیل مسابقه فوتبال و هشدار امنیتی فردا تعطیل شد';
  const out = context.fallbackTransform({ title: text, body: text }, { selected_categories: '["schools"]', min_importance: 55, content_mode: 'summary' });
  assert.equal(out.publish, true);
});

// 404 threshold/property tests.
for (const threshold of [0, 35, 55, 70]) {
  for (let importance = 0; importance <= 100; importance++) {
    test(`importance threshold ${threshold}/${importance}`, () => {
      const out = context.shouldPublishByCategory(['economy'], importance, { selected_categories: '["economy"]', min_importance: threshold });
      assert.equal(out.ok, importance >= threshold);
    });
  }
}

// Cache key separation: mode/category/importance/topic must not collide.
const baseSettings = { target_language: 'fa', content_mode: 'summary', selected_categories: '["economy"]', min_importance: 55, topic: 'اقتصاد' };
test('cache key changes between summary and full', () => assert.notEqual(context.transformationCacheKey(baseSettings), context.transformationCacheKey({ ...baseSettings, content_mode: 'full' })));
test('cache key changes with category selection', () => assert.notEqual(context.transformationCacheKey(baseSettings), context.transformationCacheKey({ ...baseSettings, selected_categories: '["schools"]' })));
test('cache key changes with importance', () => assert.notEqual(context.transformationCacheKey(baseSettings), context.transformationCacheKey({ ...baseSettings, min_importance: 70 })));
test('cache key changes with topic', () => assert.notEqual(context.transformationCacheKey(baseSettings), context.transformationCacheKey({ ...baseSettings, topic: 'مدارس' })));
for (let i = 1; i <= 50; i++) {
  test(`cache key deterministic ${i}`, () => assert.equal(context.transformationCacheKey({ ...baseSettings, topic: `موضوع ${i}` }), context.transformationCacheKey({ ...baseSettings, topic: `موضوع ${i}` })));
}

// Full mode and destination templates.
test('full body preserves full Persian original', () => {
  const original = 'پاراگراف کامل خبر '.repeat(500);
  assert.equal(context.chooseFullBody(original, 'خلاصه کوتاه', 'fa'), context.normalizeArticleBody(original).slice(0, 14000));
});
test('default full template uses body and does not render summary', () => {
  const merged = context.mergeDestinationSettings({ content_mode: 'full', message_template: '<b>{title}</b>\n{summary}', send_media: 1, show_footer: 0 }, { dest_template: null, source_send_media: null, dest_send_media: null });
  assert.match(merged.message_template, /\{body\}/);
  assert.equal(merged.message_template.includes('{summary}'), false);
});
test('destination override without body cannot force full mode back to summary', () => {
  const merged = context.mergeDestinationSettings({ content_mode: 'full', message_template: '<b>{title}</b>\n{summary}', send_media: 1, show_footer: 0 }, { dest_template: '<b>{title}</b>\n{summary}', source_send_media: null, dest_send_media: null });
  assert.match(merged.message_template, /\{body\}/);
});
test('destination full custom template is preserved', () => {
  const custom = '<b>{title}</b>\n{body}';
  const merged = context.mergeDestinationSettings({ content_mode: 'full', message_template: custom, send_media: 1, show_footer: 0 }, { dest_template: custom, source_send_media: null, dest_send_media: null });
  assert.equal(merged.message_template, custom);
});
for (const [source, dest, expected] of [[null, null, 1], [-1, null, 1], [0, null, 0], [1, 0, 0], [0, 1, 1], [1, -1, 1]]) {
  test(`media inheritance source=${source} dest=${dest}`, () => {
    const merged = context.mergeDestinationSettings({ content_mode: 'summary', message_template: '{title}', send_media: 1, show_footer: 0 }, { source_send_media: source, dest_send_media: dest });
    assert.equal(merged.send_media, expected);
  });
}

// Long Telegram message splitting: 200 lengths.
for (let i = 1; i <= 200; i++) {
  const length = 3900 + i * 37;
  test(`Telegram full-text split ${length}`, () => {
    const html = `<b>عنوان ${i}</b>\n\n${'م'.repeat(length)}\n\n<a href="https://example.com/${i}">منبع</a>`;
    const parts = Array.from(context.splitTelegramHtmlMessage(html, 3900));
    assert.ok(parts.length >= 2);
    assert.ok(parts.every((part) => part.length <= 3900));
    assert.ok(parts[0].includes(`عنوان ${i}`));
    assert.ok(parts.at(-1).includes('منبع'));
  });
}

test('sendNews keeps long text-only news in one rich message without truncating', async () => {
  const calls = [];
  const original = context.telegram;
  context.telegram = async (_env, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: 1 } };
  };
  try {
    const message = '<b>خبر</b>\n\n' + 'جزئیات کامل '.repeat(1200) + '\n\nمنبع: نمونه\nزمان: اکنون\n@IRnews24Fa';
    const out = await context.sendNewsToDestination({}, 1, message, [], { send_media: 0, disable_preview: 1 });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
    assert.equal(calls[0].payload.rich_message.html, message);
  } finally {
    context.telegram = original;
  }
});

test('media failure still publishes full text and reports warning', async () => {
  const originalRef = context.sendMediaReference;
  const originalUpload = context.fetchAndUploadMedia;
  const originalMessage = context.sendMessage;
  context.sendMediaReference = async () => ({ ok: false, description: 'expired URL' });
  context.fetchAndUploadMedia = async () => ({ ok: false, description: 'download failed' });
  context.sendMessage = async () => ({ ok: true, result: { message_id: 9 } });
  const out = await context.sendNewsToDestination({}, 1, 'خبر کامل', [{ type: 'video', value: 'https://example.com/v.mp4', source: 'url' }], { send_media: 1, disable_preview: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.media_sent, false);
  assert.match(out.media_error, /expired URL|download failed/);
  context.sendMediaReference = originalRef;
  context.fetchAndUploadMedia = originalUpload;
  context.sendMessage = originalMessage;
});

test('unsupported uploaded video falls back to Telegram document', async () => {
  const originals = {
    fetchPublicResource: context.fetchPublicResource,
    readResponseBlobLimited: context.readResponseBlobLimited,
    telegramMultipart: context.telegramMultipart,
  };
  context.fetchPublicResource = async () => ({ response: new Response(new Uint8Array([1,2,3]), { status: 200, headers: { 'content-type': 'video/mp4' } }), finalUrl: 'https://example.com/v.mp4' });
  context.readResponseBlobLimited = async () => new Blob([new Uint8Array([1,2,3])], { type: 'video/mp4' });
  const methods = [];
  context.telegramMultipart = async (_env, method) => {
    methods.push(method);
    return method === 'sendVideo' ? { ok: false, description: 'wrong file identifier/HTTP URL specified' } : { ok: true, result: { message_id: 12 } };
  };
  const out = await context.fetchAndUploadMedia({}, 1, '', { type: 'video', value: 'https://example.com/v.mp4', source: 'url' });
  assert.equal(out.ok, true);
  assert.equal(out.fallback_document, true);
  assert.deepEqual(methods, ['sendVideo', 'sendDocument']);
  Object.assign(context, originals);
});

test('Telegram web parser recognizes embedded MP4 JSON URL', () => {
  const html = `<div class="tgme_widget_message_wrap"><div data-post="chan/10"><div class="tgme_widget_message_text">خبر مهم</div><script>{"video":"https://cdn.example.com/path/v.mp4?x=1"}</script><a class="tgme_widget_message_date" href="https://t.me/chan/10"></a></div>`;
  const items = Array.from(context.parseTelegramPublicPreview(html, 'chan'));
  assert.equal(items.length, 1);
  assert.equal(items[0].media[0].type, 'telegram_copy');
  assert.equal(items[0].media[0].fallback_media[0].type, 'video');
  assert.match(items[0].media[0].fallback_media[0].value, /v\.mp4\?x=1/);
});


// Full article extraction/fetch behavior.
for (let i = 1; i <= 60; i++) {
  test(`article extractor keeps article paragraphs ${i}`, () => {
    const html = `<html><nav>menu</nav><article><h1>تیتر</h1><p>${'پاراگراف مهم '.repeat(30)}</p><p>${'جزئیات اقتصادی '.repeat(30)}</p></article><footer>تبلیغ</footer></html>`;
    const out = context.extractArticleTextFromHtml(html);
    assert.ok(out.includes('پاراگراف مهم'));
    assert.ok(out.includes('جزئیات اقتصادی'));
    assert.equal(out.includes('menu'), false);
    assert.equal(out.includes('تبلیغ'), false);
  });
}
test('article extractor reads JSON-LD articleBody', () => {
  const body = 'متن کامل خبر از جی‌سان ال‌دی '.repeat(40);
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', articleBody: body })}</script>`;
  const out = context.extractArticleTextFromHtml(html);
  assert.ok(out.includes('متن کامل خبر'));
  assert.ok(out.length > 500);
});
test('full article enrichment replaces short RSS excerpt with page body', async () => {
  const original = context.fetchFullArticleBody;
  context.fetchFullArticleBody = async () => 'متن کامل صفحه '.repeat(200);
  const out = await context.enrichFullArticleBody({ body: 'خلاصه کوتاه', url: 'https://example.com/news' }, 'full');
  assert.ok(out.length > 1000);
  context.fetchFullArticleBody = original;
});
test('summary mode does not fetch article page', async () => {
  const original = context.fetchFullArticleBody;
  let calls = 0;
  context.fetchFullArticleBody = async () => { calls += 1; return 'متن'; };
  const out = await context.enrichFullArticleBody({ body: 'خلاصه', url: 'https://example.com/news' }, 'summary');
  assert.equal(out, 'خلاصه');
  assert.equal(calls, 0);
  context.fetchFullArticleBody = original;
});

test('suggest-sources screen has only one add-all button definition', () => {
  const count = (source.match(/text: "➕ افزودن تمام منابع پیشنهادی"/g) || []).length;
  assert.equal(count, 1);
});

// UI presence and settings controls.
test('settings keyboard exposes categories', () => {
  const flat = context.settingsKeyboard({}).inline_keyboard.flat().map((x) => x.callback_data);
  assert.ok(flat.includes('settings_categories'));
  assert.ok(flat.includes('settings_importance'));
});
test('category keyboard exposes four categories', () => {
  const flat = context.categorySettingsKeyboard({ selected_categories: JSON.stringify(categoryIds) }).inline_keyboard.flat().map((x) => x.callback_data);
  for (const id of categoryIds) assert.ok(flat.includes(`category_toggle:${id}`));
});
test('importance keyboard exposes four thresholds', () => {
  const flat = context.importanceSettingsKeyboard({ min_importance: 55 }).inline_keyboard.flat().map((x) => x.callback_data);
  for (const n of [35,55,70,85]) assert.ok(flat.includes(`importance:${n}`));
});

let passed = 0;
const failures = [];
for (const t of tests) {
  try { await t.fn(); passed += 1; }
  catch (error) { failures.push({ name: t.name, error: error?.stack || String(error) }); }
}
for (const failure of failures.slice(0, 30)) console.error(`FAIL - ${failure.name}\n${failure.error}`);
console.log(`V2.9 TARGETED TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exit(1);
