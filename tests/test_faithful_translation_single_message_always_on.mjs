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
const settings = {
  category_mode: 'all_news', selected_categories: '[]', min_importance: 0,
  content_mode: 'summary', target_language: 'fa', strict_news_filter: 0, topic: 'خبر',
};
const accepted = (translation, title = translation) => ({
  publish: true, is_news: true, promotional: false, content_type: 'news',
  categories: ['war_security'], importance: 80, rejection_reason: '',
  translated_title: title, translated_text: translation,
});

test('Persian detector distinguishes the reported Arabic sentence from Persian news', () => {
  assert.equal(context.isLikelyPersianText('لحظة تفعيل الدفاعات الجوية في الأردن.'), false);
  assert.equal(context.isLikelyPersianText('لحظه فعال‌شدن پدافند هوایی در اردن.'), true);
  assert.equal(context.isLikelyPersianText('وزارت دفاع اعلام کرد پدافند هوایی فعال شده است.'), true);
  assert.equal(context.isLikelyPersianText('Air defenses were activated in Jordan.'), false);
  assert.equal(context.isLikelyPersianText('دفاع جوي اردن'), false);
  assert.equal(context.isLikelyPersianText('صواريخ فوق عمان'), false);
  assert.equal(context.isLikelyPersianText('حدث مهم شرق دمشق'), false);
  assert.equal(context.isLikelyPersianText('زلزله امروز تهران'), true);
});

test('Urdu and Sorani Arabic-script news is never mistaken for Persian', () => {
  const foreignSamples = [
    'پاکستان کی حکومت نے آج ایک اہم فیصلہ کیا ہے۔',
    'ئەمڕۆ حکومەتی هەرێم بڕیارێکی نوێی ڕاگەیاند.',
    'ایران میں فضائی دفاع کو فعال کرنے کا لمحہ۔',
  ];
  for (const text of foreignSamples) {
    assert.equal(context.isLikelyPersianText(text), false, text);
    assert.equal(context.isClearlyForeignText(text), true, text);
    assert.equal(context.sourceRequiresTranslation(text, '', 'fa'), true, text);
    assert.equal(context.fallbackTransform({ title: text, body: '' }, settings).publish, false, text);
  }
});

test('a foreign title-only post is fail-closed and cannot bypass translation', () => {
  const out = context.fallbackTransform({
    title: 'صواريخ فوق عمان',
    body: '',
  }, settings);
  assert.equal(out.publish, false);
  assert.equal(out.translation_required, true);
  assert.equal(context.sourceRequiresTranslation('صواريخ فوق عمان', '', 'fa'), true);
  assert.equal(context.sourceRequiresTranslation('حدث مهم شرق دمشق', '', 'fa'), true);
});

test('an ambiguous short Persian headline is preserved when its body is confidently Persian', () => {
  const body = 'وزارت کشور اعلام کرد این خبر امروز در تهران تأیید شده است.';
  assert.equal(context.sourceMatchesTargetLanguage('وزارت دفاع', body, 'fa'), true);
  assert.equal(context.sourceRequiresTranslation('وزارت دفاع', body, 'fa'), false);
  assert.equal(context.sourceMatchesTargetLanguage('حدث مهم شرق دمشق', body, 'fa'), false);
  assert.equal(context.sourceRequiresTranslation('حدث مهم شرق دمشق', body, 'fa'), true);
});

test('an incomplete one-sentence answer cannot validate a long multi-sentence source', () => {
  const longArabic = 'أعلنت السلطات تفعيل الدفاعات الجوية في الأردن. '.repeat(24);
  const result = context.validateFaithfulTranslation(longArabic, 'این یک متن فارسی است.', 'fa');
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('translation_too_short'));
  assert.ok(result.reasons.includes('sentence_loss'));
});

test('same-length semantic fabrication is rejected by the short-news concept guard', () => {
  const sourceText = 'لحظة تفعيل الدفاعات الجوية في الأردن.';
  const fabricated = 'امروز آسمان اردن کاملاً آرام و بدون خطر است.';
  const result = context.validateFaithfulTranslation(sourceText, fabricated, 'fa');
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('new_context_claim') || result.reasons.includes('missing_context_claim'));
});

