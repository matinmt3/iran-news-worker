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

test('sanitizer removes bare domains and short news links from the outgoing body', () => {
  const out = context.sanitizeOutboundNewsText(
    'حمله موشکی در اطراف شهر گزارش شد.\n\nisna.ir/xdWL5N\nجزئیات در news.example.com/story/42 منتشر شد.'
  );
  assert.match(out, /حمله موشکی/);
  assert.match(out, /جزئیات در منتشر شد/);
  assert.doesNotMatch(out, /isna\.ir|example\.com|xdWL5N/i);
});

test('visual media uses Telegram default placement so media appears above its caption', async () => {
  const original = context.telegramWithHtmlFallback;
  let seen;
  context.telegramWithHtmlFallback = async (_env, method, payload, field) => {
    seen = { method, payload, field };
    return { ok: true, result: { message_id: 1 } };
  };
  await context.sendMediaReference({}, '-1001', '<b>متن خبر</b>', { type: 'video', value: 'video-id', source: 'file_id' });
  assert.equal(seen.method, 'sendVideo');
  assert.equal('show_caption_above_media' in seen.payload, false);
  context.telegramWithHtmlFallback = original;
});

test('Telegram public video post is represented by an exact copy reference, never by its thumbnail', () => {
  const html = `
    <div class="tgme_channel_info_header_title">نمونه</div>
    <div class="tgme_widget_message_wrap">
      <div class="tgme_widget_message" data-post="samplechannel/123">
        <a class="tgme_widget_message_video_player" href="https://t.me/samplechannel/123">
          <i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn.example/video-thumb.jpg')"></i>
          <time class="duration">0:42</time>
        </a>
        <div class="tgme_widget_message_text">این خبر دارای ویدیوی اصلی است</div>
        <a class="tgme_widget_message_date" href="https://t.me/samplechannel/123"><time datetime="2026-07-19T12:00:00+00:00"></time></a>
      </div>
    </div>`;
  const items = context.parseTelegramPublicPreview(html, 'samplechannel');
  assert.equal(items.length, 1);
  assert.equal(items[0].media.length, 1);
  assert.equal(items[0].media[0].type, 'telegram_copy');
  assert.equal(items[0].media[0].from_chat_id, '@samplechannel');
  assert.equal(items[0].media[0].message_id, 123);
  assert.doesNotMatch(JSON.stringify(items[0].media), /video-thumb\.jpg/);
});

test('exact Telegram copy sends the original post media with the rewritten caption in one operation', async () => {
  const originalTelegram = context.telegramWithHtmlFallback;
  const originalMessage = context.sendMessage;
  const calls = [];
  context.telegramWithHtmlFallback = async (_env, method, payload, field) => {
    calls.push({ method, payload, field });
    return { ok: true, result: { message_id: 77 } };
  };
  context.sendMessage = async () => {
    throw new Error('text must not be sent separately for a short copied media post');
  };
  const result = await context.sendNewsToDestination({}, '-1009', '<b>تیتر</b>\n\nمتن خبر', [{
    type: 'telegram_copy', value: '@samplechannel:123', source: 'telegram', from_chat_id: '@samplechannel', message_id: 123,
  }], { send_media: 1, disable_preview: 1 });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'copyMessage');
  assert.equal(calls[0].payload.from_chat_id, '@samplechannel');
  assert.equal(calls[0].payload.message_id, 123);
  assert.match(calls[0].payload.caption, /تیتر/);
  assert.equal('show_caption_above_media' in calls[0].payload, false);
  context.telegramWithHtmlFallback = originalTelegram;
  context.sendMessage = originalMessage;
});


test('failed exact video copy never falls back to a poster photo from the same preview', async () => {
  const originalTelegram = context.telegramWithHtmlFallback;
  const calls = [];
  try {
    context.telegramWithHtmlFallback = async (_env, method, payload, field) => {
      calls.push({ method, payload, field });
      if (method === 'copyMessage') return { ok: false, description: 'copy protected' };
      return { ok: true, result: { message_id: calls.length } };
    };
    const result = await context.sendNewsToDestination({}, '-1007', '<b>خبر ویدیویی</b>\n\nمتن صحیح خبر', [{
      type: 'telegram_copy',
      value: '@samplechannel:321',
      source: 'telegram',
      from_chat_id: '@samplechannel',
      message_id: 321,
      media_kind: 'video',
      fallback_media: [{ type: 'photo', value: 'https://cdn.example/poster.jpg', source: 'url' }],
    }], { send_media: 1, disable_preview: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.method), ['copyMessage', 'sendMessage']);
    assert.equal(calls.some((call) => call.method === 'sendPhoto'), false);
  } finally {
    context.telegramWithHtmlFallback = originalTelegram;
  }
});

