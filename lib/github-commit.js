const API = 'https://api.github.com';

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'blinddrams-admin',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function call(fetchImpl, token, method, url, body) {
  const res = await fetchImpl(url, {
    method,
    headers: headers(token),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.message || `GitHub ${method} ${url} failed with ${res.status}`);
  }
  return payload;
}

export async function readRepoFile({ token, repo, branch, path }, fetchImpl = fetch) {
  const url = `${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetchImpl(url, { method: 'GET', headers: headers(token) });
  if (res.status === 404) return null;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.message || `GitHub read of ${path} failed with ${res.status}`);
  return Buffer.from(payload.content || '', 'base64').toString('utf8');
}

// Writes every file in one commit. Nothing is visible to GitHub Actions until the
// final ref update, so any earlier failure leaves the branch exactly as it was.
export async function commitFiles({ token, repo, branch, message, files }, fetchImpl = fetch) {
  const base = `${API}/repos/${repo}`;

  const ref = await call(fetchImpl, token, 'GET', `${base}/git/ref/heads/${branch}`);
  const baseCommitSha = ref.object.sha;

  const baseCommit = await call(fetchImpl, token, 'GET', `${base}/git/commits/${baseCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  const entries = [];
  for (const file of files) {
    const blob = await call(fetchImpl, token, 'POST', `${base}/git/blobs`, {
      content: file.content,
      encoding: file.encoding,
    });
    entries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const tree = await call(fetchImpl, token, 'POST', `${base}/git/trees`, {
    base_tree: baseTreeSha,
    tree: entries,
  });

  const commit = await call(fetchImpl, token, 'POST', `${base}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [baseCommitSha],
  });

  // Deliberately not forced: a concurrent push should 409 rather than be discarded.
  await call(fetchImpl, token, 'PATCH', `${base}/git/refs/heads/${branch}`, { sha: commit.sha });

  return { commitSha: commit.sha, commitUrl: commit.html_url };
}
