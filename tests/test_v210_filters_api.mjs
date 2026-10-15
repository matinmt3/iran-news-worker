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
const categoryIds = ['war_security', 'economy', 'schools', 'major_events'];
const G1 = 'gsk_TEST_KEY_111111111111111111111111';
const G2 = 'gsk_TEST_KEY_222222222222222222222222';
const M1 = 'AIzaSy_TEST_KEY_111111111111111111111';

// Static/schema/UI coverage.
test('version is 2.10.3', () => assert.match(source, /2\.10\.3-faithful-always-on/));
test('schema has category mode', () => assert.match(source, /category_mode TEXT NOT NULL DEFAULT 'selected'/));
test('schema has strict news filter', () => assert.match(source, /strict_news_filter INTEGER NOT NULL DEFAULT 1/));
test('schema has per-key AI usage table', () => assert.match(source, /CREATE TABLE IF NOT EXISTS ai_key_usage/));
test('owner keyboard has API check', () => {
  const flat = context.ownerKeyboard().inline_keyboard.flat();
  assert.ok(flat.some((x) => x.callback_data === 'owner_ai_check'));
});
test('category keyboard has select all and disable category filtering', () => {
  const flat = context.categorySettingsKeyboard({ selected_categories: JSON.stringify(categoryIds), category_mode: 'selected' }).inline_keyboard.flat();
  assert.ok(flat.some((x) => x.callback_data === 'category_all'));
  assert.ok(flat.some((x) => x.callback_data === 'category_none'));
});
test('all-news keyboard shows return-to-selected control', () => {
  const flat = context.categorySettingsKeyboard({ selected_categories: JSON.stringify(categoryIds), category_mode: 'all_news' }).inline_keyboard.flat();
  assert.ok(flat.some((x) => x.callback_data === 'category_selected_mode'));
});

// Category mode normalization and policy.
for (const value of ['all_news', ' all_news ', 'ALL_NEWS', '', null, undefined, 'selected', 'bad']) {
  test(`category mode normalization ${String(value)}`, () => {
    const expected = String(value || '').trim() === 'all_news' ? 'all_news' : 'selected';
    assert.equal(context.normalizeCategoryMode(value), expected);
  });
}

// 121 all-news policy checks: category and importance restrictions must be bypassed.
const categoryVariants = [[], ['economy'], ['schools'], ['unknown'], ['war_security', 'economy']];
for (let importance = 0; importance <= 100; importance += 1) {
  const categories = categoryVariants[importance % categoryVariants.length];
  test(`all-news accepts genuine news policy at importance ${importance}`, () => {
    const out = context.shouldPublishByCategory(categories, importance, {
      category_mode: 'all_news', selected_categories: '[]', min_importance: 85,
    });
    assert.equal(out.ok, true);
    assert.equal(out.allNews, true);
    assert.equal(out.minImportance, 0);
  });
}

// 96 selected-category/threshold checks.
for (const threshold of [35, 55, 70, 85]) {
  for (let importance = 0; importance <= 100; importance += 5) {
    test(`selected mode matching category threshold ${threshold}/${importance}`, () => {
      const out = context.shouldPublishByCategory(['economy'], importance, {
        category_mode: 'selected', selected_categories: '["economy"]', min_importance: threshold,
      });
      assert.equal(out.ok, importance >= threshold);
    });
  }
  for (const other of ['war_security', 'schools', 'major_events']) {
    test(`selected mode rejects mismatched ${other} at threshold ${threshold}`, () => {
      const out = context.shouldPublishByCategory([other], 100, {
        category_mode: 'selected', selected_categories: '["economy"]', min_importance: threshold,
      });
      assert.equal(out.ok, false);
    });
  }
}