test('adjacent Telegram posts keep their own exact message IDs and media types', () => {
  const html = `
    <div class="tgme_channel_info_header_title">نمونه</div>
    <div class="tgme_widget_message_wrap">
      <div class="tgme_widget_message" data-post="samplechannel/501">
        <a class="tgme_widget_message_video_player"><i class="tgme_widget_message_video_thumb" style="background-image:url('https://cdn.example/video-poster.jpg')"></i></a>
        <div class="tgme_widget_message_text">خبر اول با ویدیو</div>
        <a class="tgme_widget_message_date" href="https://t.me/samplechannel/501"><time datetime="2026-07-19T12:01:00+00:00"></time></a>
      </div>
    </div>
    <div class="tgme_widget_message_wrap">
      <div class="tgme_widget_message" data-post="samplechannel/502">
        <a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn.example/second-photo.jpg')"></a>
        <div class="tgme_widget_message_text">خبر دوم با عکس</div>
        <a class="tgme_widget_message_date" href="https://t.me/samplechannel/502"><time datetime="2026-07-19T12:02:00+00:00"></time></a>
      </div>
    </div>`;
  const items = context.parseTelegramPublicPreview(html, 'samplechannel');
  const first = items.find((item) => item.numericId === 501);
  const second = items.find((item) => item.numericId === 502);
  assert.equal(first.media[0].message_id, 501);
  assert.equal(first.media[0].media_kind, 'video');
  assert.doesNotMatch(JSON.stringify(first.media), /second-photo/);
  assert.equal(second.media[0].message_id, 502);
  assert.equal(second.media[0].media_kind, 'photo');
});

test('mixed Telegram grouped post preserves its real video and photo fallbacks', () => {
  const html = `
    <div class="tgme_widget_message_wrap">
      <div class="tgme_widget_message_grouped_wrap" data-post="samplechannel/700">
        <video src="https://cdn.example/video.mp4"></video>
        <a class="tgme_widget_message_grouped_layer" style="background-image:url('https://cdn.example/real-photo.jpg')"></a>
        <div class="tgme_widget_message_text">آلبوم ترکیبی</div>
        <a class="tgme_widget_message_date" href="https://t.me/samplechannel/700"></a>
      </div>
    </div>`;
  const item = context.parseTelegramPublicPreview(html, 'samplechannel')[0];
  assert.equal(item.media[0].type, 'telegram_copy');
  assert.equal(item.media[0].grouped, true);
  assert.equal(item.media[0].media_kind, 'mixed');
  assert.deepEqual(Array.from(item.media[0].fallback_media, (entry) => entry.type).sort(), ['photo', 'video']);
  assert.doesNotMatch(JSON.stringify(item.media), /video-thumb/);
});

test('media refresh runs for an empty stored list and targets the exact old Telegram post first', async () => {
  const originals = {
    exact: context.fetchTelegramPublicPostMedia,
    latest: context.fetchTelegramPublicItems,
    resolve: context.resolveDiagnosticsByScope,
  };
  const updates = [];
  let latestCalls = 0;
  try {
    context.fetchTelegramPublicPostMedia = async (reference, id) => {
      assert.equal(reference, 'samplechannel');
      assert.equal(id, 123);
      return [{ type: 'video', value: 'https://cdn.example/fresh.mp4', source: 'url' }];
    };
    context.fetchTelegramPublicItems = async () => { latestCalls += 1; throw new Error('latest page should not be needed'); };
    context.resolveDiagnosticsByScope = async () => 0;
    const env = { DB: { prepare: (sql) => ({ bind: (...args) => ({ run: async () => { updates.push({ sql, args }); return { meta: { changes: 1 } }; } }) }) } };
    const fresh = await context.refreshTelegramPublicMediaForNews({
      id: 9, source_type: 'telegram_public', source_username: 'samplechannel',
      external_id: 'tgweb:samplechannel/123', url: 'https://t.me/samplechannel/123',
    }, [], env);
    assert.equal(fresh[0].value, 'https://cdn.example/fresh.mp4');
    assert.equal(latestCalls, 0);
    assert.ok(updates.some((entry) => /UPDATE news_items SET media_json/.test(entry.sql)));
  } finally {
    context.fetchTelegramPublicPostMedia = originals.exact;
    context.fetchTelegramPublicItems = originals.latest;
    context.resolveDiagnosticsByScope = originals.resolve;
  }
});

