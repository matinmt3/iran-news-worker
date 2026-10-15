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
  Date,
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

const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => results.push({ name, ok: true })).catch((error) => {
    results.push({ name, ok: false, error: error.stack || String(error) });
  });
}

await test('channel picker requests minimal posting rights', () => {
  const keyboard = context.destinationChannelPickerKeyboard(12345);
  const req = keyboard.keyboard[0][0].request_chat;
  assert.equal(req.request_id, 12345);
  assert.equal(req.chat_is_channel, true);
  assert.equal(req.bot_administrator_rights.can_post_messages, true);
  assert.equal(req.bot_administrator_rights.can_delete_messages, false);
  assert.equal(req.bot_administrator_rights.can_promote_members, false);
  assert.equal(req.user_administrator_rights.can_promote_members, true);
  assert.equal(keyboard.one_time_keyboard, true);
});

await test('destination access rejects channel admin without post permission', () => {
  const r = context.validateDestinationAccess(
    { type: 'channel' },
    { status: 'administrator', can_post_messages: false },
    { status: 'administrator' },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /ارسال پیام/);
});

await test('destination access accepts channel admin with post permission', () => {
  const r = context.validateDestinationAccess(
    { type: 'channel' },
    { status: 'administrator', can_post_messages: true },
    { status: 'creator' },
  );
  assert.equal(r.ok, true);
});

await test('HTML truncation never leaves a partial HTML tag', () => {
  const input = '<b>' + 'الف'.repeat(5000) + '</b>';
  const out = context.truncateTelegramHtml(input, 1000);
  assert.ok(out.length <= 1000);
  assert.ok(!out.includes('<b>'));
  assert.ok(!out.endsWith('<'));
});

await test('sendMessage retries as plain text on Telegram entity errors', async () => {
  const calls = [];
  context.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    if (calls.length === 1) return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = { TELEGRAM_BOT_TOKEN: 'test-token' };
  const r = await context.sendMessage(env, 1, '<b>broken', undefined, false);
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parse_mode, 'HTML');
  assert.equal('parse_mode' in calls[1], false);
});

await test('multi-media send returns success when first media fails and second succeeds', async () => {
  const originalRef = context.sendMediaReference;
  const originalUpload = context.fetchAndUploadMedia;
  const originalMessage = context.sendMessage;
  let count = 0;
  context.sendMediaReference = async () => {
    count += 1;
    return count === 1 ? { ok: false, description: 'bad media' } : { ok: true, result: { message_id: 22 } };
  };
  context.fetchAndUploadMedia = async () => ({ ok: false, description: 'upload failed' });
  context.sendMessage = async () => ({ ok: true, result: { message_id: 23 } });
  const r = await context.sendNewsToDestination({}, 1, 'hello', [
    { type: 'photo', value: 'a', source: 'telegram' },
    { type: 'document', value: 'b', source: 'telegram' },
  ], { disable_preview: 1, send_media: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.media_complete, false);
  assert.match(r.media_error, /bad media|upload failed/);
  assert.equal(r.result.message_id, 22);
  context.sendMediaReference = originalRef;
  context.fetchAndUploadMedia = originalUpload;
  context.sendMessage = originalMessage;
});

await test('shared channel selection verifies rights and stores destination', async () => {
  const dbCalls = [];
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          dbCalls.push({ sql, args });
          return {
            async run() { return { meta: { changes: 1 } }; },
            async first() { return null; },
            async all() { return { results: [] }; },
          };
        },
      };
    },
  };
  context.fetch = async (url, options) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(options.body || '{}');
    let body;
    if (method === 'getChat') body = { ok: true, result: { id: -100555, type: 'channel', title: 'Test Channel', username: 'testchannel' } };
    else if (method === 'getMe') body = { ok: true, result: { id: 999, is_bot: true } };
    else if (method === 'getChatMember' && payload.user_id === 999) body = { ok: true, result: { status: 'administrator', can_post_messages: true } };
    else if (method === 'getChatMember') body = { ok: true, result: { status: 'creator' } };
    else if (method === 'sendMessage') body = { ok: true, result: { message_id: 1 } };
    else body = { ok: true, result: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const env = { TELEGRAM_BOT_TOKEN: 'test-token', DB };
  const user = { telegram_id: '123', state: 'request_destination_channel', state_data: JSON.stringify({ request_id: 77 }), is_owner: 1 };
  const message = { from: { id: 123 }, chat: { id: 123, type: 'private' }, chat_shared: { request_id: 77, chat_id: -100555, title: 'Test Channel', username: 'testchannel' } };
  await context.handleSharedDestination(message, user, env);
  assert.ok(dbCalls.some((c) => /INSERT INTO destination_channels/.test(c.sql)));
  const insert = dbCalls.find((c) => /INSERT INTO destination_channels/.test(c.sql));
  assert.deepEqual(insert.args.slice(0, 4), ['123', '-100555', 'testchannel', 'Test Channel']);
});

