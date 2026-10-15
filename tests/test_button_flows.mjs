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
  fetch: async () => { throw new Error('unexpected network fetch'); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'worker.js' });

const defaultSettings = {
  user_id: '100', automation_enabled: 1, message_template: '<b>{title}</b>\n{summary}',
  target_language: 'fa', selected_categories: JSON.stringify(['war_security']), category_mode: 'selected',
  min_importance: 55, show_source: 1, show_link: 1, show_date: 1, send_media: 1,
  footer_text: '', show_footer: 0, disable_preview: 0, content_mode: 'summary',
  approval_mode: 0, ai_dedupe: 1, daily_report: 0, daily_report_hour: 21,
  min_interval_minutes: 0, quiet_start: '', quiet_end: '', publication_mode: 'immediate',
};
const owner = {
  telegram_id: '100', username: 'owner', first_name: 'Owner', is_owner: 1,
  license_permanent: 1, license_expires_at: null, state: null, state_data: null,
};
const sourceRow = {
  id: 1, user_id: '100', title: 'Test Source', username: 'testsource', url: 'https://example.com/rss',
  type: 'rss', active: 1, priority: 3, approval_mode: -1, send_media: -1,
  publication_mode: 'inherit', min_interval_minutes: -1, destination_ids: null,
  target_language: null, include_tags: '', exclude_tags: '', custom_topic: null,
};
const destinationRow = {
  id: 1, user_id: '100', title: 'Test Destination', username: 'testdest', chat_id: '-1001', type: 'channel', active: 1,
  target_language: null, emoji: '', show_source: null, show_link: null, show_date: null, send_media: null,
  min_interval_minutes: 0, message_template: null, footer_text: null,
};

function rowFor(sql) {
  const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (q.includes('from user_settings')) return { ...defaultSettings };
  if (q.includes('from sources')) return { ...sourceRow };
  if (q.includes('from destination_channels')) return { ...destinationRow };
  if (q.includes('from source_suggestions')) return { id: 1, user_id: '100', batch_id: 'b1', name: 'Suggested', url: 'https://example.com/feed', type: 'rss' };
  if (q.includes('from users') && q.includes('sum(')) return { permanent_count: 1, active_count: 0, inactive_count: 0 };
  if (q.includes('count(')) return { count: 0, override_count: 0 };
  if (q.includes('from news_items')) return { id: 1, user_id: '100', status: 'pending_approval', failed_count: 1, ambiguous_count: 0 };
  return null;
}
function rowsFor(sql) {
  const q = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  if (q.startsWith('pragma table_info')) return [];
  if (q.includes('from sources')) return [{ ...sourceRow }];
  if (q.includes('from destination_channels')) return [{ ...destinationRow }];
  if (q.includes('from users')) return [{ ...owner }];
  if (q.includes('from source_suggestions')) return [{ id: 1, batch_id: 'b1', name: 'Suggested', url: 'https://example.com/feed', type: 'rss' }];
  if (q.includes('from news_deliveries') || q.includes('from news_items')) return [];
  return [];
}
class FakeStatement {
  constructor(sql, log) { this.sql = sql; this.args = []; this.log = log; }
  bind(...args) { this.args = args; return this; }
  async first() { this.log.push({ op: 'first', sql: this.sql, args: this.args }); return rowFor(this.sql); }
  async all() { this.log.push({ op: 'all', sql: this.sql, args: this.args }); return { results: rowsFor(this.sql) }; }
  async run() { this.log.push({ op: 'run', sql: this.sql, args: this.args }); return { success: true, meta: { changes: 1 } }; }
}
class FakeDB {
  constructor(log) { this.log = log; }
  prepare(sql) { return new FakeStatement(sql, this.log); }
  async batch(statements) { return Promise.all(statements.map((s) => s.run())); }
}

const sent = [];
const acked = [];
const dbLog = [];
const stateLog = [];
const env = {
  DB: new FakeDB(dbLog), OWNER_ID: '100', TELEGRAM_BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'secret', ADMIN_SECRET: 'admin',
  AI_PROVIDER_ORDER: 'cloudflare', CLOUDFLARE_AI_MODEL: '@cf/zai-org/glm-4.7-flash',
  AI: { run: async () => ({ response: 'سلامت' }) },
};