test('new locations and military claims are rejected in short and long translations', () => {
  const shortResult = context.validateFaithfulTranslation(
    'أعلنت الوزارة القرار اليوم.',
    'وزارتخانه تصمیم را امروز در تهران اعلام کرد.',
    'fa',
  );
  assert.equal(shortResult.ok, false);
  assert.ok(shortResult.reasons.includes('new_context_claim'));

  const longSource = 'أعلنت الوزارة القرار اليوم بعد اجتماع رسمي حضره المسؤولون، وقالت إن التنفيذ سيبدأ غداً وفق الجدول المعلن. وأضافت أن التفاصيل الكاملة ستنشر في بيان لاحق.';
  const longFabrication = 'وزارتخانه پس از نشست رسمی با حضور مسئولان، تصمیم را امروز اعلام کرد و گفت اجرای آن طبق برنامه اعلام‌شده از فردا آغاز می‌شود. همچنین اعلام کرد جزئیات کامل در بیانیه‌ای بعدی منتشر خواهد شد. این تصمیم بخشی از یک عملیات نظامی گسترده است.';
  const longResult = context.validateFaithfulTranslation(longSource, longFabrication, 'fa');
  assert.equal(longResult.ok, false);
  assert.ok(longResult.reasons.includes('new_context_claim'));
});

test('unchanged Arabic fails closed for non-Arabic targets', () => {
  const arabic = 'لحظة تفعيل الدفاعات الجوية في الأردن.';
  for (const language of ['en', 'tr', 'fr', 'ku']) {
    const result = context.validateFaithfulTranslation(arabic, arabic, language);
    assert.equal(result.ok, false, language);
    assert.ok(result.reasons.includes('unchanged_foreign_text'), language);
  }
  assert.equal(context.validateFaithfulTranslation(arabic, arabic, 'ar').ok, true);
});

test('faithful-v6 cache key invalidates every older translation contract', () => {
  const key = context.transformationCacheKey(settings);
  assert.match(key, /^faithful-v6:/);
  assert.equal(key.startsWith('faithful-v5:'), false);
});

test('reported Arabic sentence is translated literally without invented aircraft or attacks', async () => {
  const original = context.aiGenerate;
  let calls = 0;
  try {
    context.aiGenerate = async (prompt) => {
      calls += 1;
      assert.match(prompt, /لحظة تفعيل الدفاعات الجوية في الأردن/);
      if (calls === 1) assert.match(prompt, /strict news classifier/i);
      else assert.match(prompt, /literal|faithful|exact source text/i);
      return accepted('لحظه فعال‌شدن پدافند هوایی در اردن.');
    };
    const out = await context.transformNews({
      title: 'لحظة تفعيل الدفاعات الجوية في الأردن.',
      body: 'لحظة تفعيل الدفاعات الجوية في الأردن.', source: 'Ali Bk',
    }, settings, {}, '1');
    assert.equal(out.publish, true);
    assert.equal(out.summary, 'لحظه فعال‌شدن پدافند هوایی در اردن.');
    assert.equal(out.body, 'لحظه فعال‌شدن پدافند هوایی در اردن.');
    assert.doesNotMatch(`${out.title}\n${out.body}`, /هواپیما|پایگاه آمریکایی|حمله ایرانی/);
    assert.equal(out.translation_status, 'translated');
    assert.equal(calls, 2);
  } finally {
    context.aiGenerate = original;
  }
});

test('an invalid translated title is safely recovered from its valid translated duplicate body line', async () => {
  const sourceTitle = 'بسم الله الرحمن الرحيم';
  const sourceBody = `${sourceTitle}\nأعلنت الوزارة تفاصيل القرار.`;
  const translatedBody = 'به نام خداوند بخشنده و مهربان\nوزارتخانه جزئیات تصمیم را اعلام کرد.';
  const bundle = context.validateFaithfulTranslationFields(sourceTitle, sourceBody, {
    translated_title: sourceTitle,
    translated_text: translatedBody,
  }, 'fa');
  assert.equal(bundle.ok, true);
  assert.equal(bundle.titleDerivedFromBody, true);
  assert.equal(bundle.title.contextuallyValidated, true);
  assert.equal(bundle.title.text, 'به نام خداوند بخشنده و مهربان');

  const original = context.aiGenerate;
  let calls = 0;
  try {
    context.aiGenerate = async () => {
      calls += 1;
      if (calls === 1) return accepted('متن طبقه‌بندی که نباید منتشر شود');
      return { translated_title: sourceTitle, translated_text: translatedBody };
    };
    const out = await context.transformNews({ title: sourceTitle, body: sourceBody, source: 'نمونه' }, settings, {}, '1');
    assert.equal(out.publish, true);
    assert.equal(out.title, 'به نام خداوند بخشنده و مهربان');
    assert.equal(out.body, context.sanitizeOutboundNewsText(translatedBody));
    assert.equal(calls, 2);
  } finally {
    context.aiGenerate = original;
  }
});

