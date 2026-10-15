import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const workerUrl = new URL('../worker.js', import.meta.url);
let source = fs.readFileSync(workerUrl, 'utf8');
const originalSource = source;
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

for (const name of [
  'classifyDiagnosticError', 'sanitizeDiagnosticText', 'buildDiagnosticFingerprint',
  'recordDiagnosticEvent', 'resolveDeliveryDiagnostics', 'reconcileTerminalDiagnostics', 'buildDiagnosticReportText',
  'sendDiagnosticReportFile', 'sendDueDiagnosticReports', 'showOwnerDiagnostics',
]) {
  assert.equal(typeof context[name], 'function', `${name} must exist`);
}

const permission = context.classifyDiagnosticError('telegram_send', 'Forbidden: bot is not a member of the channel', {
  destinationId: 42,
});
assert.equal(permission.code, 'TELEGRAM_PERMISSION_DENIED');
assert.equal(permission.severity, 'critical');
assert.match(permission.diagnosis, /دسترسی|عضو|مدیر/);
assert.match(permission.recommendation, /ادمین|مدیر|دسترسی/);

const limited = context.classifyDiagnosticError('telegram_send', 'Too Many Requests: retry after 60', {});
assert.equal(limited.code, 'TELEGRAM_RATE_LIMIT');
assert.equal(limited.retryable, true);
assert.notEqual(limited.severity, 'critical', 'retryable rate limits must not immediately spam the owner');

const aiLimited = context.classifyDiagnosticError(
  'delivery_attempt',
  'همه سرویس‌های هوش مصنوعی ناموفق بودند: gemini: body:new_context_claim | groq: HTTP 429 rate limit tokens per day | cloudflare: body:new_context_claim',
  {},
);
assert.equal(aiLimited.code, 'AI_PROVIDER_RATE_LIMIT');
assert.equal(aiLimited.category, 'ai');
assert.equal(aiLimited.retryable, true);
assert.notEqual(aiLimited.severity, 'critical');

const groqLimited = context.classifyDiagnosticError('ai_translation', 'Groq HTTP 429 tokens per day (TPD)', {});
assert.equal(groqLimited.code, 'AI_PROVIDER_RATE_LIMIT');
assert.equal(groqLimited.category, 'ai');

const sourceLimited = context.classifyDiagnosticError('source_poll', 'HTTP 429 rate limit', {});
assert.equal(sourceLimited.code, 'UPSTREAM_RATE_LIMIT');
assert.equal(sourceLimited.category, 'source');
assert.notEqual(sourceLimited.code, 'TELEGRAM_RATE_LIMIT');

const media = context.classifyDiagnosticError('media_send', 'Bad Request: failed to get HTTP URL content', {});
assert.equal(media.code, 'MEDIA_FETCH_FAILED');
assert.match(media.recommendation, /رسانه|آپلود|لینک/);

const scrubbed = context.sanitizeDiagnosticText(
  'Authorization: Bearer secret-token-123 TELEGRAM_BOT_TOKEN=123456:ABCDEF GEMINI_API_KEYS=AIza-secret https://api.telegram.org/bot123456:ABCDEF/sendMessage',
);
assert.doesNotMatch(scrubbed, /secret-token-123|123456:ABCDEF|AIza-secret/);
assert.match(scrubbed, /\[REDACTED\]/);

const fp1 = await context.buildDiagnosticFingerprint({
  userId: '100', category: 'delivery', code: 'TELEGRAM_PERMISSION_DENIED', destinationId: 42, deliveryId: 9,
});
const fp2 = await context.buildDiagnosticFingerprint({
  userId: '100', category: 'delivery', code: 'TELEGRAM_PERMISSION_DENIED', destinationId: 42, deliveryId: 9,
});
assert.equal(fp1, fp2, 'diagnostic fingerprints must be stable');

