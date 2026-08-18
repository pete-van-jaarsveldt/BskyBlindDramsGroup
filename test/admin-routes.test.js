import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = readFileSync(join(root, 'server.js'), 'utf8');

test('admin routes degrade to 503 when ADMIN_PASSWORD is unset, like the Klipy routes do', () => {
  assert.match(server, /ADMIN_PASSWORD/);
  assert.match(server, /admin not configured/i);
});

test('the password is compared with the timing-safe helper, never with ===', () => {
  assert.match(server, /secretMatches\(/);
  assert.doesNotMatch(server, /password\s*===\s*ADMIN_PASSWORD/);
});

test('login attempts are rate limited per IP', () => {
  assert.match(server, /ADMIN_MAX_ATTEMPTS\s*=\s*5/);
  assert.match(server, /ADMIN_ATTEMPT_WINDOW_MS/);
  assert.match(server, /status\(429\)/);
});

test('admin tokens expire', () => {
  assert.match(server, /ADMIN_TOKEN_TTL_MS/);
  assert.match(server, /adminSessions/);
});

test('the admin password VALUE is never logged', () => {
  // Naming the variable inside a warning string is fine and mirrors the existing
  // KLIPY_API_KEY pattern ("ADMIN_PASSWORD not set"). What must never happen is
  // the value reaching a log — interpolated into a template literal, or passed
  // as a console argument.
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*\$\{[^}]*ADMIN_PASSWORD/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*,\s*ADMIN_PASSWORD\b/);
  assert.doesNotMatch(server, /console\.[a-z]+\(\s*ADMIN_PASSWORD\b/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*\$\{[^}]*\bpassword\b/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*,\s*password\b/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*req\.body\.password/);
});
