import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const workerPath = new URL('../worker.js', import.meta.url);
let source = fs.readFileSync(workerPath, 'utf8');
source = source.replace('export default {', 'globalThis.__worker = {');

const context = {
  console,
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
  Date,
  Intl,
  JSON,
  Math,
  RegExp,
  String,
  Number,
  Boolean,
  Array,
  Object,
  Set,
  Map,
  Promise,
  Error,
  TypeError,
  Uint8Array,
  Uint32Array,
  AbortController,
  Blob,
  FormData,
  Response,
  Request,
  Headers,
  ReadableStream,
  setTimeout,
  clearTimeout,
  fetch: async () => { throw new Error('unexpected fetch'); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'worker.js' });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function same(actual, expected) { assert.equal(JSON.stringify(actual), JSON.stringify(expected)); }

// Static hardening invariants
for (const [name, predicate] of [
  ['version 2.10.3 faithful always-on', () => /2\.10\.3-faithful-always-on/.test(source)],
  ['manual redirect helper exists', () => typeof context.fetchPublicResource === 'function'],
  ['limited body reader exists', () => typeof context.readResponseBytesLimited === 'function'],
  ['stale processing recovery exists', () => typeof context.recoverStaleProcessing === 'function'],
  ['Gemini key is sent by header', () => /x-goog-api-key/.test(source)],
  ['Gemini key is absent from URL query', () => !/generateContent\?key=/.test(source)],
  ['RSS uses safe redirect helper', () => /fetchPublicResource\(safeFeedUrl/.test(source)],
  ['media uses safe redirect helper', () => /fetchPublicResource\(safeMediaUrl/.test(source)],
  ['digest updates are conditional on processing', () => /WHERE id=\? AND status='processing'/.test(source)],
  ['equal quiet hours explicitly disabled', () => /if \(s === e\) return date/.test(source)],
]) test(name, () => assert.equal(predicate(), true));

// Public URL normalization and resolving: 80+ tests
for (let i = 1; i <= 50; i++) {
  test(`public hostname accepted ${i}`, () => {
    const input = `https://news${i}.example.com/path/${i}?q=${i}`;
    const out = context.normalizePublicHttpUrl(input);
    assert.equal(out, input);
  });
}
for (let i = 1; i <= 20; i++) {
  test(`relative public URL resolves ${i}`, () => {
    const out = context.resolvePublicHttpUrl(`../feed-${i}.xml`, `https://site${i}.example.com/news/page`);
    assert.equal(out, `https://site${i}.example.com/feed-${i}.xml`);
  });
}
const privateUrls = [
  'http://127.0.0.1/a','http://127.1.2.3/a','http://10.0.0.1/a','http://10.255.255.255/a',
  'http://172.16.0.1/a','http://172.31.255.255/a','http://192.168.1.1/a','http://169.254.1.1/a',
  'http://100.64.0.1/a','http://100.127.255.255/a','http://198.18.0.1/a','http://198.19.255.255/a',
  'http://0.0.0.0/a','http://224.0.0.1/a','http://255.255.255.255/a','http://localhost/a',
  'http://x.localhost/a','http://router.local/a','http://service.internal/a','http://[::1]/a',
  'http://[fc00::1]/a','http://[fd00::1]/a','http://[fe80::1]/a','http://[::ffff:127.0.0.1]/a',
];
for (const url of privateUrls) test(`private URL blocked ${url}`, () => assert.equal(context.normalizePublicHttpUrl(url), ''));
const unsafeUrls = [
  'javascript:alert(1)','data:text/html,x','file:///etc/passwd','ftp://example.com/a','mailto:x@example.com',
  'https://user:pass@example.com/a','//example.com/a','not a url','','   ','http://[bad::ip]/a',
];
for (const url of unsafeUrls) test(`unsafe URL rejected ${url || '<empty>'}`, () => assert.equal(context.normalizePublicHttpUrl(url), ''));

// Redirect safety and behavior
for (let chainLength = 0; chainLength <= 8; chainLength++) {
  test(`safe redirect chain length ${chainLength}`, async () => {
    let calls = 0;
    context.fetch = async (url, options) => {
      assert.equal(options.redirect, 'manual');
      const n = calls++;
      if (n < chainLength) return new Response('', { status: 302, headers: { location: `/step-${n + 1}` } });
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    const result = await context.fetchPublicResource('https://example.com/start', {}, { maxRedirects: 10, timeoutMs: 5000 });
    assert.equal(result.redirects, chainLength);
    assert.equal(calls, chainLength + 1);
    assert.equal(result.finalUrl, chainLength ? `https://example.com/step-${chainLength}` : 'https://example.com/start');
  });
}
test('redirect to private address is blocked before second fetch', async () => {
  let calls = 0;
  context.fetch = async () => {
    calls += 1;
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  };
  await assert.rejects(() => context.fetchPublicResource('https://example.com/start'), /private|invalid/i);
  assert.equal(calls, 1);
});
test('redirect without location is rejected', async () => {
  context.fetch = async () => new Response('', { status: 302 });
  await assert.rejects(() => context.fetchPublicResource('https://example.com/start'), /Location/i);
});
test('too many redirects rejected', async () => {
  context.fetch = async () => new Response('', { status: 302, headers: { location: '/again' } });
  await assert.rejects(() => context.fetchPublicResource('https://example.com/start', {}, { maxRedirects: 2 }), /Too many redirects/i);
});
test('redirect credentials are blocked', async () => {
  context.fetch = async () => new Response('', { status: 302, headers: { location: 'https://user:pass@example.com/x' } });
  await assert.rejects(() => context.fetchPublicResource('https://example.com/start'), /private|invalid/i);
});

// Bounded response reading: 70+ tests
for (let size = 0; size <= 64; size++) {
  test(`bounded text reader accepts ${size} bytes`, async () => {
    const payload = 'x'.repeat(size);
    const response = new Response(payload, { headers: { 'content-length': String(size), 'content-type': 'text/plain' } });
    const out = await context.readResponseTextLimited(response, 64, 'test');
    assert.equal(out, payload);
  });
}
test('bounded reader rejects oversized declared length', async () => {
  const response = new Response('small', { headers: { 'content-length': '999' } });
  await assert.rejects(() => context.readResponseTextLimited(response, 20, 'payload'), /too large/i);
});
test('bounded reader rejects oversized streamed body', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('12345'));
      controller.enqueue(new TextEncoder().encode('67890'));
      controller.close();
    },
  });
  const response = new Response(stream);
  await assert.rejects(() => context.readResponseTextLimited(response, 8, 'payload'), /too large/i);
});
test('bounded blob preserves content type', async () => {
  const response = new Response('abc', { headers: { 'content-type': 'image/jpeg' } });
  const blob = await context.readResponseBlobLimited(response, 10, 'blob');
  assert.equal(blob.size, 3);
  assert.equal(blob.type, 'image/jpeg');
});