context.upsertUser = async () => {};
context.getUser = async () => ({ ...owner });
context.sendMessage = async (_env, chatId, text, keyboard) => {
  sent.push({ chatId, text: String(text || ''), keyboard });
  return { ok: true, result: { message_id: sent.length } };
};
context.answerCallback = async (_env, id) => { acked.push(id); };
context.ensureSettings = async () => ({ ...defaultSettings });
context.isAutomationEnabled = async () => true;
context.setAutomationStatus = async (_uid, enabled) => ({ enabled, sourcesActivated: 1, queueReset: 0 });
context.resetBotConfiguration = async () => ({ enabled: true, sourcesReset: 1, destinationsKept: 1, queueCleared: 0 });
context.runTestForUser = async () => ({ ok: true, source: 'Test Source', title: 'Test', destinations: 1 });
context.suggestSources = async (chatId) => context.sendMessage(env, chatId, 'suggestions');
context.listLicensedUsers = async (chatId) => context.sendMessage(env, chatId, 'users');
context.showAiApiHealth = async (chatId) => context.sendMessage(env, chatId, 'ai health');
context.showStatsDashboard = async (chatId) => context.sendMessage(env, chatId, 'stats');
context.showFailedNews = async (chatId) => context.sendMessage(env, chatId, 'failures');
context.showPendingApprovals = async (chatId) => context.sendMessage(env, chatId, 'approvals');
context.processDueNewsQueue = async () => ({ processed: 1 });
context.approveNews = async () => ({ ok: true });
context.rejectPendingNews = async () => true;
context.retryFailedNews = async () => ({ ok: true });
context.dismissFailedNews = async () => true;
context.checkStoredDestinationAccess = async () => ({ ok: true, title: 'Destination', chatId: '-1001' });
context.deleteDestinationForUser = async () => {};
context.deleteSourceForUser = async () => {};
context.saveSuggestionRow = async () => {};
context.saveAllSuggestedSources = async () => ({ added: 1, failed: 0 });
context.saveTemplate = async () => ({ saved: true, remainingOverrides: 0 });
context.clearDestinationTemplateOverrides = async () => ({ cleared: 0 });
context.runTemplateDiagnostics = async () => ({ ok: true, overrideCount: 0, currentValidation: { ok: true, errors: [] }, draftValidation: { ok: true, errors: [] }, previewLength: 10, style: 'classic', fields: ['title','summary'] });
context.ensureTemplateDraft = async () => ({ fields: ['title', 'summary'], style: 'classic' });
context.resetTemplateDraftFromCurrent = async () => {};
context.toggleTemplateBuilderField = async () => {};
context.setTemplateDraftStyle = async () => {};
context.setState = async (uid, state, data) => { stateLog.push({ uid, state, data }); };
context.clearState = async () => { stateLog.push({ state: null }); };
context.toggleNewsCategory = async () => {};
context.setSelectedCategories = async () => {};
context.setCategoryMode = async () => {};
context.toggleSourceDestination = async () => true;

function generatedCallbacks(code) {
  const out = [];
  const rx = /callback_data\s*:\s*([`"'])(.*?)(?<!\\)\1/gs;
  let m;
  while ((m = rx.exec(code))) out.push(m[2]);
  return out;
}
function concretize(value) {
  const map = {
    prefix: 'global_mode', code: 'fa', c: 'fa', key: 'classic', field: 'title', value: '3', batchId: 'b1',
  };
  return value.replace(/\$\{([^}]+)\}/g, (_m, expr) => map[expr] || '1');
}
const callbacks = new Set(generatedCallbacks(source).filter((x) => !x.includes('${prefix}')).map(concretize));
for (const mode of ['immediate', 'interval_15', 'interval_30', 'morning_digest', 'evening_digest']) callbacks.add(`global_mode:${mode}`);
for (const mode of ['inherit', 'immediate', 'interval_15', 'interval_30', 'morning_digest', 'evening_digest']) callbacks.add(`source_mode:1:${mode}`);

const failures = [];
for (const data of [...callbacks].sort()) {
  const sentBefore = sent.length;
  const ackBefore = acked.length;
  try {
    await context.handleCallback({ id: `cb-${data}`, from: { id: 100, first_name: 'Owner', username: 'owner' }, message: { chat: { id: 100, type: 'private' } }, data }, env);
    assert.equal(acked.length, ackBefore + 1, `${data}: callback was not acknowledged exactly once`);
    assert.ok(sent.length > sentBefore || dbLog.length > 0 || stateLog.length > 0, `${data}: no response or operation`);
  } catch (error) {
    failures.push(`${data}: ${error.stack || error}`);
  }
}
assert.deepEqual(failures, [], `Button flow failures:\n${failures.join('\n\n')}`);

// Non-owner must not execute owner actions, but the callback must still be acknowledged.
context.getUser = async () => ({ ...owner, is_owner: 0 });
for (const data of ['owner_panel', 'owner_add_user', 'owner_users', 'owner_ai_check', 'owner_live_selftest']) {
  const before = acked.length;
  const sentBefore = sent.length;
  await context.handleCallback({ id: `nonowner-${data}`, from: { id: 200, first_name: 'User' }, message: { chat: { id: 200, type: 'private' } }, data }, env);
  assert.equal(acked.length, before + 1, `${data}: non-owner callback not acknowledged`);
  assert.equal(sent.length, sentBefore + 1, `${data}: non-owner received no access-denied feedback`);
  assert.match(sent.at(-1).text, /فقط برای مالک/);
}

console.log(`PASS button flow smoke: ${callbacks.size} concrete callback routes`);