const report = context.buildDiagnosticReportText([
  {
    id: 1, severity: 'critical', category: 'delivery', stage: 'telegram_send', code: 'TELEGRAM_PERMISSION_DENIED',
    message: 'Forbidden', diagnosis: 'ربات دسترسی ارسال ندارد', recommendation: 'ربات را مدیر کنید',
    title: 'خبر آزمایشی', source_title: 'منبع', destination_title: 'مقصد', destination_chat_id: '-10042',
    occurrence_count: 3, attempt_count: 3, first_seen_at: '2026-07-20 10:00:00', last_seen_at: '2026-07-20 10:05:00',
    status: 'open',
  },
  {
    id: 2, severity: 'warning', category: 'media', stage: 'media_send', code: 'MEDIA_FETCH_FAILED',
    message: 'failed to get HTTP URL content', diagnosis: 'رسانه دریافت نشد', recommendation: 'لینک رسانه بررسی شود',
    title: 'خبر دوم', source_title: 'منبع دوم', destination_title: 'مقصد', occurrence_count: 1,
    first_seen_at: '2026-07-20 11:00:00', last_seen_at: '2026-07-20 11:00:00', status: 'open',
  },
], { generatedAt: '2026-07-20T12:00:00.000Z', title: 'گزارش دیاگ' });
assert.match(report, /گزارش دیاگ/);
assert.match(report, /TELEGRAM_PERMISSION_DENIED/);
assert.match(report, /تعداد رخداد: 3/);
assert.match(report, /راه‌حل پیشنهادی/);

