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
  setTimeout,
  clearTimeout,
  fetch: async () => { throw new Error('unexpected fetch'); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'worker.js' });

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
function jsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

// A) Static/module invariants (15)
test('module exposes fetch handler', () => assert.equal(typeof context.__worker.fetch, 'function'));
test('module exposes scheduled handler', () => assert.equal(typeof context.__worker.scheduled, 'function'));
test('version includes faithful translation and always-on recovery', () => assert.match(source, /2\.10\.3-faithful-always-on/));
test('Telegram token is not hardcoded', () => assert.ok(!/\d{8,12}:[A-Za-z0-9_-]{25,}/.test(source)));
test('Gemini key is not hardcoded', () => assert.ok(!/AIza[A-Za-z0-9_-]{25,}/.test(source)));
test('worker uses D1 binding', () => assert.match(source, /env\.DB/));
test('worker has webhook secret verification', () => assert.match(source, /X-Telegram-Bot-Api-Secret-Token/));
test('worker has cron scheduled handler', () => assert.match(source, /async scheduled/));
test('worker has template save readback verification', () => assert.match(source, /ذخیره قالب در دیتابیس تأیید نشد/));
test('worker has exact fingerprint dedupe', () => assert.match(source, /exact_fingerprint/));
test('worker does not expose dead isAlreadySent helper', () => assert.equal(typeof context.isAlreadySent, 'undefined'));
test('public URL normalizer exists', () => assert.equal(typeof context.normalizePublicHttpUrl, 'function'));
test('private hostname detector exists', () => assert.equal(typeof context.isPrivateHostname, 'function'));
test('template builder exists', () => assert.equal(typeof context.buildTemplateFromFields, 'function'));
test('destination channel picker exists', () => assert.equal(typeof context.destinationChannelPickerKeyboard, 'function'));

// A2) Source priority feature
for (const [input, expected] of [[1,1],[2,2],[3,3],[4,4],[5,5],[0,3],[6,3],['bad',3],[null,3]]) {
  test(`source priority normalization ${String(input)} -> ${expected}`, () => assert.equal(context.normalizeSourcePriority(input), expected));
}
test('source priority labels are distinct', () => {
  const labels = [1,2,3,4,5].map((v) => context.sourcePriorityLabel(v));
  assert.equal(new Set(labels).size, 5);
  assert.match(labels[4], /فوری/);
});
test('source priority keyboard exposes five levels', () => {
  const kb = context.sourcePriorityKeyboard(42, 4);
  const flat = kb.inline_keyboard.flat();
  const setters = flat.filter((b) => String(b.callback_data || '').startsWith('source_priority_set:42:'));
  assert.equal(setters.length, 5);
  assert.ok(setters.some((b) => b.callback_data === 'source_priority_set:42:4' && b.text.includes('✅')));
});
test('main keyboard exposes source priority menu', () => {
  const flat = context.mainKeyboard(false, true).inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === 'source_priority_menu'));
});
test('source schema includes priority default', () => assert.match(source, /priority INTEGER NOT NULL DEFAULT 3/));
test('source migration includes priority', () => assert.match(source, /\["priority", "priority INTEGER NOT NULL DEFAULT 3"\]/));
test('source priority index is created after migrations', () => assert.match(source, /CREATE INDEX IF NOT EXISTS idx_sources_priority/));
test('polling prevents starvation while retaining priority as a due-time tie breaker', () => assert.match(source, /ORDER BY COALESCE\(s\.next_poll_at, '1970-01-01'\) ASC, COALESCE\(s\.priority, 3\) DESC/));
test('delivery queue orders high priority first', () => assert.match(source, /ORDER BY COALESCE\(s\.priority, 3\) DESC, d\.scheduled_at ASC/));
test('reset restores normal source priority', () => assert.match(source, /send_media=-1, priority=3/));
test('source list is ordered by priority', () => assert.match(source, /SELECT \* FROM sources WHERE user_id = \? ORDER BY COALESCE\(priority, 3\) DESC/));

// B) Template field normalization - all 64 subsets
const fields = ['title', 'summary', 'body', 'source', 'url', 'date'];
for (let mask = 0; mask < 64; mask++) {
  test(`template field normalization subset ${mask}`, () => {
    const input = fields.filter((_, i) => mask & (1 << i));
    const out = Array.from(context.normalizeTemplateFields(input));
    assert.ok(out.some((f) => ['title', 'summary', 'body'].includes(f)));
    assert.equal(new Set(out).size, out.length);
    const indexes = out.map((f) => fields.indexOf(f));
    assert.deepEqual(indexes, [...indexes].sort((a,b) => a-b));
  });
}

// C) Template builder and validator combinations (36)
const templateCombos = [
  ['title'], ['summary'], ['body'], ['title','summary'], ['title','body'], ['summary','body'],
  ['title','source'], ['title','url'], ['title','date'], ['title','summary','source','url','date'],
  ['summary','source','url'], ['body','source','date'], ['title','summary','body','source','url','date'],
];
for (const style of ['classic','breaking','minimal','editorial']) {
  for (const combo of templateCombos) {
    test(`template ${style} ${combo.join('+')}`, () => {
      const tpl = context.buildTemplateFromFields(combo, style);
      const validation = context.validateTemplate(tpl);
      assert.equal(validation.ok, true, validation.errors?.join(' | '));
      assert.ok(/\{(?:title|summary|body)\}/.test(tpl));
      if (combo.includes('title') && ['breaking','editorial'].includes(style)) assert.equal(context.detectTemplateStyle(tpl), style);
    });
  }
}

