import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const workerPath = new URL('../worker.js', import.meta.url);
let source = fs.readFileSync(workerPath, 'utf8');
source = source.replace('export default {', 'globalThis.__worker = {');
const context = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, Date, Intl, JSON, Math, RegExp,
  String, Number, Boolean, Array, Object, Set, Map, Promise, Error, TypeError, Uint8Array, Uint32Array,
  AbortController, Blob, FormData, Response, Request, Headers, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('unexpected fetch'); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'worker.js' });

const setStates = new Set([...source.matchAll(/setState\([^,]+,\s*["']([^"']+)["']/g)].map((m) => m[1]));
const handledStates = new Set([...source.matchAll(/user\.state\s*===\s*["']([^"']+)["']/g)].map((m) => m[1]));
const specialStates = new Set(['request_destination_channel']);
const orphaned = [...setStates].filter((state) => !handledStates.has(state) && !specialStates.has(state));
assert.deepEqual(orphaned, [], `orphaned state transitions: ${orphaned.join(', ')}`);

const store = {
  destination: { id: 1, user_id: '100', title: 'Destination', username: 'dest', chat_id: '-1001', active: 1, message_template: null, footer_text: null, emoji: '', min_interval_minutes: 0, target_language: null, show_source: null, show_link: null, show_date: null, send_media: null },
  source: { id: 1, user_id: '100', title: 'Source', username: 'source', url: 'https://example.com/rss', type: 'rss', active: 1, approval_mode: -1, send_media: -1, priority: 3, publication_mode: 'inherit', min_interval_minutes: -1, destination_ids: null, target_language: null, include_tags: '', exclude_tags: '', custom_topic: null },
  settings: { user_id: '100', message_template: '<b>{title}</b>\n{summary}', target_language: 'fa', selected_categories: '[]', category_mode: 'selected', min_importance: 55, show_source: 1, show_link: 1, show_date: 1, send_media: 1, show_footer: 0, disable_preview: 0, content_mode: 'summary', approval_mode: 0, ai_dedupe: 1, daily_report: 0, daily_report_hour: 21, min_interval_minutes: 0, quiet_start: '', quiet_end: '', publication_mode: 'immediate' },
};
const sqlLog = [];
class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async run() {
    sqlLog.push(['run', this.sql, this.args]);
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.includes('update destination_channels set message_template=')) store.destination.message_template = this.args[0];
    if (q.includes('update destination_channels set footer_text=')) store.destination.footer_text = this.args[0];
    if (q.includes('update destination_channels set emoji=')) store.destination.emoji = this.args[0];
    if (q.includes('update destination_channels set min_interval_minutes=')) store.destination.min_interval_minutes = this.args[0];
    if (q.includes('update sources set include_tags=')) { store.source.include_tags = this.args[0]; store.source.exclude_tags = this.args[1]; }
    if (q.includes('update sources set custom_topic=')) store.source.custom_topic = this.args[0];
    if (q.includes('update sources set min_interval_minutes=')) store.source.min_interval_minutes = this.args[0];
    return { meta: { changes: 1 } };
  }
  async first() {
    sqlLog.push(['first', this.sql, this.args]);
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.includes('from destination_channels')) return { ...store.destination };
    if (q.includes('from sources')) return { ...store.source };
    if (q.includes('from user_settings')) return { ...store.settings };
    return null;
  }
  async all() { sqlLog.push(['all', this.sql, this.args]); return { results: [] }; }
}
const DB = { prepare: (sql) => new Stmt(sql), batch: async (items) => Promise.all(items.map((item) => item.run())) };
const env = { DB, OWNER_ID: '100', TELEGRAM_BOT_TOKEN: 'token', WEBHOOK_SECRET: 'w'.repeat(40), ADMIN_SECRET: 'a'.repeat(40) };
const sent = [];
const cleared = [];
context.sendMessage = async (_env, chatId, text, keyboard) => { sent.push({ chatId, text: String(text || ''), keyboard }); return { ok: true }; };
context.clearState = async (id) => { cleared.push(id); };
context.setState = async () => {};
context.ensureSettings = async () => ({ ...store.settings });
context.showSettingsMenu = async (chatId) => context.sendMessage(env, chatId, 'settings');
context.showSourceSettings = async (chatId) => context.sendMessage(env, chatId, 'source settings');
context.showDestinationSettings = async (chatId) => context.sendMessage(env, chatId, 'destination settings');
context.showTemplateBuilder = async (chatId) => context.sendMessage(env, chatId, 'template builder');
context.saveTemplate = async () => ({ remainingOverrides: 0 });
context.saveTelegramSource = async () => ({ mode: 'web', title: 'Source', username: 'source' });
context.saveWebSource = async () => {};
context.discoverFeed = async () => 'https://example.com/rss';
context.getUser = async () => null;
context.stopAutomation = async () => {};
context.telegram = async (_env, method) => {
  if (method === 'getChat') return { ok: true, result: { id: -1001, type: 'channel', title: 'Destination', username: 'dest' } };
  if (method === 'getMe') return { ok: true, result: { id: 10, username: 'bot' } };
  if (method === 'getChatMember') return { ok: true, result: { status: 'administrator', can_post_messages: true } };
  throw new Error(`unexpected telegram method ${method}`);
};