await test('my_chat_member removal deactivates stored destination', async () => {
  let updateArgs = null;
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          updateArgs = { sql, args };
          return { async run() { return { meta: { changes: 1 } }; } };
        },
      };
    },
  };
  await context.handleMyChatMemberUpdate({ chat: { id: -1001, type: 'channel' }, new_chat_member: { status: 'left' } }, { DB });
  assert.equal(updateArgs.args[0], 0);
  assert.equal(updateArgs.args[1], '-1001');
});


class TemplateMemoryDB {
  constructor() {
    this.settings = new Map();
    this.drafts = new Map();
    this.destinations = [
      { id: 1, user_id: '123', message_template: '<b>old one</b>' },
      { id: 2, user_id: '123', message_template: null },
      { id: 3, user_id: '999', message_template: '<b>other user</b>' },
    ];
  }
  prepare(sql) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    return {
      bind: (...args) => ({
        run: async () => this.run(normalized, args),
        first: async () => this.first(normalized, args),
        all: async () => this.all(normalized, args),
      }),
      run: async () => this.run(normalized, []),
      first: async () => this.first(normalized, []),
      all: async () => this.all(normalized, []),
    };
  }
  async batch(statements) {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  }
  run(sql, args) {
    if (sql.startsWith('INSERT OR IGNORE INTO user_settings')) {
      const [userId, topic, template] = args;
      if (!this.settings.has(String(userId))) this.settings.set(String(userId), {
        user_id: String(userId), topic, message_template: template,
        show_source: 1, show_link: 1, show_date: 1, show_footer: 0,
      });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE user_settings SET message_template')) {
      const [template, userId] = args;
      const row = this.settings.get(String(userId));
      if (!row) return { meta: { changes: 0 } };
      row.message_template = template;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT OR IGNORE INTO template_drafts')) {
      const [userId, fieldsJson, style] = args;
      if (!this.drafts.has(String(userId))) this.drafts.set(String(userId), { user_id: String(userId), fields_json: fieldsJson, style });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO template_drafts')) {
      const [userId, fieldsJson, style] = args;
      this.drafts.set(String(userId), { user_id: String(userId), fields_json: fieldsJson, style });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE template_drafts SET fields_json')) {
      const [fieldsJson, userId] = args;
      const row = this.drafts.get(String(userId));
      row.fields_json = fieldsJson;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE template_drafts SET style')) {
      const [style, userId] = args;
      const row = this.drafts.get(String(userId));
      row.style = style;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE destination_channels SET message_template = NULL')) {
      const [userId] = args;
      let changes = 0;
      for (const row of this.destinations) {
        if (row.user_id === String(userId) && row.message_template && row.message_template.trim()) {
          row.message_template = null;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }
    throw new Error(`Unsupported run SQL: ${sql}`);
  }
  first(sql, args) {
    if (sql.startsWith('SELECT * FROM user_settings WHERE user_id')) return this.settings.get(String(args[0])) || null;
    if (sql.startsWith('SELECT message_template FROM user_settings WHERE user_id')) {
      const row = this.settings.get(String(args[0]));
      return row ? { message_template: row.message_template } : null;
    }
    if (sql.startsWith('SELECT * FROM template_drafts WHERE user_id')) return this.drafts.get(String(args[0])) || null;
    if (sql.startsWith('SELECT COUNT(*) AS count FROM destination_channels')) {
      return { count: this.destinations.filter((row) => row.user_id === String(args[0]) && row.message_template && row.message_template.trim()).length };
    }
    throw new Error(`Unsupported first SQL: ${sql}`);
  }
  all(sql, _args) {
    if (sql.startsWith('PRAGMA table_info')) return { results: [] };
    throw new Error(`Unsupported all SQL: ${sql}`);
  }
}

await test('professional template builder creates safe classic template', () => {
  const tpl = context.buildTemplateFromFields(['title', 'summary', 'source', 'url', 'date'], 'classic');
  assert.match(tpl, /\{title\}/);
  assert.match(tpl, /href="\{url\}"/);
  assert.match(tpl, /\{date\}/);
  assert.equal(context.validateTemplate(tpl).ok, true);
});

await test('professional template builder supports all four styles', () => {
  const styles = ['classic', 'breaking', 'minimal', 'editorial'];
  const outputs = styles.map((style) => context.buildTemplateFromFields(['title', 'summary'], style));
  assert.equal(new Set(outputs).size, 4);
  for (const output of outputs) assert.equal(context.validateTemplate(output).ok, true);
});

await test('template validation rejects unknown variables and broken HTML', () => {
  const unknown = context.validateTemplate('<b>{title}</b> {unknown}');
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join(' '), /ناشناخته/);
  const broken = context.validateTemplate('<b>{title}');
  assert.equal(broken.ok, false);
  assert.match(broken.errors.join(' '), /بسته نشده/);
});