const invalidTemplates = [
  ['', /خالی/],
  ['<b>فقط ثابت</b>', /حداقل یکی/],
  ['{unknown}', /ناشناخته/],
  ['<script>{title}</script>', /غیرمجاز/],
  ['<b>{title}', /بسته نشده/],
  ['</b>{title}', /درست بسته/],
  ['<a>{title}</a>', /href معتبر/],
  ['<a href="javascript:alert(1)">{title}</a>', /href معتبر/],
  ['<b>{title}</i>', /درست بسته/],
  ['<b>{title}</b> A & B', /&amp;/],
  ['<b>{title}</b> < raw', /علامت‌های/],
  ['x'.repeat(3801) + '{title}', /۳۸۰۰/],
];
for (const [tpl, pattern] of invalidTemplates) {
  test(`invalid template ${String(tpl).slice(0,30)}`, () => {
    const r = context.validateTemplate(tpl);
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), pattern);
  });
}

// D) Template rendering/settings (20)
const sampleValues = { title: '<تیتر & خبر>', summary: 'خلاصه & بیشتر', body: 'بدنه <x>', source: 'منبع & خبر', url: 'https://example.com/?a=1&b=2', date: '1405/04/26' };
test('applyTemplate escapes title', () => assert.match(context.applyTemplate('{title}', sampleValues), /&lt;تیتر &amp; خبر&gt;/));
test('applyTemplate escapes summary', () => assert.match(context.applyTemplate('{summary}', sampleValues), /خلاصه &amp; بیشتر/));
test('applyTemplate escapes body', () => assert.match(context.applyTemplate('{body}', sampleValues), /بدنه &lt;x&gt;/));
test('applyTemplate escapes URL ampersand', () => assert.match(context.applyTemplate('<a href="{url}">{title}</a>', sampleValues), /&amp;/));
test('applyTemplate hides source', () => assert.ok(!context.applyTemplate('<b>{title}</b>\nمنبع: {source}', sampleValues, {show_source:0}).includes('منبع &')));
test('applyTemplate hides date', () => assert.ok(!context.applyTemplate('<b>{title}</b>\nزمان: {date}', sampleValues, {show_date:0}).includes('1405')));
test('applyTemplate hides link', () => assert.ok(!context.applyTemplate('<a href="{url}">{title}</a>', sampleValues, {show_link:0}).includes('href=')));
test('applyTemplate adds footer', () => assert.match(context.applyTemplate('{title}', sampleValues, {show_footer:1,footer_text:'@IRnews24Fa'}), /https:\/\/t\.me\/IRnews24Fa/));
test('applyTemplate does not add disabled footer', () => assert.ok(!context.applyTemplate('{title}', sampleValues, {show_footer:0,footer_text:'@IRnews24Fa'}).includes('IRnews24Fa')));
test('formatFooterText links Telegram username', () => assert.equal(context.formatFooterText('@IRnews24Fa'), '<a href="https://t.me/IRnews24Fa">@IRnews24Fa</a>'));
test('formatFooterText links public URL', () => assert.match(context.formatFooterText('https://example.com'), /<a href=/));
test('formatFooterText keeps punctuation outside URL', () => {
  const out=context.formatFooterText('خبر: https://example.com/test.');
  assert.match(out, /test<\/a>\.$/);
});
test('formatFooterText blocks private URL link', () => assert.ok(!context.formatFooterText('http://127.0.0.1/a').includes('<a href=')));
test('truncate HTML decodes existing entities before escaping', () => {
  const out=context.truncateTelegramHtml('<b>A &amp; B</b>' + 'x'.repeat(50), 10);
  assert.ok(!out.includes('&amp;amp;'));
});
test('truncate plain text exact boundary', () => assert.equal(context.truncatePlainText('abcd',4),'abcd'));
test('truncate plain text adds ellipsis', () => assert.equal(context.truncatePlainText('abcdef',4),'ab…'));
test('removeTemplateLines removes matching line', () => assert.equal(context.removeTemplateLines('a\n{date}\nb',['{date}']),'a\nb'));
test('extractTemplateFields finds source and URL', () => jsonEqual(Array.from(context.extractTemplateFields('{title} {source} {url}')), ['title','source','url']));
test('template style detects breaking', () => assert.equal(context.detectTemplateStyle('🔴 <b>{title}</b>'),'breaking'));
test('template style detects editorial', () => assert.equal(context.detectTemplateStyle('🗞 <b>{title}</b>'),'editorial'));