test('title recovery stays fail-closed unless source and body lines correspond and the derived title validates', () => {
  const sourceTitle = 'بسم الله الرحمن الرحيم';
  const notDuplicated = context.validateFaithfulTranslationFields(
    sourceTitle,
    'أعلنت الوزارة تفاصيل القرار.',
    { translated_title: sourceTitle, translated_text: 'وزارتخانه جزئیات تصمیم را اعلام کرد.' },
    'fa',
  );
  assert.equal(notDuplicated.ok, false);
  assert.equal(notDuplicated.titleDerivedFromBody, false);
  assert.ok(notDuplicated.reasons.includes('title:target_language_mismatch'));

  const characterOnlyNormalization = context.validateFaithfulTranslationFields(
    sourceTitle,
    `${sourceTitle}\nأعلنت الوزارة تفاصيل القرار.`,
    { translated_title: sourceTitle, translated_text: 'بسم الله الرحمن الرحیم\nوزارتخانه جزئیات تصمیم را اعلام کرد.' },
    'fa',
  );
  assert.equal(characterOnlyNormalization.ok, false);
  assert.equal(characterOnlyNormalization.titleDerivedFromBody, false);
  assert.ok(characterOnlyNormalization.reasons.includes('title:target_language_mismatch'));
});

test('a short ambiguous Persian title is accepted only with a valid translated body and clearly foreign source title', () => {
  const valid = context.validateFaithfulTranslationFields(
    'وزارة الدفاع',
    'أعلنت وزارة الدفاع تفاصيل القرار.',
    { translated_title: 'وزارت دفاع', translated_text: 'وزارت دفاع جزئیات تصمیم را اعلام کرد.' },
    'fa',
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.title.contextuallyValidated, true);
  assert.equal(valid.title.text, 'وزارت دفاع');

  const unchanged = context.validateFaithfulTranslationFields(
    'وزارة الدفاع',
    'أعلنت وزارة الدفاع تفاصيل القرار.',
    { translated_title: 'وزارة الدفاع', translated_text: 'وزارت دفاع جزئیات تصمیم را اعلام کرد.' },
    'fa',
  );
  assert.equal(unchanged.ok, false);
  assert.ok(unchanged.reasons.includes('title:target_language_mismatch'));
});

test('duplicate-title cleanup preserves a decisive continuation on the first line', () => {
  const title = 'وزارت دفاع تصمیم جدید را امروز اعلام کرد';
  assert.equal(
    context.removeDuplicateLeadingTitle(title, `${title}\nجزئیات بعدی`),
    'جزئیات بعدی',
  );
  const cancelled = context.removeDuplicateLeadingTitle(title, `${title}؛ لغو شد.\nجزئیات بعدی`);
  assert.match(cancelled, /وزارت دفاع تصمیم جدید را امروز اعلام کرد؛ لغو شد/);
  assert.match(cancelled, /جزئیات بعدی/);
  const denied = context.removeDuplicateLeadingTitle(title, `${title}؛ تکذیب شد.\nجزئیات بعدی`);
  assert.match(denied, /وزارت دفاع تصمیم جدید را امروز اعلام کرد؛ تکذیب شد/);
  assert.match(denied, /جزئیات بعدی/);
});

test('Red Sea ship rerouting concepts and Persian digits are preserved exactly', () => {
  const sourceText = 'ارتفاع عدد السفن التي غيرت مسارها في البحر الأحمر إلى 4.';
  const faithful = 'افزایش تعداد کشتی‌هایی که مسیر خود را در دریای سرخ تغییر داده‌اند به ۴.';
  assert.equal(context.validateFaithfulTranslation(sourceText, faithful, 'fa').ok, true);

  const wrongSea = context.validateFaithfulTranslation(
    sourceText,
    'افزایش تعداد کشتی‌هایی که مسیر خود را در دریای عمان تغییر داده‌اند به ۴.',
    'fa',
  );
  assert.equal(wrongSea.ok, false);
  assert.ok(wrongSea.reasons.includes('missing_context_claim'));

  const wrongSubject = context.validateFaithfulTranslation(
    sourceText,
    'افزایش تعداد خودروهایی که مسیر خود را در دریای سرخ تغییر داده‌اند به ۴.',
    'fa',
  );
  assert.equal(wrongSubject.ok, false);
  assert.ok(wrongSubject.reasons.includes('missing_context_claim'));

  const missingChange = context.validateFaithfulTranslation(
    sourceText,
    'تعداد کشتی‌های حاضر در دریای سرخ ۴ فروند است.',
    'fa',
  );
  assert.equal(missingChange.ok, false);
  assert.ok(missingChange.reasons.includes('missing_context_claim'));
});