// Hard advertising/non-news corpus: 120 checks.
const adSamples = [
  'فروش ویژه موبایل با ۳۰ درصد تخفیف؛ برای سفارش با شماره 09123456789 تماس بگیرید',
  'رپرتاژ آگهی: همین حالا ثبت نام کنید و کد تخفیف دریافت کنید',
  'برای خرید دوره آموزشی روی لینک خرید کلیک کنید؛ فرصت استثنایی',
  'استخدام فوری با درآمد تضمینی؛ جهت مشاوره رایگان دایرکت بدهید',
  'قرعه‌کشی بزرگ با جایزه نقدی؛ کانال ما را فالو کنید',
  'Sponsored post — buy now with discount code SAVE20',
  'تبلیغ شما در این کانال؛ برای رزرو با ادمین تماس بگیرید',
  'فروش طلا با قیمت استثنایی؛ سفارش دهید و عضو ویژه شوید',
];
for (let i = 0; i < 80; i += 1) {
  const text = `${adSamples[i % adSamples.length]} شماره ${i}`;
  test(`local advertisement rejected ${i}`, () => {
    const classified = context.classifyNewsLocally({ title: text, body: text });
    const out = context.fallbackTransform({ title: text, body: text }, {
      category_mode: 'all_news', selected_categories: '[]', min_importance: 0, content_mode: 'summary', strict_news_filter: 1,
    });
    assert.equal(classified.promotional, true);
    assert.equal(classified.is_news, false);
    assert.equal(out.publish, false);
  });
}
const nonNewsSamples = [
  'صبح بخیر دوستان؛ امروز حال دلتان چطور است؟',
  'فال روزانه متولدین ماه مهر و طالع‌بینی امروز',
  'نظرسنجی: کدام رنگ را بیشتر دوست دارید؟',
  'یک جوک و معمای سرگرم‌کننده برای آخر هفته',
  'نتیجه مسابقه فوتبال و حاشیه بازیکنان لیگ برتر',
  'لایک کنید و برای دوستانتان بفرستید',
  'حاشیه بازیگر مشهور و شایعات سلبریتی‌ها',
  'پیش‌بینی فوتبال امشب و نتیجه احتمالی بازی',
];
for (let i = 0; i < 40; i += 1) {
  const text = `${nonNewsSamples[i % nonNewsSamples.length]} ${i}`;
  test(`local non-news rejected ${i}`, () => {
    const classified = context.classifyNewsLocally({ title: text, body: text });
    const out = context.fallbackTransform({ title: text, body: text }, {
      category_mode: 'all_news', selected_categories: '[]', min_importance: 0, content_mode: 'summary', strict_news_filter: 1,
    });
    assert.equal(classified.is_news, false);
    assert.equal(out.publish, false);
  });
}

// Genuine-news corpus in all-news mode: 80 checks, including topics outside the four predefined categories.
const genuineNews = [
  'وزارت بهداشت اعلام کرد واکسیناسیون سراسری از شنبه آغاز می‌شود',
  'شهرداری گزارش داد خط جدید مترو امروز افتتاح شد',
  'دادگاه حکم پرونده مهم را صادر کرد و جزئیات رسمی منتشر شد',
  'سازمان هواشناسی درباره بارش شدید در سه استان هشدار داد',
  'پلیس اعلام کرد عامل سرقت گسترده بازداشت شد',
  'وزارت ارتباطات خبر داد اختلال اینترنت برطرف شد',
  'مجلس قانون جدید حمایت از خانواده را تصویب کرد',
  'دانشمندان نتایج پژوهش تازه را در یک مجله معتبر منتشر کردند',
];
for (let i = 0; i < 80; i += 1) {
  const text = `${genuineNews[i % genuineNews.length]}؛ بر اساس گزارش رسمی شماره ${i}. جزئیات این رویداد در اطلاعیه نهاد مربوط منتشر شده است.`;
  test(`all-news genuine report accepted ${i}`, () => {
    const classified = context.classifyNewsLocally({ title: text, body: text });
    const out = context.fallbackTransform({ title: text, body: text }, {
      category_mode: 'all_news', selected_categories: '[]', min_importance: 85, content_mode: 'summary', strict_news_filter: 1,
    });
    assert.equal(classified.is_news, true);
    assert.equal(out.publish, true);
  });
}