// E) Date normalization/freshness (28)
const dateCases = [
  ['2026-07-17T10:00:00Z','2026-07-17T10:00:00.000Z'],
  ['2026-07-17 10:00:00','2026-07-17T10:00:00.000Z'],
  ['2026-07-17T10:00','2026-07-17T10:00:00.000Z'],
  ['2026-07-17T10:00:00+03:30','2026-07-17T06:30:00.000Z'],
  [1784282400,'2026-07-17T10:00:00.000Z'],
  [1784282400000,'2026-07-17T10:00:00.000Z'],
  ['1784282400','2026-07-17T10:00:00.000Z'],
  ['1784282400000','2026-07-17T10:00:00.000Z'],
];
for (const [input, expected] of dateCases) test(`normalizeNewsDate ${input}`, () => assert.equal(context.normalizeNewsDate(input),expected));
for (const bad of [null,undefined,'','not-a-date','1999-12-31T00:00:00Z','2101-01-01T00:00:00Z',-1,9999999999999999]) {
  test(`reject invalid date ${String(bad)}`, () => assert.equal(context.normalizeNewsDate(bad),null));
}
test('itemTimestamp valid', () => assert.equal(context.itemTimestamp({date:'2026-07-17T10:00:00Z'}),1784282400000));
test('itemTimestamp invalid is zero', () => assert.equal(context.itemTimestamp({date:'x'}),0));
test('freshness accepts equal start time', () => assert.equal(context.isItemAfterAutomationStart({date:'2026-07-17T10:00:00Z'},{automation_started_at:'2026-07-17T10:00:00Z'}).ok,true));
test('freshness accepts after start', () => assert.equal(context.isItemAfterAutomationStart({date:'2026-07-17T10:01:00Z'},{automation_started_at:'2026-07-17T10:00:00Z'}).ok,true));
test('freshness rejects before start', () => assert.equal(context.isItemAfterAutomationStart({date:'2026-07-17T09:59:59Z'},{automation_started_at:'2026-07-17T10:00:00Z'}).ok,false));
test('freshness rejects missing item date when started', () => assert.equal(context.isItemAfterAutomationStart({date:null},{automation_started_at:'2026-07-17T10:00:00Z'}).ok,false));
test('freshness allows missing start', () => assert.equal(context.isItemAfterAutomationStart({date:'2026-07-17T10:00:00Z'},{automation_started_at:null}).ok,true));
test('formatOutputDate invalid returns dash', () => assert.equal(context.formatOutputDate('bad'),' -'.trim()));
test('formatOutputDate applies +210 offset', () => assert.match(context.formatOutputDate('2026-07-17T10:00:00Z','en',210), /13:30/));
test('formatOutputDate applies zero offset', () => assert.match(context.formatOutputDate('2026-07-17T10:00:00Z','en',0), /10:00/));
test('valid clock 00:00', () => assert.equal(context.isValidClock('00:00'),true));
test('valid clock 23:59', () => assert.equal(context.isValidClock('23:59'),true));
for (const bad of ['24:00','23:60','1:00','aa:bb','']) test(`invalid clock ${bad}`, () => assert.equal(context.isValidClock(bad),false));

// F) URL/SSRF protection (36)
const privateHosts = ['','localhost','x.localhost','router.local','service.internal','127.0.0.1','127.1.2.3','10.0.0.1','172.16.0.1','172.31.255.255','192.168.1.1','169.254.10.1','100.64.0.1','100.127.255.255','198.18.0.1','198.19.255.255','0.0.0.0','224.0.0.1','255.255.255.255','::','::1','fc00::1','fd12::1','fe80::1','::ffff:127.0.0.1'];
for (const host of privateHosts) test(`private hostname blocked ${host}`, () => assert.equal(context.isPrivateHostname(host),true));
for (const host of ['example.com','8.8.8.8','1.1.1.1','172.15.0.1','172.32.0.1','100.63.0.1','100.128.0.1','2001:4860:4860::8888']) test(`public hostname allowed ${host}`, () => assert.equal(context.isPrivateHostname(host),false));
const allowedUrls = ['https://example.com','http://example.com/feed','https://8.8.8.8/path?q=1'];
for (const u of allowedUrls) test(`public URL accepted ${u}`, () => assert.ok(context.normalizePublicHttpUrl(u).startsWith(u.split('?')[0])));
const blockedUrls = ['','ftp://example.com/a','javascript:alert(1)','http://localhost/a','http://127.0.0.1/a','http://[::1]/a','https://user:pass@example.com/a','not a url'];
for (const u of blockedUrls) test(`unsafe URL blocked ${u}`, () => assert.equal(context.normalizePublicHttpUrl(u),''));
test('numeric IPv4 localhost is blocked by URL canonicalization', () => assert.equal(context.normalizePublicHttpUrl('http://2130706433/'),''));
test('hex IPv4 localhost is blocked by URL canonicalization', () => assert.equal(context.normalizePublicHttpUrl('http://0x7f000001/'),''));
test('normalizeMediaUrl blocks private URL', () => assert.equal(context.normalizeMediaUrl('http://10.0.0.1/x.jpg'),''));
test('normalizeMediaUrl decodes amp entity', () => assert.match(context.normalizeMediaUrl('https://example.com/x?a=1&amp;b=2'), /a=1&b=2/));

// G) HTML/entity/text processing (22)
const entityCases = [
  ['&amp;','&'], ['&AMP;','&'], ['&lt;','<'], ['&gt;','>'], ['&quot;','"'], ['&apos;',"'"], ['&nbsp;',' '],
  ['&#65;','A'], ['&#x41;','A'], ['&#x1F600;','😀'], ['&#99999999;','�'], ['&#55296;','�'],
];
for (const [input, expected] of entityCases) test(`decode entity ${input}`, () => assert.equal(context.decodeHtmlEntities(input),expected));
test('escapeHtml escapes all core characters', () => assert.equal(context.escapeHtml('&<>"'), '&amp;&lt;&gt;&quot;'));
test('stripHtml removes script', () => assert.ok(!context.stripHtml('<script>x</script>hello').includes('x')));
test('stripHtml removes style', () => assert.ok(!context.stripHtml('<style>x</style>hello').includes('x')));
test('cleanText decodes and compacts', () => assert.equal(context.cleanText('  A&nbsp;  B '),'A B'));
test('htmlFragmentToText preserves line breaks', () => assert.equal(context.htmlFragmentToText('A<br>B</div>C'),'A\nB\nC'));
test('cleanJsonText removes JSON fence', () => assert.equal(context.cleanJsonText('```json\n{"a":1}\n```'),' {"a":1}'.trim()));
test('stripCdata removes wrapper', () => assert.equal(context.stripCdata('<![CDATA[x]]>'),'x'));
test('firstNonEmptyLine picks first text', () => assert.equal(context.firstNonEmptyLine('\n  \nhello\nworld'),'hello'));
test('firstNonEmptyLine fallback', () => assert.equal(context.firstNonEmptyLine(''),'خبر جدید'));