test('Arabic plural morphology is recognized without false new-context failures', () => {
  const droneSource = 'محاولات لإسقاط المسيّرات في سماء اربيل.';
  const droneTranslation = 'تلاش‌هایی برای سرنگونی پهپادها در آسمان اربیل.';
  const droneResult = context.validateFaithfulTranslation(droneSource, droneTranslation, 'fa');
  assert.equal(droneResult.ok, true, droneResult.reasons.join(', '));

  const aircraftSource = 'الطائرات الأميركية تحلق فوق قاعدة العديد.';
  const aircraftTranslation = 'هواپیماهای آمریکایی بر فراز پایگاه العدید پرواز می‌کنند.';
  const aircraftResult = context.validateFaithfulTranslation(aircraftSource, aircraftTranslation, 'fa');
  assert.equal(aircraftResult.ok, true, aircraftResult.reasons.join(', '));

  const invented = context.validateFaithfulTranslation(
    aircraftSource,
    'هواپیماهای آمریکایی پس از حمله ایران بر فراز پایگاه العدید پرواز می‌کنند.',
    'fa',
  );
  assert.equal(invented.ok, false);
  assert.ok(invented.reasons.includes('new_context_claim'));

  const missingDrone = context.validateFaithfulTranslation(
    droneSource,
    'تلاش‌هایی در آسمان اربیل انجام شد.',
    'fa',
  );
  assert.equal(missingDrone.ok, false);
  assert.ok(missingDrone.reasons.includes('missing_context_claim'));
});

test('bidi HTML entities are removed before language and fidelity validation', () => {
  const sourceText = '&rlm;الخارجية البريطانية: على رعايانا في الشرق الأوسط الاستعداد لاحتمال إلغاء رحلات جوية.';
  const clean = context.normalizeArticleBody(sourceText);
  assert.doesNotMatch(clean, /&rlm;|\u200f/i);
  const result = context.validateFaithfulTranslation(
    clean,
    'وزارت خارجه بریتانیا: شهروندان ما در خاورمیانه باید برای احتمال لغو پروازها آماده باشند.',
    'fa',
  );
  assert.equal(result.ok, true, result.reasons.join(', '));
});

test('field concept checks use the complete source item but still reject outside inventions', () => {
  const sourceTitle = 'القناة 14 العبرية:';
  const sourceBody = 'حالة تأهب في إسرائيل بعد هجوم إيراني.';
  const valid = context.validateFaithfulTranslationFields(sourceTitle, sourceBody, {
    translated_title: 'شبکه ۱۴ اسرائیل: هشدار پس از حمله ایران',
    translated_text: 'وضعیت آماده‌باش در اسرائیل پس از حمله ایران.',
  }, 'fa');
  assert.equal(valid.ok, true, valid.reasons.join(', '));

  const invented = context.validateFaithfulTranslationFields(sourceTitle, sourceBody, {
    translated_title: 'شبکه ۱۴ اسرائیل: هواپیمای آمریکایی پس از حمله ایران',
    translated_text: 'وضعیت آماده‌باش در اسرائیل پس از حمله ایران.',
  }, 'fa');
  assert.equal(invented.ok, false);
  assert.ok(invented.reasons.includes('title:new_context_claim'));
});

test('hallucinated expansion is rejected and repaired by a translation-only retry', async () => {
  const original = context.aiGenerate;
  let calls = 0;
  try {
    context.aiGenerate = async () => {
      calls += 1;
      if (calls === 1) return accepted(
        'یک هواپیما پس از حمله نیروهای ایرانی بالای پایگاه آمریکایی در اردن پرواز کرد. هیچ گزارشی از خسارت منتشر نشده است.',
        'هواپیما بر فراز پایگاه آمریکایی اردن'
      );
      return { translated_title: 'لحظه فعال‌شدن پدافند هوایی در اردن', translated_text: 'لحظه فعال‌شدن پدافند هوایی در اردن.' };
    };
    const out = await context.transformNews({
      title: 'لحظة تفعيل الدفاعات الجوية في الأردن.',
      body: 'لحظة تفعيل الدفاعات الجوية في الأردن.', source: 'Ali Bk',
    }, settings, {}, '1');
    assert.equal(calls, 2);
    assert.equal(out.body, 'لحظه فعال‌شدن پدافند هوایی در اردن.');
    assert.doesNotMatch(JSON.stringify(out), /هواپیما|پایگاه آمریکایی|حمله نیروهای ایرانی/);
  } finally {
    context.aiGenerate = original;
  }
});