// Media content type matrix
const mimeCases = [
  ['photo','image/jpeg',true],['photo','image/png',true],['photo','image/webp',true],['photo','image/gif',true],
  ['photo','image/svg+xml',false],['photo','text/html',false],['photo','application/json',false],['photo','video/mp4',false],
  ['video','video/mp4',true],['video','video/webm',true],['video','application/octet-stream',true],['video','text/html',false],
  ['video','image/jpeg',false],['animation','image/gif',true],['animation','video/mp4',true],['animation','application/octet-stream',true],
  ['animation','image/png',false],['document','application/pdf',true],['document','application/zip',true],['document','image/jpeg',true],
  ['document','text/html',false],['document','application/json',false],['document','application/xml',false],['document','text/xml',false],
  ['unknown','application/octet-stream',false],
];
for (const [type,mime,expected] of mimeCases) test(`media MIME ${type} ${mime}`, () => assert.equal(context.isAcceptableMediaContentType(type,mime),expected));

// Quiet-hours invariants and edge cases
for (let hour = 0; hour < 24; hour++) {
  test(`equal quiet hours disabled at hour ${hour}`, () => {
    const d = new Date(Date.UTC(2026, 6, 17, hour, 30));
    const out = context.adjustForQuietHours(d, '00:00', '00:00', 0);
    assert.equal(out.toISOString(), d.toISOString());
  });
}
for (let hour = 1; hour <= 22; hour++) {
  test(`normal quiet interval moves hour ${hour}`, () => {
    const d = new Date(Date.UTC(2026, 6, 17, hour, 0));
    const out = context.adjustForQuietHours(d, '01:00', '23:00', 0);
    assert.equal(out.getUTCHours(), 23);
  });
}
for (const hour of [23,0,1,2,3,4,5,6]) {
  test(`overnight quiet interval moves hour ${hour}`, () => {
    const d = new Date(Date.UTC(2026, 6, 17, hour, 0));
    const out = context.adjustForQuietHours(d, '23:00', '07:00', 0);
    assert.equal(out.getUTCHours(), 7);
    assert.ok(out > d);
  });
}