// H) Telegram source/reference validation (28)
const goodRefs = [
  ['@ExampleChannel','examplechannel'], ['ExampleChannel','examplechannel'], ['https://t.me/ExampleChannel','examplechannel'],
  ['https://t.me/s/ExampleChannel','examplechannel'], ['https://telegram.me/ExampleChannel/123','examplechannel'],
];
for (const [input, expected] of goodRefs) test(`extract Telegram username ${input}`, () => assert.equal(context.extractTelegramUsername(input),expected));
for (const input of ['@a','a','https://example.com/x','https://t.me/ab','@bad-name','']) test(`reject Telegram username ${input}`, () => assert.equal(context.extractTelegramUsername(input),''));
for (const input of ['@ExampleChannel','ExampleChannel','https://t.me/ExampleChannel','-100123456789']) test(`looksLikeTelegramSource true ${input}`, () => assert.equal(context.looksLikeTelegramSource(input),true));
for (const input of ['@a','abc','https://example.com','']) test(`looksLikeTelegramSource false ${input}`, () => assert.equal(context.looksLikeTelegramSource(input),false));
test('normalize chat numeric', () => assert.equal(context.normalizeChatReference('-100123'),'-100123'));
test('normalize chat username', () => assert.equal(context.normalizeChatReference('@ExampleChannel'),'@examplechannel'));
test('normalize chat URL', () => assert.equal(context.normalizeChatReference('https://t.me/ExampleChannel'),'@examplechannel'));
test('normalize chat empty', () => assert.equal(context.normalizeChatReference(''),''));
test('normalize chat invalid', () => assert.equal(context.normalizeChatReference('bad-name'),''));
test('request id is positive integer', () => {const x=context.randomRequestId(); assert.ok(Number.isInteger(x)&&x>0)});
test('random ID requested length', () => assert.equal(context.randomId(24).length,24));
test('picker keyboard requests channel', () => assert.equal(context.destinationChannelPickerKeyboard(99).keyboard[0][0].request_chat.chat_is_channel,true));
test('picker keyboard requests post right', () => assert.equal(context.destinationChannelPickerKeyboard(99).keyboard[0][0].request_chat.bot_administrator_rights.can_post_messages,true));
test('picker keyboard avoids destructive rights', () => assert.equal(context.destinationChannelPickerKeyboard(99).keyboard[0][0].request_chat.bot_administrator_rights.can_delete_messages,false));
test('remove reply keyboard shape', () => assert.equal(context.removeReplyKeyboard().remove_keyboard,true));

// I) Destination access matrix (16)
const accessCases = [
  ['channel creator bot', {type:'channel'}, {status:'creator'}, {status:'creator'}, true],
  ['channel admin with post', {type:'channel'}, {status:'administrator',can_post_messages:true}, {status:'administrator'}, true],
  ['channel admin no post', {type:'channel'}, {status:'administrator',can_post_messages:false}, {status:'administrator'}, false],
  ['channel bot member only', {type:'channel'}, {status:'member'}, {status:'administrator'}, false],
  ['owner not admin', {type:'channel'}, {status:'administrator',can_post_messages:true}, {status:'member'}, false],
  ['group bot member', {type:'group'}, {status:'member'}, {status:'administrator'}, true],
  ['supergroup bot admin', {type:'supergroup'}, {status:'administrator'}, {status:'creator'}, true],
  ['group bot left', {type:'group'}, {status:'left'}, {status:'administrator'}, false],
  ['invalid private chat', {type:'private'}, {status:'administrator'}, {status:'administrator'}, false],
  ['missing chat', null, {status:'administrator'}, {status:'administrator'}, false],
];
for (const [name, chat, bot, owner, ok] of accessCases) test(`destination access ${name}`, () => assert.equal(context.validateDestinationAccess(chat,bot,owner).ok,ok));
for (const [status, expected] of [['creator',true],['administrator',true],['member',true],['restricted',true],['left',false],['kicked',false]]) {
  test(`usable destination member ${status}`, () => assert.equal(context.isUsableDestinationMember({status}),expected));
}