await test('template validation rejects unsafe raw ampersand in HTML mode', () => {
  const r = context.validateTemplate('<b>{title}</b> A & B');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /&amp;/);
});

await test('template validation requires a content field', () => {
  const r = context.validateTemplate('<b>منبع:</b> {source}');
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /حداقل یکی/);
});

await test('template draft choices persist in database instead of transient state', async () => {
  const DB = new TemplateMemoryDB();
  const env = { DB };
  const first = await context.ensureTemplateDraft('123', env);
  assert.ok(first.fields.includes('title'));
  await context.toggleTemplateBuilderField('123', 'body', env);
  await context.setTemplateDraftStyle('123', 'breaking', env);
  const second = await context.ensureTemplateDraft('123', env);
  assert.ok(second.fields.includes('body'));
  assert.equal(second.style, 'breaking');
});

await test('global template save is verified by reading it back', async () => {
  const DB = new TemplateMemoryDB();
  const env = { DB };
  const template = '<b>{title}</b>\n\n{summary}';
  const result = await context.saveTemplate('123', template, env);
  assert.equal(result.template, template);
  assert.equal(DB.settings.get('123').message_template, template);
  assert.equal(result.remainingOverrides, 1);
});

await test('save and apply to all clears only this users destination overrides', async () => {
  const DB = new TemplateMemoryDB();
  const env = { DB };
  const template = '<b>{title}</b>\n\n{summary}';
  const result = await context.saveTemplate('123', template, env, { applyToAllDestinations: true });
  assert.equal(result.cleared, 1);
  assert.equal(result.remainingOverrides, 0);
  assert.equal(DB.destinations.find((r) => r.id === 1).message_template, null);
  assert.equal(DB.destinations.find((r) => r.id === 3).message_template, '<b>other user</b>');
});

await test('template diagnostics validates database readback and builder state', async () => {
  const DB = new TemplateMemoryDB();
  const env = { DB };
  await context.saveTemplate('123', '<b>{title}</b>\n\n{summary}', env);
  const result = await context.runTemplateDiagnostics('123', env);
  assert.equal(result.ok, true);
  assert.equal(result.overrideCount, 1);
  assert.ok(result.previewLength > 0);
});

await test('template builder keyboard exposes preview and both save modes', () => {
  const kb = context.templateBuilderKeyboard(['title', 'summary'], 'classic');
  const callbacks = kb.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(callbacks.includes('tpl_preview_builder'));
  assert.ok(callbacks.includes('tpl_save_global'));
  assert.ok(callbacks.includes('tpl_save_all'));
});

await test('rendered template safely escapes news content', () => {
  const tpl = '<b>{title}</b>\n\n{summary}';
  const rendered = context.applyTemplate(tpl, { title: '<script>x</script>', summary: 'A & B', body: '', source: '', url: '', date: '' }, {});
  assert.match(rendered, /&lt;script&gt;/);
  assert.match(rendered, /A &amp; B/);
});


await test('license access accepts owner and permanent users', () => {
  assert.equal(context.hasAccess({ is_owner: 1, license_permanent: 0, license_expires_at: null }), true);
  assert.equal(context.hasAccess({ is_owner: 0, license_permanent: 1, license_expires_at: null }), true);
});

await test('license access accepts future expiry and rejects expired or missing licenses', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.equal(context.hasAccess({ is_owner: 0, license_permanent: 0, license_expires_at: future }), true);
  assert.equal(context.hasAccess({ is_owner: 0, license_permanent: 0, license_expires_at: past }), false);
  assert.equal(context.hasAccess({ is_owner: 0, license_permanent: 0, license_expires_at: null }), false);
  assert.equal(context.hasAccess({ is_owner: 0, license_permanent: 0, license_expires_at: 'not-a-date' }), false);
});

await test('license status labels distinguish permanent, active and expired', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.match(context.licenseStatusLabel({ is_owner: 0, license_permanent: 1 }), /دائمی/);
  assert.match(context.licenseStatusLabel({ is_owner: 0, license_permanent: 0, license_expires_at: future }), /اعتبار تا/);
  assert.match(context.licenseStatusLabel({ is_owner: 0, license_permanent: 0, license_expires_at: past }), /منقضی/);
});

await test('dead isAlreadySent helper was removed', () => {
  assert.equal(typeof context.isAlreadySent, 'undefined');
});

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}`);
  if (!r.ok) console.error(r.error);
}
if (failed.length) process.exit(1);
console.log(`\n${results.length} tests passed.`);
