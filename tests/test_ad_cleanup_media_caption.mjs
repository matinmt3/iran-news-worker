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
const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();

test('outbound sanitizer removes embedded links handles and promotional boilerplate', () => {
  const input = `وزارت اقتصاد اعلام کرد نرخ جدید از فردا اجرا می‌شود.\n\n` +
    `<a href="https://ads.example/buy">برای خرید ویژه کلیک کنید</a>\n` +
    `منبع: @cheap_products\n` +
    `عضویت در کانال: https://t.me/cheap_products\n` +
    `جزئیات رسمی در https://news.example/report منتشر شد.`;
  const out = context.sanitizeOutboundNewsText(input);
  assert.match(out, /وزارت اقتصاد اعلام کرد/);
  assert.match(out, /جزئیات رسمی در منتشر شد/);
  assert.doesNotMatch(out, /https?:\/\//i);
  assert.doesNotMatch(out, /@cheap_products/i);
  assert.doesNotMatch(out, /خرید ویژه|عضویت در کانال|^منبع:/im);
});

test('outbound sanitizer keeps factual sentences that begin with an informed source', () => {
  const out = context.sanitizeOutboundNewsText('منبع آگاه اعلام کرد جلسه فردا برگزار می‌شود.');
  assert.match(out, /منبع آگاه اعلام کرد/);
});

test('outbound sanitizer keeps useful anchor and markdown labels but removes their URLs', () => {
  const input = `طبق <a href="https://example.com/report">گزارش رسمی</a> تصمیم اجرا شد.\n` +
    `متن کامل در [اطلاعیه وزارتخانه](https://example.com/notice) آمده است.`;
  const out = context.sanitizeOutboundNewsText(input);
  assert.match(out, /گزارش رسمی/);
  assert.match(out, /اطلاعیه وزارتخانه/);
  assert.doesNotMatch(out, /https?:\/\//i);
});

test('fallback transformation cleans advertising remnants from summary and body', () => {
  const transformed = context.fallbackTransform({
    title: 'بانک مرکزی نرخ جدید را اعلام کرد',
    body: 'بانک مرکزی نرخ جدید را اعلام کرد.\nمنبع: @ads_channel\nبرای عضویت https://t.me/ads_channel',
  }, {
    category_mode: 'all_news', selected_categories: ['economy'], min_importance: 0,
    strict_news_filter: 0, content_mode: 'full',
  });
  assert.match(transformed.summary, /بانک مرکزی/);
  assert.doesNotMatch(transformed.summary, /@|https?:\/\//i);
  assert.doesNotMatch(transformed.body, /@|https?:\/\//i);
});

test('template-controlled source link remains available after body cleanup', () => {
  const values = {
    title: context.sanitizeOutboundNewsText('خبر مهم'),
    summary: context.sanitizeOutboundNewsText('جزئیات https://ads.example/promo'),
    body: '', source: 'خبرگزاری رسمی', url: 'https://official.example/story', date: '',
  };
  const out = context.applyTemplate('{summary}\n<a href="{url}">{source}</a>', values, { show_source: 1, show_link: 1, show_date: 0 });
  assert.doesNotMatch(out, /ads\.example/);
  assert.match(out, /href="https:\/\/official\.example\/story"/);
});

test('short video news is delivered as one video with caption and no separate text message', async () => {
  const originalRef = context.sendMediaReference;
  const originalMessage = context.sendMessage;
  let caption = '';
  let textCalls = 0;
  context.sendMediaReference = async (_env, _chat, value) => {
    caption = value;
    return { ok: true, result: { message_id: 11 } };
  };
  context.sendMessage = async () => {
    textCalls += 1;
    return { ok: true, result: { message_id: 12 } };
  };
  const out = await context.sendNewsToDestination({}, 1, '<b>تیتر خبر</b>\n\nمتن خبر', [{ type: 'video', value: 'video-id', source: 'file_id' }], { send_media: 1, disable_preview: 1 });
  assert.equal(out.ok, true);
  assert.match(caption, /تیتر خبر/);
  assert.equal(textCalls, 0);
  context.sendMediaReference = originalRef;
  context.sendMessage = originalMessage;
});

test('long video news keeps media and complete text in one rich message', async () => {
  const originalTelegram = context.telegram;
  const calls = [];
  try {
    context.telegram = async (_env, method, payload) => {
      calls.push({ method, payload });
      return { ok: true, result: { message_id: 21 } };
    };
    const message = Array.from({ length: 360 }, (_, i) => `بخش${i}`).join(' ');
    const out = await context.sendNewsToDestination({}, 1, message, [{ type: 'video', value: 'video-id', source: 'file_id' }], { send_media: 1, disable_preview: 1 });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'sendRichMessage');
    assert.equal(compact(calls[0].payload.rich_message.html).endsWith(compact(message)), true);
    assert.equal(calls[0].payload.rich_message.media.length, 1);
  } finally {
    context.telegram = originalTelegram;
  }
});

test('audio albums do not receive unsupported visual caption placement flag', async () => {
  const original = context.telegram;
  let seen;
  context.telegram = async (_env, method, payload) => {
    seen = { method, payload };
    return { ok: true, result: [{ message_id: 40 }, { message_id: 41 }] };
  };
  await context.sendMediaGroupReference({}, 1, 'متن خبر', [
    { type: 'audio', value: 'audio-1', source: 'file_id' },
    { type: 'audio', value: 'audio-2', source: 'file_id' },
  ]);
  assert.equal(seen.method, 'sendMediaGroup');
  assert.equal('show_caption_above_media' in seen.payload.media[0], false);
  context.telegram = original;
});

test('video payload asks Telegram to display the caption with the media', async () => {
  const original = context.telegramWithHtmlFallback;
  let seen;
  context.telegramWithHtmlFallback = async (env, method, payload, field) => {
    seen = { env, method, payload, field };
    return { ok: true, result: { message_id: 31 } };
  };
  await context.sendMediaReference({}, 1, 'متن خبر', { type: 'video', value: 'video-id', source: 'file_id' });
  assert.equal(seen.method, 'sendVideo');
  assert.equal('show_caption_above_media' in seen.payload, false);
  context.telegramWithHtmlFallback = original;
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