// J) Media normalization and extraction (28)
const mediaCases = [
  [{type:'photo',value:'abc',source:'file_id'},'photo:id:abc'],
  [{type:'animation',value:'abc',source:'file_id'},'video:id:abc'],
  [{type:'video',value:'https://example.com/a.mp4?utm_source=x&id=1#x',source:'url'},'video:url:https://example.com/a.mp4?id=1'],
];
for (const [m, expected] of mediaCases) test(`canonical media ${expected}`, () => assert.equal(context.canonicalMediaKey(m),expected));
test('media list removes exact duplicate', () => assert.equal(context.normalizeMediaList([{type:'photo',value:'x'},{type:'photo',value:'x'}]).length,1));
test('animation and video same ID dedupe', () => assert.equal(context.normalizeMediaList([{type:'animation',value:'x'},{type:'video',value:'x'}]).length,1));
test('media list ignores incomplete', () => assert.equal(context.normalizeMediaList([{type:'photo'},{value:'x'},null]).length,0));
test('media list caps ten', () => assert.equal(context.normalizeMediaList(Array.from({length:15},(_,i)=>({type:'photo',value:String(i)}))).length,10));
test('Telegram API picks largest photo', () => assert.equal(context.extractTelegramApiMedia({photo:[{file_id:'a'},{file_id:'b'}]})[0].value,'b'));
test('Telegram API prioritizes video', () => assert.equal(context.extractTelegramApiMedia({video:{file_id:'v'},photo:[{file_id:'p'}]})[0].type,'video'));
test('Telegram API supports animation', () => assert.equal(context.extractTelegramApiMedia({animation:{file_id:'a'}})[0].type,'animation'));
test('Telegram API supports document', () => assert.equal(context.extractTelegramApiMedia({document:{file_id:'d'}})[0].type,'document'));
test('Telegram API empty media', () => assert.equal(context.extractTelegramApiMedia({}).length,0));
test('web media chooses video over thumbnail', () => {
  const html='<video src="https://example.com/v.mp4"></video><i class="tgme_widget_message_video_thumb" style="background-image:url(https://example.com/t.jpg)"></i>';
  const out=context.extractTelegramWebMedia(html); assert.equal(out.length,1); assert.equal(out[0].type,'video');
});
test('web media rejects private URL', () => assert.equal(context.extractTelegramWebMedia('<video src="http://127.0.0.1/v.mp4"></video>').length,0));
test('RSS enclosure video', () => assert.equal(context.extractRssMedia('<enclosure url="https://example.com/v.mp4" type="video/mp4"/>')[0].type,'video'));
test('RSS enclosure image', () => assert.equal(context.extractRssMedia('<enclosure url="https://example.com/x.jpg" type="image/jpeg"/>')[0].type,'photo'));
test('RSS private media rejected', () => assert.equal(context.extractRssMedia('<enclosure url="http://10.0.0.1/x.jpg" type="image/jpeg"/>').length,0));
for (const [type, expected] of [['photo','sendPhoto'],['video','sendVideo'],['animation','sendAnimation'],['document','sendDocument']]) test(`media method ${type}`, () => assert.equal(context.mediaMethod(type),expected));
for (const [type,url,expected] of [['photo','x.png','image/png'],['photo','x.webp','image/webp'],['photo','x.jpg','image/jpeg'],['video','x','video/mp4'],['animation','x','video/mp4'],['document','x','application/octet-stream']]) test(`guess mime ${type} ${url}`, () => assert.equal(context.guessMediaMime(type,url),expected));

// K) RSS/Atom/Telegram parsing (16)
const rss=`<?xml version="1.0"?><rss><channel><title>Feed Name</title><item><title><![CDATA[Title 1]]></title><link>https://example.com/1</link><description><![CDATA[<p>Body 1</p>]]></description><pubDate>Fri, 17 Jul 2026 10:00:00 GMT</pubDate><guid>g1</guid></item></channel></rss>`;
test('parse RSS one item', () => assert.equal(context.parseFeed(rss,'https://example.com/rss').length,1));
test('parse RSS title', () => assert.equal(context.parseFeed(rss,'https://example.com/rss')[0].title,'Title 1'));
test('parse RSS body', () => assert.match(context.parseFeed(rss,'https://example.com/rss')[0].body,/Body 1/));
test('parse RSS source', () => assert.equal(context.parseFeed(rss,'https://example.com/rss')[0].source,'Feed Name'));
test('parse RSS date normalized', () => assert.equal(context.parseFeed(rss,'https://example.com/rss')[0].date,'2026-07-17T10:00:00.000Z'));
const atom=`<feed><title>Atom</title><entry><title>Atom title</title><link href="/post/1"/><summary>Atom body</summary><updated>2026-07-17T10:00:00Z</updated><id>a1</id></entry></feed>`;
test('parse Atom item', () => assert.equal(context.parseFeed(atom,'https://example.com/feed')[0].title,'Atom title'));
test('parse Atom relative URL', () => assert.equal(context.parseFeed(atom,'https://example.com/feed')[0].url,'https://example.com/post/1'));
test('parse empty feed', () => assert.equal(context.parseFeed('<rss><channel></channel></rss>','https://example.com/rss').length,0));
const tgHtml=`<div class="tgme_channel_info_header_title">Test Channel</div><div class="tgme_widget_message_wrap"><div data-post="TestChan/42"><div class="tgme_widget_message_text">Hello<br>World</div><a class="tgme_widget_message_date" href="https://t.me/TestChan/42"><time datetime="2026-07-17T10:00:00Z"></time></a></div></div>`;
test('parse Telegram preview item', () => assert.equal(context.parseTelegramPublicPreview(tgHtml,'TestChan').length,1));
test('parse Telegram preview ID', () => assert.equal(context.parseTelegramPublicPreview(tgHtml,'TestChan')[0].id,'tgweb:TestChan/42'));
test('parse Telegram preview body', () => assert.equal(context.parseTelegramPublicPreview(tgHtml,'TestChan')[0].body,'Hello\nWorld'));
test('parse Telegram preview source', () => assert.equal(context.parseTelegramPublicPreview(tgHtml,'TestChan')[0].source,'Test Channel'));
test('parse Telegram preview date', () => assert.equal(context.parseTelegramPublicPreview(tgHtml,'TestChan')[0].date,'2026-07-17T10:00:00.000Z'));
test('parse Telegram preview empty', () => assert.equal(context.parseTelegramPublicPreview('<html></html>','TestChan').length,0));
test('Telegram activity label empty', () => assert.match(context.telegramActivityLabel([]),/غیرفعال/));
test('Telegram activity label active', () => assert.ok(typeof context.telegramActivityLabel([{date:new Date().toISOString()}])==='string'));