// RSS/Atom URL sanitization and parser resilience
for (let i = 1; i <= 30; i++) {
  test(`RSS relative link safely resolves ${i}`, () => {
    const xml = `<rss><channel><title>T</title><item><title>N${i}</title><link>/news/${i}</link><guid>g${i}</guid><description>D</description><pubDate>Fri, 17 Jul 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const items = context.parseFeed(xml, 'https://example.com/feed.xml');
    assert.equal(items[0].url, `https://example.com/news/${i}`);
  });
}
for (let i = 1; i <= 20; i++) {
  test(`RSS private link falls back to feed ${i}`, () => {
    const xml = `<rss><channel><title>T</title><item><title>N</title><link>http://127.0.0.${i}/secret</link><guid>g${i}</guid><description>D</description></item></channel></rss>`;
    const items = context.parseFeed(xml, 'https://example.com/feed.xml');
    assert.equal(items[0].url, 'https://example.com/feed.xml');
  });
}
const malformedLinks = ['http://[bad','javascript:alert(1)','data:text/html,x','https://user:pass@example.com/x','::::','\u0000','file:///etc/passwd'];
for (const link of malformedLinks) {
  test(`RSS malformed link does not crash ${JSON.stringify(link)}`, () => {
    const xml = `<rss><channel><item><title>N</title><link><![CDATA[${link}]]></link><guid>x-${Math.random()}</guid><description>D</description></item></channel></rss>`;
    const items = context.parseFeed(xml, 'https://example.com/feed.xml');
    assert.equal(items.length, 1);
    const expected = link === '::::' ? 'https://example.com/::::' : 'https://example.com/feed.xml';
    assert.equal(items[0].url, expected);
  });
}

