import fs from 'node:fs';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('production code does not use Math.random for identifiers', () => {
  assert.doesNotMatch(source, /Math\.random\s*\(/);
});

test('API key rotation does not use mutable module-level counters', () => {
  assert.doesNotMatch(source, /let\s+(?:gemini|groq)RotationCounter\s*=/);
});

test('request-bound D1 work is not cached in a global Promise', () => {
  assert.doesNotMatch(source, /(?:let|const|var)\s+dbInitPromise\s*=/);
  assert.match(source, /await\s+initDbOnce\(env\);\s*dbInitialized\s*=\s*true/);
});

test('Worker avoids passThroughOnException and destructured waitUntil', () => {
  assert.doesNotMatch(source, /passThroughOnException\s*\(/);
  assert.doesNotMatch(source, /const\s*\{\s*waitUntil\s*\}\s*=\s*ctx/);
});

test('scheduled work is attached to ctx.waitUntil', () => {
  assert.match(source, /async\s+scheduled\([^)]*ctx\)[\s\S]*?ctx\.waitUntil\s*\(/);
});

let passed = 0;
const failures = [];
for (const t of tests) {
  try { await t.fn(); passed += 1; console.log(`PASS - ${t.name}`); }
  catch (error) { failures.push({ name: t.name, error: error?.stack || String(error) }); console.error(`FAIL - ${t.name}\n${error?.stack || error}`); }
}
console.log(`\nCLOUDFLARE BEST PRACTICES TOTAL: ${tests.length} | PASSED: ${passed} | FAILED: ${failures.length}`);
if (failures.length) process.exitCode = 1;