// AI gate behavior.
test('AI advertisement is rejected even when model sets publish true', async () => {
  const original = context.aiGenerate;
  context.aiGenerate = async () => ({ publish: true, is_news: false, promotional: true, content_type: 'advertisement', categories: ['economy'], importance: 100, title: 'تبلیغ', summary: 'تبلیغ', body: 'تبلیغ' });
  const out = await context.transformNews({ title: 'فروش ویژه', body: 'برای خرید و کد تخفیف تماس بگیرید', source: 'کانال' }, {
    category_mode: 'all_news', selected_categories: '[]', min_importance: 0, content_mode: 'summary', target_language: 'fa', strict_news_filter: 1, topic: 'خبر',
  }, {}, '1');
  assert.equal(out.publish, false);
  assert.equal(out.promotional, true);
  context.aiGenerate = original;
});
test('AI non-news is rejected in all-news mode', async () => {
  const original = context.aiGenerate;
  context.aiGenerate = async () => ({ publish: true, is_news: false, promotional: false, content_type: 'non_news', categories: [], importance: 100, title: 'نظرسنجی', summary: 'نظر بدهید', body: 'نظر بدهید' });
  const out = await context.transformNews({ title: 'نظرسنجی', body: 'کدام گزینه را انتخاب می‌کنید؟', source: 'کانال' }, {
    category_mode: 'all_news', selected_categories: '[]', min_importance: 0, content_mode: 'summary', target_language: 'fa', strict_news_filter: 1, topic: 'خبر',
  }, {}, '1');
  assert.equal(out.publish, false);
  context.aiGenerate = original;
});
test('AI genuine news outside predefined categories is accepted in all-news mode', async () => {
  const original = context.aiGenerate;
  context.aiGenerate = async () => ({ publish: true, is_news: true, promotional: false, content_type: 'news', categories: [], importance: 20, title: 'خبر سلامت', summary: 'گزارش رسمی', body: 'وزارت بهداشت اعلام کرد طرح جدید اجرا شد.' });
  const out = await context.transformNews({ title: 'وزارت بهداشت اعلام کرد طرح جدید اجرا شد', body: 'وزارت بهداشت اعلام کرد طرح جدید اجرا شد و جزئیات رسمی منتشر شد.', source: 'خبرگزاری' }, {
    category_mode: 'all_news', selected_categories: '[]', min_importance: 85, content_mode: 'summary', target_language: 'fa', strict_news_filter: 1, topic: 'خبر',
  }, {}, '1');
  assert.equal(out.publish, true);
  context.aiGenerate = original;
});
test('AI content_type news is rejected when is_news is omitted', async () => {
  const original = context.aiGenerate;
  context.aiGenerate = async () => ({ publish: true, promotional: false, content_type: 'news', categories: ['economy'], importance: 80, title: 'اقتصاد', summary: 'گزارش', body: 'بانک مرکزی نرخ ارز را اعلام کرد.' });
  const out = await context.transformNews({ title: 'بانک مرکزی نرخ ارز را اعلام کرد', body: 'بانک مرکزی نرخ ارز را اعلام کرد و گزارش رسمی منتشر شد.', source: 'خبرگزاری' }, {
    category_mode: 'selected', selected_categories: '["economy"]', min_importance: 55, content_mode: 'summary', target_language: 'fa', strict_news_filter: 1, topic: 'اقتصاد',
  }, {}, '1');
  assert.equal(out.publish, false);
  context.aiGenerate = original;
});
test('selected mode rejects genuine news from an unselected category', async () => {
  const original = context.aiGenerate;
  context.aiGenerate = async () => ({ publish: true, is_news: true, promotional: false, content_type: 'news', categories: ['schools'], importance: 90, title: 'مدارس', summary: 'خبر', body: 'مدارس تعطیل شد.' });
  const out = await context.transformNews({ title: 'مدارس فردا تعطیل شد', body: 'آموزش و پرورش اعلام کرد مدارس فردا تعطیل شد.', source: 'خبرگزاری' }, {
    category_mode: 'selected', selected_categories: '["economy"]', min_importance: 55, content_mode: 'summary', target_language: 'fa', strict_news_filter: 1, topic: 'اقتصاد',
  }, {}, '1');
  assert.equal(out.publish, false);
  context.aiGenerate = original;
});