test('classification wording is ignored and every foreign publish gets an independent deterministic translation call', async () => {
  const original = context.aiGenerate;
  const calls = [];
  try {
    context.aiGenerate = async (prompt, _env, _search, _json, _user, options = {}) => {
      calls.push({ prompt, options });
      if (calls.length === 1) return accepted('امروز آسمان اردن کاملاً آرام و بدون خطر است.', 'آسمان آرام اردن');
      return { translated_title: 'لحظه فعال‌شدن پدافند هوایی در اردن', translated_text: 'لحظه فعال‌شدن پدافند هوایی در اردن.' };
    };
    const out = await context.transformNews({
      title: 'لحظة تفعيل الدفاعات الجوية في الأردن.',
      body: 'لحظة تفعيل الدفاعات الجوية في الأردن.', source: 'Ali Bk',
    }, settings, {}, '1');
    assert.equal(calls.length, 2);
    assert.match(calls[0].prompt, /strict news classifier/i);
    assert.match(calls[1].prompt, /literal, faithful translation engine/i);
    assert.equal(calls[1].options.temperature, 0);
    assert.equal(out.summary, 'لحظه فعال‌شدن پدافند هوایی در اردن.');
    assert.doesNotMatch(JSON.stringify(out), /آسمان اردن کاملاً آرام/);
  } finally {
    context.aiGenerate = original;
  }
});

test('numeric source URLs are removed before number-preservation validation', async () => {
  const original = context.aiGenerate;
  let calls = 0;
  try {
    context.aiGenerate = async () => {
      calls += 1;
      if (calls === 1) return accepted('ignored classifier wording');
      return { translated_title: 'لحظه فعال‌شدن پدافند هوایی در اردن', translated_text: 'لحظه فعال‌شدن پدافند هوایی در اردن.' };
    };
    const out = await context.transformNews({
      title: 'لحظة تفعيل الدفاعات الجوية في الأردن.',
      body: 'لحظة تفعيل الدفاعات الجوية في الأردن. https://t.me/Alibk3/30849',
      url: 'https://t.me/Alibk3/30849', source: 'Ali Bk',
    }, settings, {}, '1');
    assert.equal(out.publish, true);
    assert.equal(out.summary, 'لحظه فعال‌شدن پدافند هوایی در اردن.');
    assert.doesNotMatch(out.summary, /30849|t\.me/);
  } finally {
    context.aiGenerate = original;
  }
});

test('provider request builders honor deterministic temperature zero', () => {
  assert.equal(context.buildGeminiGenerateContentBody('x', false, true, 256, 0).generationConfig.temperature, 0);
  assert.equal(context.buildGeminiInteractionsBody('x', 'model', false, true, 256, '', 0).generation_config.temperature, 0);
  assert.equal(context.normalizedAiTemperature({ temperature: 0 }), 0);
});

test('foreign text is never published untranslated when every AI attempt fails validation', async () => {
  const original = context.aiGenerate;
  try {
    context.aiGenerate = async () => accepted('لحظة تفعيل الدفاعات الجوية في الأردن.');
    await assert.rejects(() => context.transformNews({
      title: 'لحظة تفعيل الدفاعات الجوية في الأردن.',
      body: 'لحظة تفعيل الدفاعات الجوية في الأردن.', source: 'Ali Bk',
    }, settings, {}, '1'), (error) => error?.code === 'TRANSLATION_REQUIRED');
  } finally {
    context.aiGenerate = original;
  }
});

test('already-Persian source text is preserved instead of being rewritten by the model', async () => {
  const original = context.aiGenerate;
  const body = 'وزارت دفاع اعلام کرد پدافند هوایی فعال شده است.\n\nجزئیات بیشتری منتشر نشده است.';
  try {
    context.aiGenerate = async () => accepted(
      'یک هواپیما بر فراز پایگاه پرواز کرد و سپس حادثه‌ای رخ داد.',
      'روایت ساختگی مدل'
    );
    const out = await context.transformNews({ title: 'اطلاعیه وزارت دفاع', body, source: 'خبرگزاری' }, settings, {}, '1');
    assert.equal(out.title, 'اطلاعیه وزارت دفاع');
    assert.equal(out.body, body);
    assert.equal(out.summary, body);
    assert.equal(out.translation_status, 'source_preserved');
  } finally {
    context.aiGenerate = original;
  }
});