// L) Filters/dedupe/scheduling (30)
test('parse filter tags dedupes', () => jsonEqual(Array.from(context.parseFilterTags('#Iran, iran،News')),['iran','news']));
test('positive filter passes', () => assert.equal(context.passesSourceHashtagFilters({include_tags:'iran',exclude_tags:''},'Iran news').ok,true));
test('positive filter rejects', () => assert.equal(context.passesSourceHashtagFilters({include_tags:'iran',exclude_tags:''},'World news').ok,false));
test('negative filter rejects', () => assert.equal(context.passesSourceHashtagFilters({include_tags:'',exclude_tags:'ads'},'This is ADS').ok,false));
test('negative filter wins over positive', () => assert.equal(context.passesSourceHashtagFilters({include_tags:'iran',exclude_tags:'ads'},'Iran ads').ok,false));
test('normalize dedupe strips URL', () => assert.equal(context.normalizeForDedupe('Hello https://x.com A!'),'hello a'));
test('token similarity identical', () => assert.equal(context.tokenSimilarity('alpha beta gamma','alpha beta gamma'),1));
test('token similarity disjoint', () => assert.equal(context.tokenSimilarity('alpha beta','gamma delta'),0));
test('token similarity ignores short tokens', () => assert.equal(context.tokenSimilarity('a bb','a bb'),0));
test('approval source override on', () => assert.equal(context.resolveApprovalMode({approval_mode:1},{approval_mode:0}),1));
test('approval source override off', () => assert.equal(context.resolveApprovalMode({approval_mode:0},{approval_mode:1}),0));
test('approval inherits', () => assert.equal(context.resolveApprovalMode({approval_mode:-1},{approval_mode:1}),1));
test('publication inherits', () => assert.equal(context.resolvePublicationMode({publication_mode:'inherit'},{publication_mode:'interval_15'}),'interval_15'));
test('publication source override', () => assert.equal(context.resolvePublicationMode({publication_mode:'immediate'},{publication_mode:'interval_15'}),'immediate'));
for (const [mode,label] of [['immediate','فوری'],['interval_15','۱۵'],['interval_30','۳۰'],['morning_digest','صبح'],['evening_digest','شب'],['inherit','ارث']]) test(`publication label ${mode}`, () => assert.match(context.publicationModeLabel(mode),new RegExp(label)));
test('next local hour same day', () => assert.equal(context.nextLocalHour(20,210,new Date('2026-07-17T10:00:00Z')).toISOString(),'2026-07-17T16:30:00.000Z'));
test('next local hour next day', () => assert.equal(context.nextLocalHour(8,210,new Date('2026-07-17T10:00:00Z')).toISOString(),'2026-07-18T04:30:00.000Z'));
test('quiet hours normal inside moves to end', () => assert.equal(context.adjustForQuietHours(new Date('2026-07-17T08:00:00Z'),'10:00','14:00',210).toISOString(),'2026-07-17T10:30:00.000Z'));
test('quiet hours normal outside unchanged', () => assert.equal(context.adjustForQuietHours(new Date('2026-07-17T12:00:00Z'),'10:00','14:00',210).toISOString(),'2026-07-17T12:00:00.000Z'));
test('quiet hours overnight evening moves next morning', () => assert.equal(context.adjustForQuietHours(new Date('2026-07-17T20:00:00Z'),'22:00','07:00',210).toISOString(),'2026-07-18T03:30:00.000Z'));
test('compute immediate schedule unchanged', () => assert.equal(context.computeDeliverySchedule('immediate',{timezone_offset_minutes:210,quiet_start:'',quiet_end:'',min_interval_minutes:0},{min_interval_minutes:-1},{min_interval_minutes:0,last_sent_at:null},new Date('2026-07-17T10:00:00Z')).toISOString(),'2026-07-17T10:00:00.000Z'));
test('compute interval respects last sent', () => assert.equal(context.computeDeliverySchedule('interval_15',{timezone_offset_minutes:210,quiet_start:'',quiet_end:'',min_interval_minutes:0},{min_interval_minutes:-1},{min_interval_minutes:0,last_sent_at:'2026-07-17T09:55:00Z'},new Date('2026-07-17T10:00:00Z')).toISOString(),'2026-07-17T10:10:00.000Z'));
test('compute destination interval dominates', () => assert.equal(context.computeDeliverySchedule('immediate',{timezone_offset_minutes:210,quiet_start:'',quiet_end:'',min_interval_minutes:0},{min_interval_minutes:-1},{min_interval_minutes:30,last_sent_at:'2026-07-17T09:50:00Z'},new Date('2026-07-17T10:00:00Z')).toISOString(),'2026-07-17T10:20:00.000Z'));