// Template URL hardening
for (const bad of ['javascript:alert(1)','data:text/html,x','http://127.0.0.1/a','file:///tmp/a','https://user:pass@example.com/a','']) {
  test(`template strips unsafe URL ${bad || '<empty>'}`, () => {
    const out = context.applyTemplate('<a href="{url}">{title}</a>', { title:'T', url:bad }, { show_link:1 });
    assert.equal(out.includes('href='), false);
    assert.match(out, /T/);
  });
}
test('template retains safe URL', () => {
  const out = context.applyTemplate('<a href="{url}">{title}</a>', { title:'T', url:'https://example.com/a?x=1&y=2' }, { show_link:1 });
  assert.match(out, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
});

// Media fallback preserves text on the first successful media, not the first attempted media
test('caption moves to second media when first media fails', async () => {
  const originalRef = context.sendMediaReference;
  const originalUpload = context.fetchAndUploadMedia;
  const originalMessage = context.sendMessage;
  const captions = [];
  let calls = 0;
  context.sendMediaReference = async (_env,_chat,caption) => {
    captions.push(caption);
    calls += 1;
    return calls === 1 ? { ok:false, description:'bad media' } : { ok:true, result:{message_id:2} };
  };
  context.fetchAndUploadMedia = async () => ({ok:false,description:'upload failed'});
  let textCalls = 0;
  context.sendMessage = async () => { textCalls += 1; return {ok:true,result:{message_id:3}}; };
  const result = await context.sendNewsToDestination({},1,'hello',[{type:'animation',value:'a'},{type:'document',value:'b'}],{send_media:1,disable_preview:1});
  assert.equal(result.ok,true);
  assert.equal(result.media_complete,false);
  assert.match(result.media_error,/bad media|upload failed/);
  assert.equal(captions[0],'hello');
  assert.equal(captions[1],'hello');
  assert.equal(textCalls,0);
  context.sendMediaReference = originalRef;
  context.fetchAndUploadMedia = originalUpload;
  context.sendMessage = originalMessage;
});
test('video note sends text separately', async () => {
  const originalRef = context.sendMediaReference;
  const originalMessage = context.sendMessage;
  context.sendMediaReference = async () => ({ok:true,result:{message_id:1}});
  let text = '';
  context.sendMessage = async (_e,_c,value) => { text=value; return {ok:true,result:{message_id:2}}; };
  const result = await context.sendNewsToDestination({},1,'caption text',[{type:'video_note',value:'id'}],{send_media:1,disable_preview:1});
  assert.equal(result.ok,true);
  assert.equal(text,'caption text');
  context.sendMediaReference = originalRef;
  context.sendMessage = originalMessage;
});

// API request hardening
test('Gemini API key is only in header', async () => {
  let capturedUrl = '';
  let capturedHeaders = null;
  context.fetch = async (url, options) => {
    capturedUrl = String(url);
    capturedHeaders = options.headers;
    return new Response(JSON.stringify({ steps:[{type:'model_output',content:[{type:'text',text:'ok'}]}], usage:{total_input_tokens:1,total_output_tokens:1} }), { status:200, headers:{'content-type':'application/json'} });
  };
  const out = await context.geminiGenerate('hello', { GEMINI_API_KEY:'secret-key-123456789012345' }, false, false, null);
  assert.equal(out,'ok');
  assert.equal(capturedUrl.includes('secret-key-123456789012345'),false);
  assert.equal(capturedHeaders['x-goog-api-key'],'secret-key-123456789012345');
});
test('RSS private redirect is blocked without fetching private target', async () => {
  let calls = 0;
  context.fetch = async () => { calls += 1; return new Response('', {status:302,headers:{location:'http://10.0.0.1/feed'}}); };
  await assert.rejects(() => context.fetchRssItems('https://example.com/feed',1), /private|invalid/i);
  assert.equal(calls,1);
});
test('discoverFeed private redirect is blocked', async () => {
  let calls = 0;
  context.fetch = async () => { calls += 1; return new Response('', {status:302,headers:{location:'http://192.168.1.1/'}}); };
  await assert.rejects(() => context.discoverFeed('https://example.com'), /private|invalid/i);
  assert.equal(calls,1);
});
test('media HTML response is rejected before Telegram upload', async () => {
  context.fetch = async () => new Response('<html>bad</html>', {status:200,headers:{'content-type':'text/html'}});
  const result = await context.fetchAndUploadMedia({TELEGRAM_BOT_TOKEN:'x'},1,'',{type:'photo',value:'https://example.com/a.jpg',source:'url'});
  assert.equal(result.ok,false);
  assert.match(result.description,/content type/i);
});

// Daily report state is committed only after a successful Telegram send
function makeDailyReportDb(settings, updates) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() { return /SELECT \* FROM user_settings/.test(sql) ? {results:[settings]} : {results:[]}; },
            async first() { return {}; },
            async run() { updates.push({sql,args}); return {meta:{changes:1}}; },
          };
        },
        async all() { return /SELECT \* FROM user_settings/.test(sql) ? {results:[settings]} : {results:[]}; },
      };
    },
  };
}
test('failed daily report does not advance last_report_date', async () => {
  const offset = 0;
  const hour = new Date().getUTCHours();
  const updates = [];
  const DB = makeDailyReportDb({user_id:'1',timezone_offset_minutes:offset,daily_report_hour:hour,last_report_date:null},updates);
  const originalFetch = context.fetch;
  context.fetch = async () => new Response(JSON.stringify({ok:false,description:'blocked'}), {status:200,headers:{'content-type':'application/json'}});
  const result = await context.sendDueDailyReports({DB,TELEGRAM_BOT_TOKEN:'test-token'});
  assert.equal(result.sent,0);
  assert.equal(result.failed,1);
  assert.equal(updates.some(x => /SET\s+last_report_date\s*=/i.test(x.sql)),false);
  context.fetch = originalFetch;
});
test('successful daily report advances last_report_date', async () => {
  const hour = new Date().getUTCHours();
  const updates = [];
  const DB = makeDailyReportDb({user_id:'1',timezone_offset_minutes:0,daily_report_hour:hour,last_report_date:null},updates);
  const originalFetch = context.fetch;
  context.fetch = async () => new Response(JSON.stringify({ok:true,result:{message_id:1}}), {status:200,headers:{'content-type':'application/json'}});
  const result = await context.sendDueDailyReports({DB,TELEGRAM_BOT_TOKEN:'test-token'});
  assert.equal(result.sent,1);
  assert.equal(result.failed,0);
  assert.equal(updates.some(x => /last_report_date/.test(x.sql)),true);
  context.fetch = originalFetch;
});

