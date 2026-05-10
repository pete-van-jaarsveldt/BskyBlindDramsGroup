import 'dotenv/config';
import { BskyAgent, RichText } from '@atproto/api';
import express from 'express';
import { randomUUID } from 'crypto';

const { BSKY_HANDLE, BSKY_APP_PASSWORD, PORT = 3000, KLIPY_API_KEY } = process.env;

if (!BSKY_HANDLE || !BSKY_APP_PASSWORD) {
  console.error('Missing BSKY_HANDLE or BSKY_APP_PASSWORD in .env');
  process.exit(1);
}
if (!KLIPY_API_KEY) {
  console.warn('KLIPY_API_KEY not set — GIF picker will be unavailable');
}

const BLOCKED_HANDLES = new Set(['toptags.bsky.social', 'trendtags.bsky.social']);
const HASHTAG = '#BlindDrams';

// ── Feed agent (read-only, uses app credentials) ─────────────────────────────
const feedAgent = new BskyAgent({ service: 'https://bsky.social' });
let feedPosts = [];

async function loginFeed() {
  await feedAgent.login({ identifier: BSKY_HANDLE, password: BSKY_APP_PASSWORD });
  console.log(`Feed agent logged in as ${BSKY_HANDLE}`);
}

function extractImages(embed) {
  if (!embed) return [];
  switch (embed.$type) {
    case 'app.bsky.embed.images#view':
      return embed.images.map(i => ({ thumb: i.thumb, fullsize: i.fullsize, alt: i.alt || '' }));

    case 'app.bsky.embed.external#view': {
      const ext = embed.external;
      if (!ext) return [];

      const uri = ext.uri || '';

      // Direct GIF URL (e.g. media.tenor.com/....gif, media.giphy.com/....gif)
      if (/\.gif(\?|$)/i.test(uri)) {
        return [{ gif: uri, thumb: ext.thumb, alt: ext.title || '', isGif: true }];
      }

      // Tenor page URL → extract ID for iframe embed
      const tenorMatch = uri.match(/tenor\.com\/view\/.*?-(\d+)$/);
      if (tenorMatch) {
        return [{ embedUrl: `https://tenor.com/embed/${tenorMatch[1]}`, alt: ext.title || '', isGif: true }];
      }

      // Giphy page URL → extract ID for iframe embed
      const giphyMatch = uri.match(/giphy\.com\/gifs\/(?:.*-)?([a-zA-Z0-9]+)$/);
      if (giphyMatch) {
        return [{ embedUrl: `https://giphy.com/embed/${giphyMatch[1]}`, alt: ext.title || '', isGif: true }];
      }

      // Non-GIF external link with a thumbnail (link card)
      if (ext.thumb) return [{ thumb: ext.thumb, fullsize: ext.thumb, alt: ext.title || '' }];
      return [];
    }

    case 'app.bsky.embed.recordWithMedia#view':
      return extractImages(embed.media);   // recurse into the media part

    default:
      return [];
  }
}

async function fetchFeed() {
  const res = await feedAgent.app.bsky.feed.searchPosts({
    q: '#blinddrams',
    sort: 'latest',
    limit: 100,
  });

  const fresh = [];
  for (const post of res.data.posts) {
    if (BLOCKED_HANDLES.has(post.author.handle)) continue;
    const author = post.author;
    fresh.push({
      uri:    post.uri,
      cid:    post.cid,
      author: {
        handle:      author.handle,
        displayName: author.displayName || author.handle,
        avatar:      author.avatar || null,
      },
      text:        post.record?.text ?? '',
      createdAt:   post.record?.createdAt ?? post.indexedAt,
      likeCount:   post.likeCount   ?? 0,
      repostCount: post.repostCount ?? 0,
      replyCount:  post.replyCount  ?? 0,
      url:    `https://bsky.app/profile/${author.handle}/post/${post.uri.split('/').pop()}`,
      images: extractImages(post.embed),
    });
  }

  feedPosts = fresh;
}

// ── User sessions: sessionId → { agent, handle, displayName, avatar, likes }──
const sessions = new Map();

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));   // allow base64-encoded images
app.use(express.static('public'));

// Feed
app.get('/api/feed', (_req, res) => {
  res.json({ posts: feedPosts, total: feedPosts.length });
});

