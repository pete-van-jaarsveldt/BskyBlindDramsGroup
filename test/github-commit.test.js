import assert from 'node:assert/strict';
import test from 'node:test';
import { commitFiles, readRepoFile } from '../lib/github-commit.js';

const OPTS = {
  token: 'test-token',
  repo: 'owner/repo',
  branch: 'main',
  message: 'chore: test commit',
};

function json(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Records every call and replies with canned success responses.
function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    for (const [fragment, response] of Object.entries(overrides)) {
      if (url.includes(fragment)) return response;
    }
    if (url.includes('/git/ref/')) {
      return json(200, { object: { sha: 'BASE_COMMIT_SHA' } });
    }
    if (url.includes('/git/commits/')) {
      return json(200, { tree: { sha: 'BASE_TREE_SHA' } });
    }
    if (url.includes('/git/blobs')) {
      return json(201, { sha: `BLOB_SHA_${calls.length}` });
    }
    if (url.includes('/git/trees')) {
      return json(201, { sha: 'NEW_TREE_SHA' });
    }
    if (url.includes('/git/commits')) {
      return json(201, { sha: 'NEW_COMMIT_SHA', html_url: 'https://github.com/owner/repo/commit/NEW' });
    }
    if (url.includes('/git/refs/')) {
      return json(200, { object: { sha: 'NEW_COMMIT_SHA' } });
    }
    throw new Error(`unexpected url ${url}`);
  };
  impl.calls = calls;
  return impl;
}

test('commits two files as a single commit and updates the ref last', async () => {
  const fetchImpl = fakeFetch();
  const result = await commitFiles({
    ...OPTS,
    files: [
      { path: 'public/event.json', content: '{}\n', encoding: 'utf-8' },
      { path: 'public/banners/btc68.jpg', content: 'YmluYXJ5', encoding: 'base64' },
    ],
  }, fetchImpl);

  assert.equal(result.commitSha, 'NEW_COMMIT_SHA');
  assert.equal(result.commitUrl, 'https://github.com/owner/repo/commit/NEW');

  const sequence = fetchImpl.calls.map(c => `${c.method} ${c.url.split('/repos/owner/repo')[1]}`);
  assert.deepEqual(sequence, [
    'GET /git/ref/heads/main',
    'GET /git/commits/BASE_COMMIT_SHA',
    'POST /git/blobs',
    'POST /git/blobs',
    'POST /git/trees',
    'POST /git/commits',
    'PATCH /git/refs/heads/main',
  ]);
});

test('the tree is built on the base tree so untouched files survive', async () => {
  const fetchImpl = fakeFetch();
  await commitFiles({ ...OPTS, files: [{ path: 'a.txt', content: 'x', encoding: 'utf-8' }] }, fetchImpl);
  const tree = fetchImpl.calls.find(c => c.url.includes('/git/trees'));
  assert.equal(tree.body.base_tree, 'BASE_TREE_SHA');
  assert.equal(tree.body.tree.length, 1);
  assert.deepEqual(tree.body.tree[0], { path: 'a.txt', mode: '100644', type: 'blob', sha: 'BLOB_SHA_3' });
});

test('the ref update is not forced, so a concurrent push conflicts instead of being clobbered', async () => {
  const fetchImpl = fakeFetch();
  await commitFiles({ ...OPTS, files: [{ path: 'a.txt', content: 'x', encoding: 'utf-8' }] }, fetchImpl);
  const patch = fetchImpl.calls.find(c => c.method === 'PATCH');
  assert.equal(patch.body.sha, 'NEW_COMMIT_SHA');
  assert.notEqual(patch.body.force, true);
});

test('commits one file when only one is supplied', async () => {
  const fetchImpl = fakeFetch();
  await commitFiles({ ...OPTS, files: [{ path: 'public/event.json', content: '{}\n', encoding: 'utf-8' }] }, fetchImpl);
  assert.equal(fetchImpl.calls.filter(c => c.url.includes('/git/blobs')).length, 1);
});

test('a failure before the ref update leaves the ref untouched', async () => {
  const fetchImpl = fakeFetch({ '/git/trees': json(422, { message: 'tree too big' }) });
  await assert.rejects(
    () => commitFiles({ ...OPTS, files: [{ path: 'a.txt', content: 'x', encoding: 'utf-8' }] }, fetchImpl),
    /tree too big/,
  );
  assert.equal(fetchImpl.calls.some(c => c.method === 'PATCH'), false);
});

test('a 409 on the ref update surfaces as an error', async () => {
  const fetchImpl = fakeFetch({ '/git/refs/': json(409, { message: 'Update is not a fast forward' }) });
  await assert.rejects(
    () => commitFiles({ ...OPTS, files: [{ path: 'a.txt', content: 'x', encoding: 'utf-8' }] }, fetchImpl),
    /fast forward/,
  );
});

test('sends the token and the recommended accept header', async () => {
  let seen = null;
  const impl = async (url, init) => {
    seen = init.headers;
    return json(200, { content: Buffer.from('{}').toString('base64') });
  };
  await readRepoFile({ ...OPTS, path: 'public/event.json' }, impl);
  assert.equal(seen.Authorization, 'Bearer test-token');
  assert.equal(seen.Accept, 'application/vnd.github+json');
});

test('readRepoFile decodes base64 content', async () => {
  const impl = async () => json(200, { content: Buffer.from('{"number":67}').toString('base64'), encoding: 'base64' });
  const out = await readRepoFile({ ...OPTS, path: 'public/event.json' }, impl);
  assert.equal(out, '{"number":67}');
});

test('readRepoFile returns null when the file does not exist', async () => {
  const impl = async () => json(404, { message: 'Not Found' });
  const out = await readRepoFile({ ...OPTS, path: 'public/nope.json' }, impl);
  assert.equal(out, null);
});
