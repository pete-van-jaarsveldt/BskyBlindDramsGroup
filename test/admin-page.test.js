import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const admin = readFileSync(join(root, 'public', 'admin.html'), 'utf8');

test('the admin page asks search engines not to index it', () => {
  assert.match(admin, /<meta\s+name="robots"\s+content="noindex/i);
});

test('it collects all four editable fields', () => {
  assert.match(admin, /id="f-number"/);
  assert.match(admin, /id="f-title"/);
  assert.match(admin, /id="f-start"/);
  assert.match(admin, /id="f-image"/);
});

test('it posts to both admin endpoints', () => {
  assert.match(admin, /'\/api\/admin\/login'/);
  assert.match(admin, /'\/api\/admin\/event'/);
});

test('it pre-fills from the current event.json', () => {
  assert.match(admin, /fetch\('event\.json'/);
});

test('it previews the countdown so a wrong date is visible before saving', () => {
  assert.match(admin, /id="preview"/);
});

test('it never stores the admin password, only the short-lived token', () => {
  assert.doesNotMatch(admin, /(localStorage|sessionStorage)[^\n]*password/i);
});

test('every getElementById reference resolves to an element id', () => {
  const referenced = [...new Set([...admin.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
  const defined = new Set([...admin.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const orphans = referenced.filter(id => !defined.has(id));
  assert.deepEqual(orphans, [], `orphan ids: ${orphans.join(', ')}`);
});