assert.match(originalSource, /CREATE TABLE IF NOT EXISTS diagnostic_events/, 'diagnostic_events table must be created');
assert.match(originalSource, /CREATE TABLE IF NOT EXISTS diagnostic_report_state/, 'diagnostic_report_state table must be created');
assert.match(originalSource, /sendDueDiagnosticReports\(env\)/, 'scheduled execution must send quiet diagnostic reports');
assert.match(originalSource, /owner_diagnostics/, 'owner panel must expose diagnostics');
assert.match(originalSource, /owner_diag_export/, 'owner panel must expose manual report export');
assert.match(originalSource, /resolveDeliveryDiagnostics\(/, 'successful deliveries must resolve earlier diagnostic events');
assert.match(originalSource, /در صف گزارش روزانه.*روز اخیر/u,
  'owner diagnostics must label the pending daily-report window');
assert.match(originalSource, /شامل سوابق حل‌شده هم هستند و به معنی خطای باز نیستند/u,
  'owner diagnostics must explain that recent/report history includes resolved events');

console.log('PASS smart diagnostics classification, redaction, report, schema, and owner controls');

const reconciliationEvents = [
  ...['published', 'filtered', 'skipped', 'rejected', 'deleted'].map((status, index) => ({
    id: index + 1, user_id: '100', news_id: 10 + index, delivery_id: 100 + index,
    destination_id: 7, status: 'open', expected_delivery_status: status,
  })),
  { id: 6, user_id: '100', news_id: 20, delivery_id: 106, destination_id: 7, status: 'open', expected_delivery_status: 'failed' },
  { id: 7, user_id: '100', news_id: 21, delivery_id: 107, destination_id: 7, status: 'open', expected_delivery_status: 'ambiguous' },
  { id: 8, user_id: '100', news_id: 30, delivery_id: null, destination_id: 7, status: 'open' },
  { id: 9, user_id: '100', news_id: 31, delivery_id: null, destination_id: 7, status: 'open' },
  { id: 10, user_id: '100', news_id: 32, delivery_id: null, destination_id: 7, status: 'open' },
  { id: 11, user_id: '100', news_id: 33, delivery_id: null, destination_id: 7, status: 'open' },
  { id: 12, user_id: '100', news_id: 34, delivery_id: null, destination_id: 7, status: 'open' },
  { id: 13, user_id: '100', news_id: 35, delivery_id: null, destination_id: 7, status: 'open' },
  { id: 14, user_id: '100', news_id: 36, delivery_id: null, destination_id: 7, status: 'open' },
];
const reconciliationDeliveries = new Map([
  ...reconciliationEvents.filter((row) => row.delivery_id).map((row) => [row.delivery_id, {
    id: row.delivery_id, news_id: row.news_id, destination_id: row.destination_id, status: row.expected_delivery_status,
  }]),
  [301, { id: 301, news_id: 30, destination_id: 7, status: 'published' }],
  [311, { id: 311, news_id: 31, destination_id: 7, status: 'queued' }],
  [321, { id: 321, news_id: 32, destination_id: 7, status: 'processing' }],
  [331, { id: 331, news_id: 33, destination_id: 7, status: 'pending_approval' }],
  [341, { id: 341, news_id: 34, destination_id: 7, status: 'failed' }],
  [351, { id: 351, news_id: 35, destination_id: 7, status: 'ambiguous' }],
  [361, { id: 361, news_id: 36, destination_id: 7, status: 'published' }],
]);
const reconciliationNews = new Map([
  [30, { id: 30, status: 'published' }],
  [31, { id: 31, status: 'published' }],
  [32, { id: 32, status: 'filtered' }],
  [33, { id: 33, status: 'skipped' }],
  [34, { id: 34, status: 'rejected' }],
  [35, { id: 35, status: 'deleted' }],
  [36, { id: 36, status: 'received' }],
]);

function statusesFromSql(sql, alias) {
  const match = sql.match(new RegExp(`${alias}\\.status\\s+in\\s*\\(([^)]+)\\)`, 'i'));
  return new Set((match?.[1].match(/'([^']+)'/g) || []).map((value) => value.slice(1, -1)));
}

class ReconciliationStatement {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async run() {
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (!q.startsWith('update diagnostic_events') || !q.includes('terminal_delivery')) return { meta: { changes: 0 } };
    const safeDeliveryStatuses = statusesFromSql(q, 'terminal_delivery');
    const safeNewsStatuses = statusesFromSql(q, 'terminal_news');
    const actionableStatuses = statusesFromSql(q, 'active_delivery');
    let argIndex = 0;
    const scopedUserId = /\buser_id=\?/.test(q) ? String(this.args[argIndex++]) : null;
    const scopedNewsId = /\bnews_id=\?/.test(q) ? Number(this.args[argIndex++]) : null;
    let changes = 0;
    for (const event of reconciliationEvents) {
      if (event.status !== 'open') continue;
      if (scopedUserId !== null && event.user_id !== scopedUserId) continue;
      if (scopedNewsId !== null && event.news_id !== scopedNewsId) continue;
      let terminal = false;
      if (event.delivery_id !== null) {
        terminal = safeDeliveryStatuses.has(reconciliationDeliveries.get(event.delivery_id)?.status);
      } else {
        const newsIsTerminal = safeNewsStatuses.has(reconciliationNews.get(event.news_id)?.status);
        const hasActionableDelivery = [...reconciliationDeliveries.values()].some((delivery) =>
          delivery.news_id === event.news_id
          && (event.destination_id === null || delivery.destination_id === event.destination_id)
          && actionableStatuses.has(delivery.status));
        terminal = newsIsTerminal && !hasActionableDelivery;
      }
      if (terminal) { event.status = 'resolved'; changes += 1; }
    }
    return { meta: { changes } };
  }
}

const reconciliationEnv = { DB: { prepare: (sql) => new ReconciliationStatement(sql) } };
assert.equal(await context.reconcileTerminalDiagnostics(reconciliationEnv), 6,
  'five safe delivery outcomes and one safely terminal news-scoped event must be resolved');
for (const id of [1, 2, 3, 4, 5, 8]) {
  assert.equal(reconciliationEvents.find((row) => row.id === id).status, 'resolved', `terminal diagnostic ${id} must resolve`);
}
for (const id of [6, 7, 9, 10, 11, 12, 13, 14]) {
  assert.equal(reconciliationEvents.find((row) => row.id === id).status, 'open', `actionable diagnostic ${id} must stay open`);
}
assert.equal(await context.reconcileTerminalDiagnostics(reconciliationEnv), 0,
  'terminal reconciliation must be idempotent after all safe rows are resolved');

let ownerDiagnosticsText = '';
class OwnerDiagnosticsStatement {
  constructor(sql) { this.sql = sql; }
  bind() { return this; }
  async first() {
    return { open_count: 2, critical_count: 0, error_count: 0, warning_count: 2, occurrences_24h: 45,
      unreported_count: 12, unreported_open_count: 2, unreported_resolved_count: 10 };
  }
  async all() { return { results: [] }; }
  async run() { return { meta: { changes: 0 } }; }
}
const ownerDiagnosticsEnv = { DB: { prepare: (sql) => new OwnerDiagnosticsStatement(sql) } };
context.sendMessage = async (_env, _chatId, text) => { ownerDiagnosticsText = text; return { ok: true }; };
await context.showOwnerDiagnostics('100', ownerDiagnosticsEnv);
assert.match(ownerDiagnosticsText, /در صف گزارش روزانه \d+ روز اخیر: <b>12<\/b> \(باز: 2 \| حل‌شده: 10\)/u,
  'owner UI must split pending daily-report rows into open and resolved counts');
assert.match(ownerDiagnosticsText, /شامل سوابق حل‌شده هم هستند و به معنی خطای باز نیستند/u,
  'owner UI must make clear that historical counters are not open-error counters');

console.log('PASS terminal diagnostic reconciliation and owner pending-report semantics');

const storedEvents = new Map();
let nextEventId = 1;
class DiagnosticStatement {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async run() {
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.startsWith('insert into diagnostic_events')) {
      const [fingerprint, userId, severity, category, stage, code, message, diagnosis, recommendation,
        sourceId, destinationId, newsId, deliveryId, contextJson, attemptCount] = this.args;
      const old = storedEvents.get(fingerprint);
      if (old) {
        Object.assign(old, { user_id: userId, severity, category, stage, code, message, diagnosis, recommendation,
          source_id: sourceId, destination_id: destinationId, news_id: newsId, delivery_id: deliveryId,
          context_json: contextJson, attempt_count: Math.max(old.attempt_count, attemptCount), status: 'open' });
        old.occurrence_count += 1;
      } else {
        storedEvents.set(fingerprint, { id: nextEventId++, fingerprint, user_id: userId, severity, category, stage, code,
          message, diagnosis, recommendation, source_id: sourceId, destination_id: destinationId, news_id: newsId,
          delivery_id: deliveryId, context_json: contextJson, attempt_count: attemptCount,
          occurrence_count: 1, status: 'open', first_seen_at: '2026-07-20 10:00:00', last_seen_at: '2026-07-20 10:00:00' });
      }
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('update diagnostic_events set status=\'resolved\'')) {
      const deliveryId = Number(this.args.at(-1));
      let changes = 0;
      for (const row of storedEvents.values()) if (Number(row.delivery_id) === deliveryId && row.status === 'open') { row.status = 'resolved'; changes += 1; }
      return { meta: { changes } };
    }
    return { meta: { changes: 1 } };
  }
  async first() {
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.includes('select id from diagnostic_events where fingerprint')) return storedEvents.get(this.args[0]) || null;
    if (q.includes('from diagnostic_events e') && q.includes('where e.id')) {
      const id = Number(this.args[0]);
      return [...storedEvents.values()].find((row) => row.id === id) || null;
    }
    return null;
  }
  async all() { return { results: [] }; }
}
const diagnosticEnv = { DB: { prepare: (sql) => new DiagnosticStatement(sql) }, OWNER_ID: '100' };
const firstRecorded = await context.recordDiagnosticEvent({
  userId: '100', sourceId: 2, destinationId: 3, newsId: 4, deliveryId: 5,
  stage: 'source_poll', message: 'HTTP 503 Authorization: Bearer top-secret', attemptCount: 1,
  final: false, notifyOwner: false,
}, diagnosticEnv);
const secondRecorded = await context.recordDiagnosticEvent({
  userId: '100', sourceId: 2, destinationId: 3, newsId: 4, deliveryId: 5,
  stage: 'source_poll', message: 'HTTP 503 Authorization: Bearer top-secret', attemptCount: 2,
  final: false, notifyOwner: false,
}, diagnosticEnv);
assert.equal(firstRecorded.id, secondRecorded.id, 'same delivery/stage/code must aggregate into one diagnostic row');
assert.equal(secondRecorded.occurrence_count, 2);
assert.equal(secondRecorded.attempt_count, 2);
assert.doesNotMatch(secondRecorded.message, /top-secret/);
assert.equal(await context.resolveDeliveryDiagnostics(5, diagnosticEnv), 1, 'successful delivery must resolve open diagnostics');
assert.equal(storedEvents.values().next().value.status, 'resolved');