// Stale processing recovery behavior
test('stale processing safely requeues only work proven to be before Telegram', async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() { return {results:[
              {id:7,news_id:9,user_id:'1',error_message:'processing:pre_telegram'},
              {id:8,news_id:10,user_id:'1',error_message:'processing:telegram_send'},
            ]}; },
            async run() { calls.push({sql,args}); return {meta:{changes:1}}; },
            async first() { return {c:0}; },
          };
        },
      };
    },
  };
  const originalFinalize = context.finalizeNewsStatus;
  const originalMetric = context.incrementMetric;
  const originalDiagnostic = context.recordDiagnosticEvent;
  const finalized = [];
  context.finalizeNewsStatus = async id => { finalized.push(id); };
  context.incrementMetric = async () => {};
  context.recordDiagnosticEvent = async () => ({});
  const result = await context.recoverStaleProcessing({DB},30);
  assert.equal(result.recovered,2);
  assert.equal(result.safeRequeued,1);
  assert.equal(result.manualFailed,1);
  assert.deepEqual(finalized,[10]);
  assert.ok(calls.some(x => /status='queued'/.test(x.sql) && x.args.includes(7)));
  assert.ok(calls.some(x => /status='failed'/.test(x.sql) && x.args.includes(8)));
  assert.match(source, /error_message='processing:pre_telegram'/);
  assert.match(source, /error_message='processing:telegram_send'/);
  context.finalizeNewsStatus = originalFinalize;
  context.incrementMetric = originalMetric;
  context.recordDiagnosticEvent = originalDiagnostic;
});

// Deterministic fuzzing for core pure functions
let seed = 0x12345678;
function rand() { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; }
for (let i = 0; i < 100; i++) {
  test(`fuzz pure helpers ${i}`, () => {
    const text = Array.from({length: 40}, () => String.fromCharCode(32 + Math.floor(rand()*90))).join('');
    const escaped = context.escapeHtml(text);
    assert.equal(/<(?![^&]*;)/.test(escaped), false);
    const normalized = context.normalizeForDedupe(text);
    assert.equal(normalized, normalized.toLowerCase());
    const priority = context.normalizeSourcePriority(Math.floor(rand()*15)-5);
    assert.ok(priority >= 1 && priority <= 5);
    const truncated = context.truncatePlainText(text, 20);
    assert.ok(truncated.length <= 20);
  });
}

let passed = 0;
const failures = [];
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log(`PASS - ${t.name}`);
  } catch (error) {
    failures.push({name:t.name,error:error?.stack || String(error)});
    console.error(`FAIL - ${t.name}\n${error?.stack || error}`);
  }
}
console.log(`\nHARDENING TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