const cases = [
  ['add_channel', '@dest', null],
  ['add_source', '@source', null],
  ['template_builder', 'anything', null],
  ['set_template', '<b>{title}</b>\n{summary}', null],
  ['set_footer', '@mychannel', null],
  ['set_topic', 'اخبار مهم ایران', null],
  ['owner_add_user', '200 30', null],
  ['set_global_interval', '5', null],
  ['set_quiet_hours', '23:00 07:00', null],
  ['set_report_hour', '21', null],
  ['set_source_filters', 'مثبت: #ایران\nمنفی: #تبلیغ', { source_id: 1 }],
  ['set_source_topic', 'اقتصاد ایران', { source_id: 1 }],
  ['set_source_interval', '15', { source_id: 1 }],
  ['set_dest_template', '<b>{title}</b>\n{summary}', { destination_id: 1 }],
  ['set_dest_footer', '@footer', { destination_id: 1 }],
  ['set_dest_emoji', '🔥', { destination_id: 1 }],
  ['set_dest_interval', '10', { destination_id: 1 }],
];

for (const [state, text, data] of cases) {
  const sentBefore = sent.length;
  const user = { telegram_id: '100', is_owner: 1, license_permanent: 1, state, state_data: data ? JSON.stringify(data) : null };
  const handled = await context.handleStateInput({ from: { id: 100 }, chat: { id: 100, type: 'private' }, text }, user, env);
  assert.equal(handled, true, `${state} did not report handled`);
  assert.ok(sent.length > sentBefore, `${state} did not send feedback`);
}

const sharedUser = { telegram_id: '100', is_owner: 1, license_permanent: 1, state: 'request_destination_channel', state_data: JSON.stringify({ request_id: 77 }) };
const beforeShared = sent.length;
await context.handleSharedDestination({ from: { id: 100 }, chat: { id: 100 }, chat_shared: { request_id: 77, chat_id: -1001 } }, sharedUser, env);
assert.ok(sent.length > beforeShared, 'shared destination did not send feedback');

for (const [state, value] of [['set_global_interval', '-2'], ['set_quiet_hours', '99:00 07:00'], ['set_report_hour', '30'], ['set_source_interval', '2000'], ['set_dest_interval', '-1']]) {
  const sentBefore = sent.length;
  const clearedBefore = cleared.length;
  const data = state.startsWith('set_source_') ? { source_id: 1 } : state.startsWith('set_dest_') ? { destination_id: 1 } : null;
  const user = { telegram_id: '100', is_owner: 1, license_permanent: 1, state, state_data: data ? JSON.stringify(data) : null };
  const handled = await context.handleStateInput({ from: { id: 100 }, chat: { id: 100 }, text: value }, user, env);
  assert.equal(handled, true, `${state} invalid input not handled`);
  assert.ok(sent.length > sentBefore, `${state} invalid input has no feedback`);
  assert.equal(cleared.length, clearedBefore, `${state} invalid input unexpectedly cleared state`);
}

console.log(`PASS state flow audit: ${cases.length + 1} valid routes and 5 invalid-input routes`);
