import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = readFileSync(join(root, 'server.js'), 'utf8');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');

// Pull out one route handler so assertions can be scoped to it rather than to the
// whole file — otherwise "the guard exists somewhere" passes vacuously.
function routeBody(source, method, path) {
  const start = source.indexOf(`app.${method}('${path}'`);
  assert.notEqual(start, -1, `route ${method} ${path} not found`);
  const end = source.indexOf('\n});', start);
  assert.notEqual(end, -1, `end of ${method} ${path} not found`);
  return source.slice(start, end);
}

test('the server refuses to like your own post, using the DID from the URI', () => {
  const like = routeBody(server, 'post', '/api/like');
  assert.match(like, /isOwnPost\(/);
  assert.match(like, /status\(403\)/);
});

test('the guard is imported from the shared helper, not reimplemented inline', () => {
  assert.match(server, /import \{[^}]*isOwnPost[^}]*\} from '\.\/lib\/post-identity\.js'/);
  // no ad-hoc DID slicing in the route
  assert.doesNotMatch(routeBody(server, 'post', '/api/like'), /split\('\/'\)\[2\]/);
});

test('unliking your own post is still allowed, so pre-existing self-likes are not stranded', () => {
  const unlike = routeBody(server, 'post', '/api/unlike');
  assert.doesNotMatch(unlike, /isOwnPost/);
  assert.doesNotMatch(unlike, /status\(403\)/);
});

test('login returns the viewer DID so the client can gate the button on the same identity', () => {
  const login = routeBody(server, 'post', '/api/login');
  assert.match(login, /did:\s*userAgent\.session\.did/);
});

test('the feed hides the like affordance on your own posts', () => {
  assert.match(html, /isOwnPostUri\(/);
  assert.match(html, /like your own post/i);
});

test('an already-liked own post keeps an enabled button so it can be undone', () => {
  // The gate must consider `liked`, not disable unconditionally.
  assert.match(html, /isOwnPostUri\([^)]*\)\s*&&\s*!liked/);
});

test('refreshLikeButtons applies the same rule, so login does not re-enable self-like', () => {
  const start = html.indexOf('function refreshLikeButtons');
  const body = html.slice(start, html.indexOf('\n}', start));
  assert.match(body, /isOwnPostUri\(/);
});