// M) License and UI (24)
test('owner has access', () => assert.equal(context.hasAccess({is_owner:1}),true));
test('permanent has access', () => assert.equal(context.hasAccess({is_owner:0,license_permanent:1}),true));
test('future license has access', () => assert.equal(context.hasAccess({is_owner:0,license_permanent:0,license_expires_at:new Date(Date.now()+60000).toISOString()}),true));
test('expired license denied', () => assert.equal(context.hasAccess({is_owner:0,license_permanent:0,license_expires_at:new Date(Date.now()-60000).toISOString()}),false));
test('missing license denied', () => assert.equal(context.hasAccess({is_owner:0,license_permanent:0,license_expires_at:null}),false));
test('invalid license denied', () => assert.equal(context.hasAccess({is_owner:0,license_permanent:0,license_expires_at:'bad'}),false));
test('owner label', () => assert.match(context.licenseStatusLabel({is_owner:1}),/مالک/));
test('permanent label', () => assert.match(context.licenseStatusLabel({license_permanent:1}),/دائمی/));
test('expired label', () => assert.match(context.licenseStatusLabel({license_expires_at:new Date(Date.now()-60000).toISOString()}),/منقضی/));
test('isOwner true', () => assert.equal(context.isOwner({is_owner:1}),true));
test('isOwner false', () => assert.equal(context.isOwner({is_owner:0}),false));
test('automation keyboard on state has off button', () => assert.ok(JSON.stringify(context.automationKeyboard(true)).includes('خاموش')));
test('automation keyboard off state has on button', () => assert.ok(JSON.stringify(context.automationKeyboard(false)).includes('روشن')));
test('main keyboard owner includes owner panel', () => assert.ok(JSON.stringify(context.mainKeyboard(true,true)).includes('پنل مالک')));
test('main keyboard nonowner excludes owner panel', () => assert.ok(!JSON.stringify(context.mainKeyboard(false,true)).includes('پنل مالک')));
test('template menu shows override clear when count positive', () => assert.ok(JSON.stringify(context.templateMenuKeyboard(2)).includes('پاک‌کردن')));
test('template menu hides override clear when zero', () => assert.ok(!JSON.stringify(context.templateMenuKeyboard(0)).includes('قالب اختصاصی 0')));
test('template builder keyboard has save global', () => assert.ok(JSON.stringify(context.templateBuilderKeyboard(['title'],'classic')).includes('tpl_save_global')));
test('template builder keyboard has save all', () => assert.ok(JSON.stringify(context.templateBuilderKeyboard(['title'],'classic')).includes('tpl_save_all')));
test('template builder keyboard marks selected', () => assert.ok(JSON.stringify(context.templateBuilderKeyboard(['title'],'classic')).includes('✅ تیتر')));
test('settings language keyboard has Persian', () => assert.ok(JSON.stringify(context.languageKeyboard()).includes('فارسی')));
test('help keyboard has templates', () => assert.ok(JSON.stringify(context.helpKeyboard()).includes('قالب')));
test('reset confirmation keyboard has confirm', () => assert.ok(JSON.stringify(context.resetConfirmationKeyboard()).includes('ریست شود')));
test('back keyboard targets main menu', () => assert.equal(context.backKeyboard().inline_keyboard[0][0].callback_data,'main_menu'));