test('summary mode preserves a faithful translation longer than the old 4000-character cap', async () => {
  const original = context.aiGenerate;
  const arabicBody = 'أعلنت السلطات تفعيل الدفاعات الجوية في الأردن. '.repeat(115).trim();
  const persianBody = 'مقام‌ها از فعال‌شدن پدافند هوایی در اردن خبر دادند. '.repeat(115).trim();
  try {
    context.aiGenerate = async () => accepted(persianBody, 'فعال‌شدن پدافند هوایی در اردن');
    const out = await context.transformNews({
      title: 'تفعيل الدفاعات الجوية في الأردن', body: arabicBody, source: 'نمونه',
    }, settings, {}, '1');
    assert.equal(out.publish, true);
    assert.equal(out.summary, persianBody);
    assert.ok(out.summary.length > 4000);
  } finally {
    context.aiGenerate = original;
  }
});

test('Persian fallback keeps the complete source instead of truncating it to 900 characters', () => {
  const body = 'وزارت دفاع اعلام کرد سامانه پدافند هوایی فعال شده است. '.repeat(150).trim();
  const out = context.fallbackTransform({ title: 'اطلاعیه وزارت دفاع', body }, settings);
  assert.equal(out.translation_required, false);
  assert.equal(out.summary, body);
  assert.ok(out.summary.length > 4000);
});

test('fallback classifier blocks a foreign-language item until a translation exists', () => {
  const out = context.fallbackTransform({
    title: 'لحظة تفعيل الدفاعات الجوية في الأردن.',
    body: 'لحظة تفعيل الدفاعات الجوية في الأردن.',
  }, settings);
  assert.equal(out.publish, false);
  assert.equal(out.translation_required, true);
});

test('a source headline repeated as the first body line is rendered only once', () => {
  const title = 'دونالد ترامپ: ایران بهای آن را چند برابر پرداخت می‌کند';
  const body = `${title}\n\nاو در ادامه نوشت این دستور به فرماندهان ابلاغ شده است.`;
  assert.equal(context.removeDuplicateLeadingTitle(title, body), 'او در ادامه نوشت این دستور به فرماندهان ابلاغ شده است.');
  assert.equal(context.removeDuplicateLeadingTitle('لحظه فعال‌شدن پدافند هوایی در اردن', 'لحظه فعال‌شدن پدافند هوایی در اردن.'), '');
});

test('long media news uses one rich Telegram message containing text source date footer and media', async () => {
  const original = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: { message_id: 901 } };
    };
    const message = `<b>📰 تیتر</b>\n\n${'متن دقیق خبر '.repeat(120)}\n\n<b>منبع:</b> BBCPersian\n<b>زمان:</b> ۲۹ تیر ۱۴۰۵، ۲۱:۱۳\n\n@IRnews24Fa`;
    const out = await context.sendNewsToDestination({}, '-1001', message, [
      { type: 'photo', value: 'telegram-photo-file-id', source: 'file_id' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
    assert.match(calls[0].payload.rich_message.html, /BBCPersian/);
    assert.match(calls[0].payload.rich_message.html, /۲۹ تیر ۱۴۰۵/);
    assert.match(calls[0].payload.rich_message.html, /@IRnews24Fa/);
    assert.equal(calls[0].payload.rich_message.media.length, 1);
    assert.equal(out.media_sent, true);
  } finally {
    context.telegram = original;
  }
});

test('long Telegram public photo uses its safe fallback in one rich message, never a footer-only second message', async () => {
  const original = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: { message_id: 902 } };
    };
    const message = `<b>خبر</b>\n\n${'پاراگراف خبر '.repeat(100)}\n\nمنبع: BBCPersian\nزمان: اکنون\n@IRnews24Fa`;
    const out = await context.sendNewsToDestination({}, '-1002', message, [{
      type: 'telegram_copy', value: '@bbcpersian:287220', source: 'telegram',
      from_chat_id: '@bbcpersian', message_id: 287220, media_kind: 'photo',
      fallback_media: [{ type: 'photo', value: 'https://cdn.example/bbc-photo.jpg', source: 'url' }],
    }], { send_media: 1, disable_preview: 1 });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
    assert.equal(calls[0].payload.rich_message.media[0].media.media, 'https://cdn.example/bbc-photo.jpg');
  } finally {
    context.telegram = original;
  }
});

test('if rich media is rejected, full text falls back atomically to one rich text message', async () => {
  const original = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      if (payload.rich_message.media?.length) return { ok: false, description: 'media fetch failed' };
      return { ok: true, result: { message_id: 903 } };
    };
    const message = `<b>خبر</b>\n\n${'متن کامل '.repeat(150)}\n\nمنبع: نمونه\nزمان: اکنون`;
    const out = await context.sendNewsToDestination({}, '-1003', message, [
      { type: 'video', value: 'https://cdn.example/video.mp4', source: 'url' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === 'sendRichMessage'));
    assert.equal(calls[1].payload.rich_message.media, undefined);
    assert.match(calls[1].payload.rich_message.html, /منبع: نمونه/);
    assert.equal(out.media_sent, false);
  } finally {
    context.telegram = original;
  }
});

