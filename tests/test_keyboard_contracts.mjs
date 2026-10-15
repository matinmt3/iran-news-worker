import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const workerPath = new URL('../worker.js', import.meta.url);
let source = fs.readFileSync(workerPath, 'utf8').replace('export default {', 'globalThis.__worker = {');
const context = {
  console, crypto: webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, Date, Intl, JSON, Math, RegExp,
  String, Number, Boolean, Array, Object, Set, Map, Promise, Error, TypeError, Uint8Array, Uint32Array,
  AbortController, Blob, FormData, Response, Request, Headers, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('unexpected fetch'); },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'worker.js' });

const settings = {
  selected_categories: JSON.stringify(['war_security', 'economy']), category_mode: 'selected', min_importance: 55,
  show_source: 1, show_link: 1, show_date: 1, send_media: 1, show_footer: 0, disable_preview: 0,
  approval_mode: 0, ai_dedupe: 1, daily_report: 0, content_mode: 'summary',
};
const keyboards = [
  ['main owner on', context.mainKeyboard(true, true)],
  ['main user off', context.mainKeyboard(false, false)],
  ['owner', context.ownerKeyboard()],
  ['automation on', context.automationKeyboard(true)],
  ['automation off', context.automationKeyboard(false)],
  ['reset', context.resetConfirmationKeyboard()],
  ['template menu', context.templateMenuKeyboard(2)],
  ['template builder', context.templateBuilderKeyboard(['title', 'summary'], 'classic')],
  ['settings', context.settingsKeyboard(settings)],
  ['language', context.languageKeyboard()],
  ['category selected', context.categorySettingsKeyboard(settings)],
  ['category all', context.categorySettingsKeyboard({ ...settings, category_mode: 'all_news' })],
  ['importance', context.importanceSettingsKeyboard(settings)],
  ['help', context.helpKeyboard()],
  ['source priority', context.sourcePriorityKeyboard(123, 3)],
  ['publication global', context.publicationModeKeyboard('global')],
  ['publication source', context.publicationModeKeyboard('source:123')],
  ['source language', context.sourceLanguageKeyboard(123)],
  ['destination language', context.destinationLanguageKeyboard(123)],
  ['back', context.backKeyboard()],
  ['back owner', context.backOwnerKeyboard()],
  ['settings back', context.settingsBackKeyboard()],
  ['template back', context.backTemplateKeyboard()],
];

let buttons = 0;
for (const [name, keyboard] of keyboards) {
  assert.ok(Array.isArray(keyboard?.inline_keyboard), `${name}: missing inline_keyboard`);
  assert.ok(keyboard.inline_keyboard.length > 0, `${name}: empty keyboard`);
  for (const row of keyboard.inline_keyboard) {
    assert.ok(Array.isArray(row) && row.length > 0, `${name}: empty row`);
    assert.ok(row.length <= 8, `${name}: too many buttons in a row`);
    for (const button of row) {
      buttons += 1;
      assert.ok(String(button.text || '').trim(), `${name}: blank button text`);
      const actionCount = ['callback_data', 'url', 'web_app', 'switch_inline_query', 'switch_inline_query_current_chat'].filter((key) => button[key] !== undefined).length;
      assert.equal(actionCount, 1, `${name}: inline button must have exactly one action: ${JSON.stringify(button)}`);
      if (button.callback_data !== undefined) {
        assert.ok(Buffer.byteLength(String(button.callback_data), 'utf8') <= 64, `${name}: callback_data exceeds 64 bytes`);
      }
    }
  }
}

const picker = context.destinationChannelPickerKeyboard(77);
assert.equal(picker.keyboard[0][0].request_chat.request_id, 77);
assert.equal(picker.keyboard[0][0].request_chat.chat_is_channel, true);
assert.equal(picker.keyboard[0][0].request_chat.bot_administrator_rights.can_post_messages, true);
assert.equal(picker.keyboard[0][0].request_chat.bot_administrator_rights.can_delete_messages, false);
assert.equal(picker.resize_keyboard, true);
assert.equal(picker.one_time_keyboard, true);

console.log(`PASS keyboard contracts: ${keyboards.length} keyboards and ${buttons} inline buttons`);