// N) Utility/security outputs and route behavior (24)
for (const [a,b,expected] of [['secret','secret',true],['secret','secreT',false],['','',false],['a','aa',false],[null,'x',false]]) test(`safeEqual ${String(a)} ${String(b)}`, () => assert.equal(context.safeEqual(a,b),expected));
test('parse JSON valid', () => jsonEqual(context.parseJson('{"a":1}',{}),{a:1}));
test('parse JSON invalid fallback', () => jsonEqual(context.parseJson('bad',{x:1}),{x:1}));
test('parse state data valid object', () => jsonEqual(context.parseStateData('{"request_id":1}'),{request_id:1}));
test('parse state data invalid empty object', () => jsonEqual(context.parseStateData('bad'),{}));
test('text response content type', () => assert.match(context.text('x').headers.get('content-type'),/text\/plain/));
test('json response content type', () => assert.match(context.json({a:1}).headers.get('content-type'),/application\/json/));
test('root endpoint returns ok', async () => {
  const r=await context.__worker.fetch(new Request('https://bot.workers.dev/'),{},{}); const b=await r.json(); assert.equal(b.ok,true); assert.equal(b.version,'2.10.3-faithful-always-on.4');
});
test('unknown endpoint is 404', async () => assert.equal((await context.__worker.fetch(new Request('https://bot.workers.dev/nope'),{},{})).status,404));
test('setup rejects query-secret GET requests', async () => assert.equal((await context.__worker.fetch(new Request('https://bot.workers.dev/setup?key=x'),{WEBHOOK_SECRET:'y'},{})).status,405));
test('run rejects query-secret GET requests', async () => assert.equal((await context.__worker.fetch(new Request('https://bot.workers.dev/run?key=x'),{WEBHOOK_SECRET:'y'},{})).status,405));
test('setup rejects wrong admin header', async () => assert.equal((await context.__worker.fetch(new Request('https://bot.workers.dev/setup',{method:'POST',headers:{'X-Admin-Key':'wrong'}}),{ADMIN_SECRET:'a'.repeat(32)},{})).status,403));
test('webhook rejects wrong secret', async () => assert.equal((await context.__worker.fetch(new Request('https://bot.workers.dev/webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{WEBHOOK_SECRET:'y'},{waitUntil(){}})).status,403));
test('webhook rejects malformed JSON', async () => assert.equal((await context.__worker.fetch(new Request('https://bot.workers.dev/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'y','content-type':'application/json'},body:'bad'}),{WEBHOOK_SECRET:'y'},{waitUntil(){}})).status,400));
test('webhook valid schedules processing', async () => {let p=null; const r=await context.__worker.fetch(new Request('https://bot.workers.dev/webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'y','content-type':'application/json'},body:'{"update_id":1}'}),{WEBHOOK_SECRET:'y'},{waitUntil(x){p=x;}}); assert.equal(r.status,200); assert.ok(p&&typeof p.then==='function'); p.catch(()=>{});});
test('Telegram entity error recognized', () => assert.equal(context.isTelegramEntityError({description:"Bad Request: can't parse entities"}),true));
test('non entity error not recognized', () => assert.equal(context.isTelegramEntityError({description:'Too Many Requests'}),false));
test('admin status creator', () => assert.equal(context.isAdminStatus('creator'),true));
test('admin status administrator', () => assert.equal(context.isAdminStatus('administrator'),true));
test('admin status member false', () => assert.equal(context.isAdminStatus('member'),false));
test('publication unknown returns input', () => assert.equal(context.publicationModeLabel('custom'),'custom'));
test('template field unknown label returns itself', () => assert.equal(context.templateFieldLabel('x'),'x'));
test('output date unknown language falls back', () => assert.notEqual(context.formatOutputDate('2026-07-17T10:00:00Z','xx',0),'-'));
test('media invalid returns unsupported', async () => {const r=await context.sendMediaReference({},1,'',{type:'x',value:'y'}); assert.equal(r.ok,false)});

// O) Async Telegram sending/fallback/media safety (12)
test('telegram requires token', async () => await assert.rejects(() => context.telegram({},'getMe',{}),/TELEGRAM_BOT_TOKEN/));
test('sendMessage retries plain text after entity error', async () => {
  const calls=[]; context.fetch=async (_u,o)=>{const p=JSON.parse(o.body); calls.push(p); return new Response(JSON.stringify(calls.length===1?{ok:false,description:"can't parse entities"}:{ok:true,result:{message_id:1}}),{status:200,headers:{'content-type':'application/json'}})};
  const r=await context.sendMessage({TELEGRAM_BOT_TOKEN:'t'},1,'<b>bad',undefined,false); assert.equal(r.ok,true); assert.equal(calls.length,2); assert.equal('parse_mode' in calls[1],false);
});
test('send media reference video sets streaming', async () => {
  let payload; context.fetch=async (_u,o)=>{payload=JSON.parse(o.body); return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{status:200,headers:{'content-type':'application/json'}})};
  await context.sendMediaReference({TELEGRAM_BOT_TOKEN:'t'},1,'cap',{type:'video',value:'fileid'}); assert.equal(payload.supports_streaming,true);
});
test('fetch upload blocks private URL before fetch', async () => {
  let called=false; context.fetch=async()=>{called=true; throw new Error('should not')}; const r=await context.fetchAndUploadMedia({TELEGRAM_BOT_TOKEN:'t'},1,'',{type:'photo',value:'http://127.0.0.1/x'}); assert.equal(r.ok,false); assert.equal(called,false);
});
test('fetch RSS blocks private URL before fetch', async () => {
  let called=false; context.fetch=async()=>{called=true; throw new Error('should not')}; await assert.rejects(()=>context.fetchRssItems('http://10.0.0.1/rss'),/عمومی/); assert.equal(called,false);
});
test('discover feed blocks private URL before fetch', async () => {
  let called=false; context.fetch=async()=>{called=true; throw new Error('should not')}; await assert.rejects(()=>context.discoverFeed('http://127.0.0.1'),/عمومی/); assert.equal(called,false);
});
test('discover feed accepts direct RSS', async () => {
  context.fetch=async()=>new Response('<rss><channel></channel></rss>',{status:200,headers:{'content-type':'application/rss+xml'}}); Object.defineProperty(Response.prototype,'url',{configurable:true,get(){return 'https://example.com/rss'}}); const r=await context.discoverFeed('https://example.com/rss'); assert.equal(r,'https://example.com/rss'); delete Response.prototype.url;
});
test('fetch and upload rejects oversized declared media', async () => {
  context.fetch=async()=>new Response('x',{status:200,headers:{'content-length':String(11*1024*1024),'content-type':'image/jpeg'}}); const r=await context.fetchAndUploadMedia({TELEGRAM_BOT_TOKEN:'t'},1,'',{type:'photo',value:'https://example.com/x.jpg'}); assert.equal(r.ok,false); assert.match(r.description,/large/);
});
test('answer callback suppresses Telegram failures', async () => {context.fetch=async()=>{throw new Error('network')}; await context.answerCallback({TELEGRAM_BOT_TOKEN:'t'},'x')});
test('sendNews falls back to text when media all fail', async () => {
  const a=context.sendMediaReference,b=context.fetchAndUploadMedia,c=context.sendMessage; context.sendMediaReference=async()=>({ok:false}); context.fetchAndUploadMedia=async()=>({ok:false}); context.sendMessage=async()=>({ok:true,result:{message_id:9}}); const r=await context.sendNewsToDestination({},1,'text',[{type:'photo',value:'x'}],{send_media:1,disable_preview:1}); assert.equal(r.ok,true); context.sendMediaReference=a; context.fetchAndUploadMedia=b; context.sendMessage=c;
});
test('sendNews skips media when disabled', async () => {
  const c=context.sendMessage; let called=0; context.sendMessage=async()=>{called++; return {ok:true,result:{message_id:1}}}; const r=await context.sendNewsToDestination({},1,'text',[{type:'photo',value:'x'}],{send_media:0,disable_preview:1}); assert.equal(r.ok,true); assert.equal(called,1); context.sendMessage=c;
});
test('media filename preserves extension', () => assert.match(context.mediaFileName('photo','image/jpeg','https://example.com/a.jpg'),/\.jpg$/));

const settled = [];
for (const entry of tests) {
  try {
    await entry.fn();
    settled.push({ name: entry.name, ok: true });
  } catch (error) {
    settled.push({ name: entry.name, ok: false, error: error.stack || String(error) });
  }
}
const failed = settled.filter((r) => !r.ok);
for (const r of settled) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  if (!r.ok) console.error(r.error);
}
console.log(`\nTOTAL: ${settled.length} | PASSED: ${settled.length-failed.length} | FAILED: ${failed.length}`);
if (failed.length) process.exit(1);