// API-key identifiers, header parsing, health checks and per-key accounting.
for (let i = 0; i < 30; i += 1) {
  const key = `gsk_test_${i}_${'x'.repeat(24)}`;
  test(`safe API key identifier deterministic ${i}`, () => {
    const id1 = context.aiKeyIdentifier('groq', key);
    const id2 = context.aiKeyIdentifier('groq', key);
    assert.equal(id1, id2);
    assert.equal(id1.includes(key), false);
    assert.match(id1, /^groq-[0-9a-f]{8}$/);
  });
}
test('different keys have different safe identifiers', () => assert.notEqual(context.aiKeyIdentifier('groq', G1), context.aiKeyIdentifier('groq', G2)));
test('same raw key has provider-specific identifiers', () => assert.notEqual(context.aiKeyIdentifier('groq', G1), context.aiKeyIdentifier('gemini', G1)));
test('rate-limit headers are extracted', () => {
  const headers = new Headers({
    'x-ratelimit-limit-requests': '30', 'x-ratelimit-remaining-requests': '29',
    'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '5900', 'retry-after': '2',
  });
  const out = context.extractAiRateLimitHeaders(headers);
  assert.equal(out['x-ratelimit-limit-requests'], '30');
  assert.equal(out['x-ratelimit-remaining-requests'], '29');
  assert.match(context.formatAiRateLimitSummary(out), /29/);
});
test('unknown quota headers produce honest unavailable message', () => assert.match(context.formatAiRateLimitSummary({}), /اعلام نکرد/));
test('health label distinguishes healthy, limited and invalid', () => {
  assert.match(context.apiHealthStatusLabel({ ok: true }), /سالم/);
  assert.match(context.apiHealthStatusLabel({ ok: false, status: 'HTTP 429' }), /محدود/);
  assert.match(context.apiHealthStatusLabel({ ok: false, status: 'HTTP 401' }), /نامعتبر/);
});