let multipartCapture = null;
context.telegramMultipart = async (_env, method, form) => {
  multipartCapture = { method, chatId: form.get('chat_id'), caption: form.get('caption'), document: form.get('document') };
  return { ok: true, result: { message_id: 90 } };
};
const fileResult = await context.sendDiagnosticReportFile('100', [{
  id: 9, user_id: '100', severity: 'critical', category: 'delivery', stage: 'telegram_send',
  code: 'TELEGRAM_PERMISSION_DENIED', message: 'Forbidden', diagnosis: 'دسترسی ندارد', recommendation: 'ادمین شود',
  occurrence_count: 1, status: 'open', first_seen_at: '2026-07-20', last_seen_at: '2026-07-20',
}], diagnosticEnv, { days: 30 });
assert.equal(fileResult.ok, true);
assert.equal(multipartCapture.method, 'sendDocument');
assert.equal(multipartCapture.chatId, '100');
assert.ok(multipartCapture.document instanceof Blob);
const reportFileText = await multipartCapture.document.text();
assert.match(reportFileText, /TELEGRAM_PERMISSION_DENIED/);
assert.match(reportFileText, /راه‌حل پیشنهادی/);

assert.match(originalSource, /recordDiagnosticEvent\(\{[\s\S]*stage: "source_poll"/, 'source polling failures must be diagnosed');
assert.match(originalSource, /stage: "delivery_attempt"/, 'delivery retry/final failures must be diagnosed');
assert.match(originalSource, /stage: "database_commit_after_telegram"/, 'post-Telegram D1 failures must be diagnosed');
assert.match(originalSource, /stage: "stale_processing_recovery"/, 'stale processing recovery must be diagnosed');
assert.match(originalSource, /stage: "media_send"/, 'partial media failures must be diagnosed');

let criticalNotifiedAt = null;
let criticalMessages = 0;
class CriticalStatement {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() {
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.includes('from diagnostic_events') && q.includes('notified_at is not null')) return criticalNotifiedAt ? { id: 44 } : null;
    return null;
  }
  async run() {
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.startsWith('update diagnostic_events set notified_at=current_timestamp')) {
      if (criticalNotifiedAt) return { meta: { changes: 0 } };
      criticalNotifiedAt = new Date().toISOString();
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 1 } };
  }
}
const criticalEnv = { DB: { prepare: (sql) => new CriticalStatement(sql) }, OWNER_ID: '100' };
context.sendMessage = async () => { criticalMessages += 1; return { ok: true, result: { message_id: 1 } }; };
const criticalRow = {
  id: 44, user_id: '100', severity: 'critical', code: 'TELEGRAM_PERMISSION_DENIED', destination_id: 7,
  source_id: 3, title: 'خبر', destination_title: 'کانال مقصد', diagnosis: 'ربات دسترسی ارسال ندارد', message: 'Forbidden',
};
assert.equal(await context.maybeNotifyCriticalDiagnostic(criticalRow, criticalEnv), true);
assert.equal(await context.maybeNotifyCriticalDiagnostic(criticalRow, criticalEnv), false);
assert.equal(criticalMessages, 1, 'same critical root cause must notify only once during the cooldown window');

console.log('PASS smart diagnostics aggregation, document export, and quiet critical alert cooldown');