test('Rich HTML entity rejection retries once as safe plain rich text', async () => {
  const original = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      if (calls.length === 1) return { ok: false, description: "Bad Request: can't parse entities" };
      return { ok: true, result: { message_id: 905 } };
    };
    const out = await context.sendRichNewsMessage({}, '-1006', '<b>خبر</b> & متن کامل', [], { target_language: 'fa' });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === 'sendRichMessage'));
    assert.doesNotMatch(calls[1].payload.rich_message.html, /<b>/);
    assert.match(calls[1].payload.rich_message.html, /خبر/);
  } finally {
    context.telegram = original;
  }
});

test('explicit Rich rejection never splits a long text-only post', async () => {
  const original = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      return { ok: false, description: 'rich rejected' };
    };
    const message = `<b>خبر</b>\n\n${'متن کامل '.repeat(700)}\n\nمنبع: نمونه\n@IRnews24Fa`;
    const out = await context.sendNewsToDestination({}, '-1007', message, [], { send_media: 0, disable_preview: 1 });
    assert.equal(out.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
  } finally {
    context.telegram = original;
  }
});

test('explicit Rich rejection never reports a truncated exact-copy post as success', async () => {
  const original = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      return { ok: false, description: 'rich rejected' };
    };
    const message = `<b>خبر</b>\n\n${'متن کامل '.repeat(180)}\n\nمنبع: نمونه\n@IRnews24Fa`;
    const out = await context.sendNewsToDestination({}, '-1008', message, [{
      type: 'telegram_copy', value: '@source:42', source: 'telegram',
      from_chat_id: '@source', message_id: 42, media_kind: 'video', fallback_media: [],
    }], { send_media: 1, disable_preview: 1 });
    assert.equal(out.ok, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
  } finally {
    context.telegram = original;
  }
});

test('double Rich rejection never falls through to legacy media plus split text', async () => {
  const original = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      return { ok: false, description: 'rich rejected' };
    };
    const message = `<b>خبر</b>\n\n${'متن کامل '.repeat(180)}\n\nمنبع: نمونه\n@IRnews24Fa`;
    const out = await context.sendNewsToDestination({}, '-1009', message, [
      { type: 'photo', value: 'photo-file-id', source: 'file_id' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(out.ok, false);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.method === 'sendRichMessage'));
  } finally {
    context.telegram = original;
  }
});

test('long exact-copy media without a safe URL preserves full text in one rich message', async () => {
  const original = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: { message_id: 904 } };
    };
    const message = `<b>خبر</b>\n\n${'متن وفادار و کامل '.repeat(140)}\n\nمنبع: نمونه\nزمان: اکنون\n@IRnews24Fa`;
    const out = await context.sendNewsToDestination({}, '-1004', message, [{
      type: 'telegram_copy', value: '@source:42', source: 'telegram',
      from_chat_id: '@source', message_id: 42, media_kind: 'photo', fallback_media: [],
    }], { send_media: 1, disable_preview: 1 });
    assert.equal(out.ok, true);
    assert.equal(out.media_sent, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
    assert.equal(calls[0].payload.rich_message.html, message);
  } finally {
    context.telegram = original;
  }
});

test('a thrown Telegram transport result is marked ambiguous and is not safe to auto-retry', async () => {
  const original = context.sendNewsToDestination;
  try {
    context.sendNewsToDestination = async () => { throw new Error('network timeout after request start'); };
    await assert.rejects(
      () => context.sendNewsWithAmbiguityGuard({}, '-1005', 'خبر', [], {}),
      (error) => error.deliveryAmbiguous === true && /timeout/.test(error.message),
    );
  } finally {
    context.sendNewsToDestination = original;
  }
});

test('Telegram 2xx malformed JSON and 5xx responses are ambiguous, never a second write', async () => {
  const originalFetch = context.fetch;
  try {
    let calls = 0;
    context.fetch = async () => { calls += 1; return new Response('not-json', { status: 200 }); };
    await assert.rejects(
      () => context.sendNewsWithAmbiguityGuard(
        { TELEGRAM_BOT_TOKEN: 'token' }, '-1006', 'خبر',
        [{ type: 'photo', value: 'file-id', source: 'file_id' }],
        { send_media: 1, disable_preview: 1 },
      ),
      (error) => error.deliveryAmbiguous === true && error.telegramAmbiguous === true,
    );
    assert.equal(calls, 1);

    await assert.rejects(
      () => context.parseTelegramApiResponse(new Response(JSON.stringify({ ok: true }), { status: 200 }), 'sendMessage'),
      (error) => error.deliveryAmbiguous === true && /message_id/.test(error.message),
    );

    await assert.rejects(
      () => context.parseTelegramApiResponse(new Response(JSON.stringify({ ok: false }), { status: 502 }), 'sendMessage'),
      (error) => error.deliveryAmbiguous === true && /502/.test(error.message),
    );
  } finally {
    context.fetch = originalFetch;
  }
});