// Login
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body ?? {};
  if (!identifier || !password)
    return res.status(400).json({ error: 'identifier and password required' });

  const userAgent = new BskyAgent({ service: 'https://bsky.social' });
  try {
    await userAgent.login({ identifier, password });
    const profile = await userAgent.getProfile({ actor: userAgent.session.did });
    const sessionId = randomUUID();
    sessions.set(sessionId, {
      agent:       userAgent,
      handle:      userAgent.session.handle,
      displayName: profile.data.displayName || userAgent.session.handle,
      avatar:      profile.data.avatar || null,
      likes:       new Map(),   // postUri → likeUri
    });
    console.log(`User logged in: ${userAgent.session.handle}`);
    res.json({
      sessionId,
      handle:      userAgent.session.handle,
      displayName: profile.data.displayName || userAgent.session.handle,
      avatar:      profile.data.avatar || null,
    });
  } catch (err) {
    console.error('Login failed:', err.message);
    res.status(401).json({ error: 'Invalid handle or password' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  const { sessionId } = req.body ?? {};
  if (sessionId) sessions.delete(sessionId);
  res.json({ ok: true });
});

// Upload image → returns BlueSky blob ref
app.post('/api/upload', async (req, res) => {
  const { sessionId, imageData, mimeType } = req.body ?? {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  try {
    const buffer = Buffer.from(imageData, 'base64');
    const result = await session.agent.uploadBlob(buffer, { encoding: mimeType });
    res.json({ blob: result.data.blob });
  } catch (err) {
    console.error('Upload failed:', err.message);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

// Post
app.post('/api/post', async (req, res) => {
  const { sessionId, text, blobs } = req.body ?? {};
  if (!sessionId || !text?.trim())
    return res.status(400).json({ error: 'sessionId and text required' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  const hasTag  = /\#blinddrams\b/i.test(text);
  const fullText = hasTag ? text.trim() : `${text.trim()} ${HASHTAG}`;

  const rt = new RichText({ text: fullText });
  await rt.detectFacets(session.agent);

  // Build image embed if any blobs were uploaded
  const embed = blobs?.length
    ? { $type: 'app.bsky.embed.images', images: blobs.map(b => ({ image: b, alt: b.alt ?? '' })) }
    : undefined;

  try {
    const result = await session.agent.post({
      text:   rt.text,
      facets: rt.facets,
      langs:  ['en'],
      embed,
    });
    console.log(`Posted for ${session.handle}: ${fullText}`);
    res.json({ ok: true, uri: result.uri });
  } catch (err) {
    console.error('Post failed:', err.message);
    res.status(500).json({ error: 'Failed to post' });
  }
});

// Viewer likes — returns which feed posts the logged-in user has already liked
app.get('/api/viewer-likes', async (req, res) => {
  const { sessionId } = req.query;
  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  try {
    const result = await session.agent.app.bsky.feed.searchPosts({
      q: '#blinddrams',
      sort: 'latest',
      limit: 100,
    });
    const likes = {};
    for (const post of result.data.posts) {
      if (post.viewer?.like) likes[post.uri] = post.viewer.like;
    }
    res.json({ likes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Like
app.post('/api/like', async (req, res) => {
  const { sessionId, uri, cid } = req.body ?? {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  try {
    const result = await session.agent.like(uri, cid);
    session.likes.set(uri, result.uri);
    res.json({ likeUri: result.uri });
  } catch (err) {
    console.error('Like failed:', err.message);
    res.status(500).json({ error: 'Failed to like' });
  }
});

// Unlike
app.post('/api/unlike', async (req, res) => {
  const { sessionId, likeUri } = req.body ?? {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: 'Not logged in' });

  try {
    await session.agent.deleteLike(likeUri);
    // Remove from session likes map
    for (const [uri, lUri] of session.likes) {
      if (lUri === likeUri) { session.likes.delete(uri); break; }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Unlike failed:', err.message);
    res.status(500).json({ error: 'Failed to unlike' });
  }
});

// ── Klipy GIF proxy ───────────────────────────────────────────────────────────
const KLIPY_BASE = `https://api.klipy.com/api/v1/${KLIPY_API_KEY}/gifs`;

const KLIPY_CUSTOMER_ID = 'BlindDrams';

app.get('/api/klipy/trending', async (_req, res) => {
  if (!KLIPY_API_KEY) return res.status(503).json({ error: 'GIF picker not configured' });
  try {
    const r = await fetch(`${KLIPY_BASE}/trending?per_page=24&customer_id=${KLIPY_CUSTOMER_ID}`);
    const json = await r.json();
    res.json(json);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/klipy/search', async (req, res) => {
  if (!KLIPY_API_KEY) return res.status(503).json({ error: 'GIF picker not configured' });
  const { q, page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  try {
    const r = await fetch(`${KLIPY_BASE}/search?q=${encodeURIComponent(q)}&per_page=24&page=${page}&customer_id=${KLIPY_CUSTOMER_ID}`);
    const json = await r.json();
    res.json(json);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Fetch a Klipy GIF by URL and upload it as a Bluesky blob
app.post('/api/klipy/upload', async (req, res) => {
  if (!KLIPY_API_KEY) return res.status(503).json({ error: 'GIF picker not configured' });
  const { sessionId, gifUrl } = req.body ?? {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: 'Not logged in' });
  if (!gifUrl) return res.status(400).json({ error: 'gifUrl required' });

  try {
    const gifRes = await fetch(gifUrl);
    if (!gifRes.ok) throw new Error(`Failed to fetch GIF: ${gifRes.status}`);
    const buffer = Buffer.from(await gifRes.arrayBuffer());
    const mimeType = gifRes.headers.get('content-type') || 'image/gif';
    const result = await session.agent.uploadBlob(buffer, { encoding: mimeType });
    res.json({ blob: result.data.blob });
  } catch (err) {
    console.error('Klipy GIF upload failed:', err.message);
    res.status(500).json({ error: 'Failed to upload GIF' });
  }
});

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  // Listen first so health checks pass, then log in and load feed in background
  app.listen(PORT, '0.0.0.0', () =>
    console.log(`Group feed running at http://0.0.0.0:${PORT}`)
  );

  await loginFeed();
  await fetchFeed();
  console.log(`Feed loaded: ${feedPosts.length} posts`);

  let consecutiveErrors = 0;
  setInterval(async () => {
    try {
      await fetchFeed();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      if (err.status === 401 || err.message?.includes('ExpiredToken')) {
        console.warn('Feed session expired, re-logging in…');
        try { await loginFeed(); } catch {}
      } else if (err.status >= 500 || err.message?.includes('500')) {
        // Transient upstream error — keep last good feed data, log only if persistent
        if (consecutiveErrors % 12 === 1) {
          console.warn(`Upstream 5xx (${consecutiveErrors} in a row), keeping last good feed…`);
        }
      } else {
        console.error('Poll error:', err.message);
      }
    }
  }, 5_000);
})();
