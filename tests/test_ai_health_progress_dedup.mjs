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

const locks = new Map();
class Statement {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() {
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.includes('from owner_action_locks')) {
      const [userId, action] = this.args;
      const row = locks.get(`${userId}:${action}`);
      return row ? { ...row } : null;
    }
    return null;
  }
  async all() {
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.includes('from ai_key_usage')) return { results: [] };
    return { results: [] };
  }
  async run() {
    const q = this.sql.replace(/\s+/g, ' ').toLowerCase();
    if (q.startsWith('insert into owner_action_locks')) {
      const [userId, action] = this.args;
      const key = `${userId}:${action}`;
      const old = locks.get(key);
      if (old && old.lockedUntil > Date.now()) return { meta: { changes: 0 } };
      locks.set(key, { status_message_id: null, lockedUntil: Date.now() + 180000 });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('update owner_action_locks') && q.includes('locked_until')) {
      const [offset, userId, action] = this.args;
      const key = `${userId}:${action}`;
      const row = locks.get(key);
      if (row) {
        const seconds = Number(String(offset).match(/\d+/)?.[0] || 300);
        row.status_message_id = null;
        row.lockedUntil = Date.now() + seconds * 1000;
      }
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (q.startsWith('update owner_action_locks') && q.includes('status_message_id')) {
      const [messageId, userId, action] = this.args;
      const key = `${userId}:${action}`;
      const row = locks.get(key);
      if (row) row.status_message_id = messageId;
      return { meta: { changes: row ? 1 : 0 } };
    }
    if (q.startsWith('delete from owner_action_locks')) {
      const [userId, action] = this.args;
      const deleted = locks.delete(`${userId}:${action}`);
      return { meta: { changes: deleted ? 1 : 0 } };
    }
    return { meta: { changes: 1 } };
  }
}
const env = {
  DB: { prepare: (sql) => new Statement(sql) },
  OWNER_ID: '100', TELEGRAM_BOT_TOKEN: 'token',
  AI_PROVIDER_ORDER: 'cloudflare', CLOUDFLARE_AI_MODEL: '@cf/zai-org/glm-4.7-flash',
  AI: { run: async () => ({ response: 'OK' }) },
};

context.getGroqApiKeys = () => ['g1', 'g2', 'g3'];
context.getGeminiApiKeys = () => ['m1', 'm2', 'm3'];
context.hasWorkersAiBinding = () => true;
context.getAiProviderOrder = () => ['cloudflare'];

let resolveChecks;
const checksPromise = new Promise((resolve) => { resolveChecks = resolve; });
context.runAiApiHealthChecks = async () => checksPromise;

const sent = [];
const deleted = [];
context.sendMessage = async (_env, chatId, text, keyboard) => {
  const message = { chatId, text: String(text || ''), keyboard, message_id: sent.length + 1 };
  sent.push(message);
  return { ok: true, result: { message_id: message.message_id, chat: { id: chatId } } };
};
context.telegram = async (_env, method, payload) => {
  if (method === 'deleteMessage') {
    deleted.push(payload);
    return { ok: true, result: true };
  }
  throw new Error(`unexpected Telegram method: ${method}`);
};

const first = context.showAiApiHealth(100, env);
await new Promise((resolve) => setTimeout(resolve, 0));
const second = context.showAiApiHealth(100, env);
await new Promise((resolve) => setTimeout(resolve, 0));

const progressBeforeCompletion = sent.filter((x) => /در حال بررسی .*سرویس\/کلید هوش مصنوعی/.test(x.text));
assert.equal(progressBeforeCompletion.length, 1, 'overlapping API checks must create only one progress message');

resolveChecks([{
  provider: 'cloudflare', slot: 1, keyId: 'cloudflare-test', model: '@cf/zai-org/glm-4.7-flash',
  endpointMode: 'binding', ok: true, status: 'healthy', error: '', rateLimits: {},
}]);
await Promise.all([first, second]);

assert.equal(deleted.length, 1, 'temporary progress message must be deleted after the check finishes');
assert.equal(deleted[0].message_id, progressBeforeCompletion[0].message_id);
assert.equal(locks.size, 1, 'a persistent cooldown row must remain after completion');

const sentAfterFirstRun = sent.length;
const third = await context.showAiApiHealth(100, env);
assert.equal(third?.busy, true, 'a delayed or repeated callback during cooldown must be rejected');
assert.equal(sent.length, sentAfterFirstRun, 'cooldown retry must not create a new progress or result message');
assert.equal(sent.filter((x) => /در حال بررسی .*سرویس\/کلید هوش مصنوعی/.test(x.text)).length, 1, 'only one progress message may exist during the cooldown window');

console.log('PASS AI health progress deduplication, cleanup, and post-completion cooldown');