test('Telegram HTTP 200 with a structured rejection remains safe for a narrow fallback', async () => {
  const rejected = await context.parseTelegramApiResponse(
    new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    'sendMessage',
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.description, /parse entities/);
});

test('digest message guard marks a thrown Telegram write as ambiguous', async () => {
  const original = context.sendMessage;
  try {
    context.sendMessage = async () => { throw new Error('Too many subrequests after request start'); };
    await assert.rejects(
      () => context.sendMessageWithAmbiguityGuard({}, 1, 'بسته خبر'),
      (error) => error.deliveryAmbiguous === true && context.canSafelyDeferSubrequestLimit(error) === false,
    );
  } finally {
    context.sendMessage = original;
  }
});

test('Cron heartbeat reader reports a fresh success as healthy and a stale success as unhealthy', async () => {
  let row = null;
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                assert.match(sql, /INSERT INTO runtime_health/);
                const now = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
                row = {
                  id: 1, last_cron_at: now, last_cron_success_at: args[0] ? now : null,
                  last_cron_phase: args[1], last_cron_status: args[2], last_cron_error: args[3],
                };
                return { success: true };
              },
            };
          },
          async first() { return row; },
        };
      },
    },
  };
  await context.writeCronHeartbeat(env, 'queue', 'ok');
  const fresh = await context.readRuntimeHealth(env);
  assert.equal(fresh.healthy, true);
  assert.equal(fresh.last_phase, 'queue');
  row.last_cron_success_at = '2020-01-01 00:00:00';
  assert.equal((await context.readRuntimeHealth(env)).healthy, false);
});

test('scheduled failures persist a failed heartbeat and reject waitUntil', async () => {
  const originals = {
    initDb: context.initDb,
    runScheduledWorkPhase: context.runScheduledWorkPhase,
    writeCronHeartbeat: context.writeCronHeartbeat,
    recordDiagnosticEvent: context.recordDiagnosticEvent,
  };
  const heartbeats = [];
  let pending;
  try {
    context.initDb = async () => {};
    context.runScheduledWorkPhase = async () => { throw new Error('scheduled test failure'); };
    context.writeCronHeartbeat = async (_env, phase, status, error = '') => { heartbeats.push({ phase, status, error }); };
    context.recordDiagnosticEvent = async () => {};
    await context.__worker.scheduled({ scheduledTime: Date.parse('2026-07-21T12:00:00Z') }, {}, {
      waitUntil(promise) { pending = promise; },
    });
    await assert.rejects(pending, /scheduled test failure/);
    assert.deepEqual(heartbeats.map((item) => item.status), ['running', 'failed']);
    assert.match(heartbeats[1].error, /scheduled test failure/);
  } finally {
    Object.assign(context, originals);
  }
});

test('maintenance phase automatically resumes circuit-broken sources after cooldown', () => {
  assert.equal(typeof context.recoverAutoPausedSources, 'function');
  assert.match(source, /recoverAutoPausedSources\(env/);
  assert.match(source, /auto_paused_at[\s\S]{0,300}active=1/);
});

test('deployable Wrangler config includes the exact one-minute Cron trigger', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(Array.from(config.triggers?.crons || []), ['* * * * *']);
  assert.equal(config.main, 'worker.js');
  assert.equal(config.keep_vars, true);
});

test('/on is staged and idempotent instead of polling dozens of sources inside a webhook', () => {
  const start = source.indexOf('async function restartAutomation');
  const end = source.indexOf('async function resetBotConfiguration', start);
  const implementation = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(implementation, /processAllPollingSources|processDueNewsQueue|fetchRssItems|fetchTelegramPublicItems/);
  assert.match(source, /alreadyEnabled[\s\S]{0,300}repairRunningAutomation|repairRunningAutomation[\s\S]{0,500}alreadyEnabled/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}
if (failed) {
  console.error(`\n${failed}/${tests.length} tests failed`);
  process.exit(1);
}
console.log(`\n${tests.length}/${tests.length} tests passed`);