test('Groq health check uses models endpoint and bearer token', async () => {
  let seen;
  context.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return new Response('{"object":"list","data":[]}', { status: 200, headers: { 'x-ratelimit-remaining-requests': '19' } });
  };
  const out = await context.checkSingleAiKey('groq', G1, 1, { GROQ_MODEL: 'openai/gpt-oss-20b' });
  assert.equal(out.ok, true);
  assert.equal(seen.url, 'https://api.groq.com/openai/v1/models');
  assert.equal(seen.options.headers.Authorization, `Bearer ${G1}`);
  assert.equal(out.rateLimits['x-ratelimit-remaining-requests'], '19');
});
test('Gemini health check uses Interactions endpoint and x-goog-api-key', async () => {
  let seen;
  context.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return new Response(JSON.stringify({ steps:[{type:'model_output',content:[{type:'text',text:'OK'}]}], usage:{} }), { status: 200 });
  };
  const out = await context.checkSingleAiKey('gemini', M1, 1, { GEMINI_MODEL: 'gemini-2.5-flash-lite' });
  assert.equal(out.ok, true);
  assert.equal(seen.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers['x-goog-api-key'], M1);
});
test('health check redacts invalid key from error', async () => {
  context.fetch = async () => new Response(JSON.stringify({ error: { message: `invalid ${G1}` } }), { status: 401 });
  const out = await context.checkSingleAiKey('groq', G1, 1, {});
  assert.equal(out.ok, false);
  assert.equal(out.error.includes(G1), false);
  assert.match(out.error, /REDACTED/);
});
test('health pool checks every configured key', async () => {
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({ steps:[{type:'model_output',content:[{type:'text',text:'OK'}]}], usage:{} }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const out = await context.runAiApiHealthChecks({ GROQ_API_KEYS: `${G1}\n${G2}`, GEMINI_API_KEY: M1 });
  assert.equal(out.length, 3);
  assert.equal(calls.length, 3);
  assert.equal(out.filter((x) => x.ok).length, 3);
});

test('successful Groq generation records the exact safe key slot and tokens', async () => {
  const records = [];
  const DB = {
    prepare(sql) {
      return { bind(...values) { return { async run() { records.push({ sql, values }); return { success: true }; } }; } };
    },
  };
  context.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 12, completion_tokens: 4 },
  }), { status: 200, headers: { 'x-ratelimit-remaining-requests': '9' } });
  const out = await context.groqGenerate('test', { GROQ_API_KEY: G1, DB }, false, false, null);
  assert.equal(out, 'ok');
  assert.equal(records.length, 1);
  assert.match(records[0].sql, /INSERT INTO ai_key_usage/);
  assert.equal(records[0].values[0], 'groq');
  assert.equal(records[0].values[1], context.aiKeyIdentifier('groq', G1));
  assert.equal(records[0].values[2], 1);
  assert.equal(records[0].values[4], 1);
  assert.equal(records[0].values[5], 0);
  assert.equal(records[0].values[6], 12);
  assert.equal(records[0].values[7], 4);
});
test('failed key attempt is recorded before rotation', async () => {
  const records = [];
  const DB = {
    prepare(sql) {
      return { bind(...values) { return { async run() { records.push({ sql, values }); return { success: true }; } }; } };
    },
  };
  let n = 0;
  context.fetch = async () => {
    n += 1;
    if (n === 1) return new Response(JSON.stringify({ error: { message: 'limited' } }), { status: 429 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }), { status: 200 });
  };
  assert.equal(await context.groqGenerate('rotate', { GROQ_API_KEYS: `${G1}\n${G2}`, DB }), 'ok');
  assert.equal(records.length, 2);
  assert.ok(records.some((r) => r.values[4] === 0));
  assert.ok(records.some((r) => r.values[4] === 1));
});

test('API tracking never stores raw key in SQL bindings', async () => {
  const records = [];
  const DB = {
    prepare(sql) { return { bind(...values) { return { async run() { records.push({ sql, values }); } }; } }; },
  };
  await context.recordAiKeyAttempt({ DB }, 'groq', G1, 1, 'model', { success: true, promptTokens: 1, outputTokens: 1, status: 'ok' });
  const serialized = JSON.stringify(records);
  assert.equal(serialized.includes(G1), false);
});

// Cache must separate all-news and selected modes.
test('transformation cache separates category modes', () => {
  const base = { target_language: 'fa', content_mode: 'summary', selected_categories: '["economy"]', min_importance: 55, topic: 'خبر', strict_news_filter: 1 };
  assert.notEqual(context.transformationCacheKey({ ...base, category_mode: 'selected' }), context.transformationCacheKey({ ...base, category_mode: 'all_news' }));
});
test('transformation cache separates strict filter state', () => {
  const base = { target_language: 'fa', content_mode: 'summary', selected_categories: '["economy"]', category_mode: 'selected', min_importance: 55, topic: 'خبر' };
  assert.notEqual(context.transformationCacheKey({ ...base, strict_news_filter: 1 }), context.transformationCacheKey({ ...base, strict_news_filter: 0 }));
});

let passed = 0;
const failures = [];
for (const t of tests) {
  try { await t.fn(); passed += 1; }
  catch (error) { failures.push({ name: t.name, error: error?.stack || String(error) }); }
}
for (const failure of failures.slice(0, 40)) console.error(`FAIL - ${failure.name}\n${failure.error}`);
console.log(`V2.10 FILTER/API TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exit(1);