test('failed exact video copy uses a real video fallback and reports complete media', async () => {
  const originalTelegram = context.telegramWithHtmlFallback;
  const calls = [];
  try {
    context.telegramWithHtmlFallback = async (_env, method) => {
      calls.push(method);
      if (method === 'copyMessage') return { ok: false, description: 'Bad Request: message to copy not found' };
      return { ok: true, result: { message_id: 88 } };
    };
    const result = await context.sendNewsToDestination({}, '-1007', '<b>خبر</b>\n\nمتن خبر', [{
      type: 'telegram_copy', value: '@samplechannel:321', source: 'telegram',
      from_chat_id: '@samplechannel', message_id: 321, media_kind: 'video',
      fallback_media: [{ type: 'video', value: 'video-file-id', source: 'file_id' }],
    }], { send_media: 1, disable_preview: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.media_sent, true);
    assert.equal(result.media_complete, true);
    assert.deepEqual(calls, ['copyMessage', 'sendVideo']);
  } finally {
    context.telegramWithHtmlFallback = originalTelegram;
  }
});

test('Telegram media 429 does not download/upload or publish text before retry', async () => {
  const originals = { ref: context.sendMediaReference, upload: context.fetchAndUploadMedia, message: context.sendMessage };
  let uploads = 0;
  let textCalls = 0;
  try {
    context.sendMediaReference = async () => ({ ok: false, description: 'Too Many Requests: retry after 20', parameters: { retry_after: 20 } });
    context.fetchAndUploadMedia = async () => { uploads += 1; return { ok: true }; };
    context.sendMessage = async () => { textCalls += 1; return { ok: true, result: { message_id: 1 } }; };
    const result = await context.sendNewsToDestination({}, 1, 'متن خبر', [
      { type: 'photo', value: 'https://cdn.example/photo.jpg', source: 'url' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.retry_after, 20);
    assert.equal(uploads, 0);
    assert.equal(textCalls, 0);
  } finally {
    Object.assign(context, { sendMediaReference: originals.ref, fetchAndUploadMedia: originals.upload, sendMessage: originals.message });
  }
});

test('successful visual album does not skip a remaining document', async () => {
  const originals = { group: context.sendMediaGroupReference, ref: context.sendMediaReference };
  const singles = [];
  try {
    context.sendMediaGroupReference = async () => ({ ok: true, result: [{ message_id: 1 }, { message_id: 2 }] });
    context.sendMediaReference = async (_env, _chat, _caption, item) => {
      singles.push(item.type);
      return { ok: true, result: { message_id: 3 } };
    };
    const result = await context.sendNewsToDestination({}, 1, 'متن خبر', [
      { type: 'photo', value: 'photo-1', source: 'file_id' },
      { type: 'photo', value: 'photo-2', source: 'file_id' },
      { type: 'document', value: 'document-1', source: 'file_id' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.media_complete, true);
    assert.equal(result.media_sent_count, 3);
    assert.deepEqual(singles, ['document']);
  } finally {
    context.sendMediaGroupReference = originals.group;
    context.sendMediaReference = originals.ref;
  }
});

test('media-group result count mismatch is protocol-ambiguous', async () => {
  const original = context.telegram;
  try {
    context.telegram = async () => ({ ok: true, result: [{ message_id: 1 }] });
    await assert.rejects(
      () => context.sendMediaGroupReference({}, 1, '', [
        { type: 'photo', value: 'p1', source: 'file_id' },
        { type: 'photo', value: 'p2', source: 'file_id' },
      ]),
      (error) => error.deliveryAmbiguous === true && /expected 2/.test(error.message),
    );
  } finally {
    context.telegram = original;
  }
});

test('long text preserves a non-Rich document as a residual file', async () => {
  const originals = { rich: context.sendRichNewsMessage, ref: context.sendMediaReference };
  const calls = [];
  try {
    context.sendRichNewsMessage = async () => ({ ok: true, result: { message_id: 70 }, rich_media_count: 0 });
    context.sendMediaReference = async (_env, _chat, caption, item) => {
      calls.push({ caption, type: item.type });
      return { ok: true, result: { message_id: 71 } };
    };
    const result = await context.sendNewsToDestination({}, 1, 'متن کامل '.repeat(150), [
      { type: 'document', value: 'document-id', source: 'file_id' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.media_sent, true);
    assert.equal(result.media_complete, true);
    assert.equal(result.media_sent_count, 1);
    assert.deepEqual(calls, [{ caption: '', type: 'document' }]);
  } finally {
    context.sendRichNewsMessage = originals.rich;
    context.sendMediaReference = originals.ref;
  }
});

test('long Rich URL failure retries as one multipart Rich message', async () => {
  const originals = { rich: context.sendRichNewsMessage, upload: context.fetchAndUploadRichNewsMessage };
  let richCalls = 0;
  let uploadCalls = 0;
  try {
    context.sendRichNewsMessage = async () => { richCalls += 1; return { ok: false, description: 'failed to get HTTP URL content' }; };
    context.fetchAndUploadRichNewsMessage = async () => { uploadCalls += 1; return { ok: true, result: { message_id: 44 }, rich_media_count: 1 }; };
    const result = await context.sendNewsToDestination({}, 1, 'متن کامل '.repeat(150), [
      { type: 'photo', value: 'https://cdn.example/photo.jpg', source: 'url' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.media_complete, true);
    assert.equal(richCalls, 1);
    assert.equal(uploadCalls, 1);
  } finally {
    context.sendRichNewsMessage = originals.rich;
    context.fetchAndUploadRichNewsMessage = originals.upload;
  }
});

test('Rich success counts only attached safe media and reports skipped unsafe media', async () => {
  const original = context.telegram;
  try {
    let attached = 0;
    context.telegram = async (_env, method, payload) => {
      assert.equal(method, 'sendRichMessage');
      attached = payload.rich_message.media.length;
      return { ok: true, result: { message_id: 45 } };
    };
    const result = await context.sendNewsToDestination({}, 1, 'متن کامل '.repeat(150), [
      { type: 'photo', value: 'safe-file-id', source: 'file_id' },
      { type: 'photo', value: 'http://127.0.0.1/private.jpg', source: 'url' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(result.ok, true);
    assert.equal(attached, 1);
    assert.equal(result.media_sent_count, 1);
    assert.equal(result.media_expected_count, 2);
    assert.equal(result.media_complete, false);
    assert.match(result.media_error, /unsafe|invalid|ناامن|نامعتبر/i);
  } finally {
    context.telegram = original;
  }
});

test('multipart Rich upload skips a broken URL but still sends later valid media', async () => {
  const originals = {
    fetchPublicResource: context.fetchPublicResource,
    readResponseBlobLimited: context.readResponseBlobLimited,
    telegramMultipart: context.telegramMultipart,
  };
  const fetched = [];
  try {
    context.fetchPublicResource = async (url) => {
      fetched.push(url);
      if (url.includes('/bad.jpg')) return { response: new Response('', { status: 404 }), finalUrl: url };
      return { response: new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } }), finalUrl: url };
    };
    context.readResponseBlobLimited = async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    context.telegramMultipart = async () => ({ ok: true, result: { message_id: 72 } });
    const result = await context.fetchAndUploadRichNewsMessage({}, 1, 'متن کامل', [
      { type: 'photo', value: 'https://cdn.example/bad.jpg', source: 'url' },
      { type: 'photo', value: 'https://cdn.example/good.jpg', source: 'url' },
    ], {});
    assert.equal(result.ok, true);
    assert.equal(result.rich_media_count, 1);
    assert.match(result.rich_media_error, /404/);
    assert.deepEqual(fetched, ['https://cdn.example/bad.jpg', 'https://cdn.example/good.jpg']);
  } finally {
    Object.assign(context, originals);
  }
});

test('long Rich media 429 never falls through to a text-only publication', async () => {
  const original = context.sendRichNewsMessage;
  let calls = 0;
  try {
    context.sendRichNewsMessage = async () => { calls += 1; return { ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } }; };
    const result = await context.sendNewsToDestination({}, 1, 'متن کامل '.repeat(150), [
      { type: 'photo', value: 'photo-id', source: 'file_id' },
    ], { send_media: 1, disable_preview: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.retry_after, 30);
    assert.equal(calls, 1);
  } finally {
    context.sendRichNewsMessage = original;
  }
});
test('live self-test treats missing ADMIN_SECRET as a safe warning and accepts Telegram-valid webhook secrets', async () => {
  class Stmt {
    constructor(sql) { this.sql = sql; }
    bind() { return this; }
    async first() {
      const q = this.sql.toLowerCase();
      if (q.includes('select 1')) return { ok: 1 };
      if (q.includes('count(*)')) return { count: 0 };
      return null;
    }
    async all() { return { results: [] }; }
    async run() { return { meta: { changes: 1 } }; }
  }
  const env = {
    DB: { prepare: (sql) => new Stmt(sql) }, OWNER_ID: '100', TELEGRAM_BOT_TOKEN: 'token',
    WEBHOOK_SECRET: 'valid_short-secret', ADMIN_SECRET: '', AI_PROVIDER_ORDER: 'cloudflare',
    CLOUDFLARE_AI_MODEL: '@cf/zai-org/glm-4.7-flash', AI: { run: async () => ({ response: 'OK' }) },
  };
  context.telegram = async (_env, method) => {
    if (method === 'getMe') return { ok: true, result: { id: 10, username: 'bot' } };
    if (method === 'getWebhookInfo') return { ok: true, result: { url: 'https://example.workers.dev/webhook', pending_update_count: 0 } };
    throw new Error(`unexpected ${method}`);
  };
  const result = await context.runOwnerLiveSelfTest('100', env);
  const runtime = result.checks.find((item) => item.key === 'runtime');
  assert.equal(runtime.ok, true, runtime.detail);
  assert.match(runtime.detail, /هشدار.*ADMIN_SECRET/i);
  assert.doesNotMatch(runtime.detail, /تنظیم ناقص:.*WEBHOOK_SECRET/);
});


test('AI self-test converts a slow live probe into a warning-backed success when recent usage exists', async () => {
  const originalCheck = context.checkWorkersAiBinding;
  try {
    context.checkWorkersAiBinding = async () => new Promise(() => {});
    class Stmt {
      bind() { return this; }
      async first() {
        return { successful_calls: 2, last_used_at: new Date().toISOString(), last_status: 'ok' };
      }
    }
    const env = {
      DB: { prepare: () => new Stmt() }, AI_PROVIDER_ORDER: 'cloudflare',
      AI: { run: async () => ({ response: 'OK' }) }, CLOUDFLARE_AI_MODEL: '@cf/zai-org/glm-4.7-flash',
    };
    const result = await Promise.race([
      context.checkActiveAiPathForSelfTest(env, { probeTimeoutMs: 10 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('helper ignored its bounded timeout')), 250)),
    ]);
    assert.equal(result.ok, true);
    assert.match(result.detail, /پاسخ زنده کند بود|آخرین استفاده موفق/);
  } finally {
    context.checkWorkersAiBinding = originalCheck;
  }
});
test('live self-test uses the provider-specific lightweight AI health path instead of full generation', async () => {
  assert.equal(typeof context.checkActiveAiPathForSelfTest, 'function');
  const originalAiGenerate = context.aiGenerate;
  const originalCheck = context.checkWorkersAiBinding;
  context.aiGenerate = async () => { throw new Error('full generation must not be used by live self-test'); };
  context.checkWorkersAiBinding = async () => ({ provider: 'cloudflare', ok: true, status: 'healthy', model: '@cf/test/model' });
  const result = await context.checkActiveAiPathForSelfTest({
    AI_PROVIDER_ORDER: 'cloudflare', AI: { run: async () => ({ response: 'OK' }) }, CLOUDFLARE_AI_MODEL: '@cf/test/model',
  });
  assert.equal(result.ok, true);
  assert.match(result.detail, /cloudflare/i);
  context.aiGenerate = originalAiGenerate;
  context.checkWorkersAiBinding = originalCheck;
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
