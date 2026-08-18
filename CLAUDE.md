# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page web app for the "#BlindDrams" Bluesky whisky-tasting group, run by The Blind Tasting Consortium.
It aggregates every public post tagged `#blinddrams` into a live feed, and lets visitors sign in with their own Bluesky account to like posts and publish their own — either as free-form posts or as structured per-stage tasting notes, both with photo and GIF attachments.

## Commands

```bash
npm install        # install deps
npm start          # run the server (node server.js) on PORT (default 3000)
npm test           # node --test — runs test/ui-features.test.js (9 tests)
```

There is no build step, no bundler and no linter configured.
The frontend is a single static `public/index.html` served as-is.

Required env vars (see `.env.example`, loaded via dotenv):

- `BSKY_HANDLE`, `BSKY_APP_PASSWORD` — credentials for the **shared feed agent** (read-only polling). The server exits on boot if either is missing.
- `KLIPY_API_KEY` — optional. Without it the server only logs a warning and the three `/api/klipy/*` routes return 503, which disables the GIF picker in the UI.
- `PORT` — optional, defaults to 3000.

## Architecture

Two files do everything: `server.js` (Express API, ESM, ~376 lines) and `public/index.html` (vanilla JS + inline CSS, ~2200 lines, no framework).
There is **no database** — all state is in memory and lost on restart.

### Two distinct Bluesky agents

1. **Feed agent** (`feedAgent`, `server.js`) — one shared, read-only `BskyAgent` logged in with the app's own credentials. `fetchPage()` calls `searchPosts({ q: '#blinddrams', sort: 'latest', limit: 100 })` and `fetchFeed()` caches the first page in the module-level `feedPosts`/`feedCursor`. A `setInterval` re-polls every 5s; it detects expired sessions (401 / `ExpiredToken`) and re-logs-in, and tolerates upstream 5xx by keeping the last good feed while rate-limiting the log line to every 12th consecutive error. The server `app.listen`s **before** logging in so Fly health checks pass during boot.

2. **Per-user agents** (`sessions` Map) — each `/api/login` creates a fresh `BskyAgent`, logs in with the visitor's own handle + app password, and stores it under a random UUID `sessionId`. All write actions (post, like, unlike, upload) look the agent up by `sessionId`. Because the map is in-memory, **a server restart logs everyone out**; the frontend keeps `sessionId` in `sessionStorage` (`bsk_sid`) but the server won't recognize it after a restart, so the next write returns 401 and the client falls back to `showLoggedOut()`.

### API surface

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/feed` | — | Cached first page; with `?cursor=` fetches an older page on demand without touching the cache |
| `POST /api/login` | — | Creates a session, returns `sessionId` + profile |
| `POST /api/logout` | sessionId | Drops the session |
| `POST /api/upload` | sessionId | Base64 image → `uploadBlob` → blob ref |
| `POST /api/post` | sessionId | Posts text + optional image embed |
| `GET /api/viewer-likes` | sessionId (query) | Which of the newest 100 tagged posts this user already liked |
| `POST /api/like` / `POST /api/unlike` | sessionId | Like / delete-like |
| `GET /api/klipy/trending` / `GET /api/klipy/search` | — | Server-side proxy to the Klipy GIF API |
| `POST /api/klipy/upload` | sessionId | Fetches a Klipy GIF server-side and re-uploads it as a Bluesky blob |
| `GET /healthz` | — | Fly health check |

### Request flow conventions

- Client sends `sessionId` in the JSON body (or query string for `/api/viewer-likes`); the server resolves it to a session or returns 401.
- Image upload is two-step: the client base64-encodes the file and POSTs to `/api/upload`, which calls `uploadBlob` and returns a blob ref; the client holds blob refs in `pendingBlobs` / `stageImages` and sends them in the `/api/post` body, where they're wrapped into an `app.bsky.embed.images` embed. `express.json` limit is raised to `10mb` to fit base64 images.
- `/api/post` accepts each blob entry either as a raw blob ref **or** as `{ blob, alt, aspectRatio }`, so callers can supply alt text (the event-card button does; the compose panel currently doesn't).
- `/api/post` **always ensures the `#BlindDrams` tag** is present (appends it if the text lacks it), then runs the text through `RichText.detectFacets` so links/mentions/tags are properly faceted.
- The Klipy API key never reaches the browser — both read routes are proxied, and `/api/klipy/upload` does the GIF fetch server-side so the GIF lands as a real Bluesky image blob rather than an external link card.

### Feed rendering specifics

- `extractImages(embed)` in `server.js` normalizes Bluesky embed shapes into a flat image list. It special-cases external embeds: direct `.gif` URLs, Tenor/Giphy page URLs (regex-extracts the ID to build an iframe embed URL with `isGif: true`), and non-GIF link cards with a thumbnail. It recurses into `recordWithMedia`. When changing how media displays, this is the function to edit, and the matching render code is in `renderPost()` in `index.html`.
- `BLOCKED_HANDLES` (a Set in `server.js`) filters out tag-spam accounts from the feed.
- The frontend polls `/api/feed` every **2s** and renders as a **diff**, not a re-render: `renderedPosts` (uri → `{ node, likeCount, repostCount, replyCount, firstPage }`) lets `pollFeed()` patch only changed counts via `updatePostCounts()` and insert new nodes in place. This is deliberate — a full re-render would throw away optimistic like state and scroll position.
- Infinite scroll (`loadMore()`) appends older cursor pages with `firstPage: false`. `pollFeed()` only deletes nodes marked `firstPage: true`, so lazy-loaded posts survive the diff. Once the user scrolls, `hasLazyLoaded` freezes cursor management so polling stops overwriting `nextCursor`.
- `/api/viewer-likes` is **not** polled. It is called once by `loadViewerLikes()` on login and on page load with a stored session; `refreshLikeButtons()` then patches existing nodes in place.

### Frontend compose modes

`index.html` has two compose modes toggled by tabs:

**Tasting** (default) — 5 drams × 5 collapsible stages, held in client-side `dramState` / `stageImages` / `posted`, all keyed 1–5. The stages are defined once in the `STAGES` array (`appearance`, `nose`, `palate`, `finish`, `score`), each with a `prefix` used to format the post text. Every stage has its own textarea, its own image/GIF list, its own **Post** button and a status line ("draft · 2 photos"). Stage blocks behave as an accordion. `stageText()` formats one stage (e.g. `Dram 2 - On the nose: ...`); the score stage renders `⭐` repeats plus the matching long blurb from `SCORE_FULL`. Posting one stage clears only that stage's images and sets `posted[dram][stage]`, which flips the button to "Posted ✓" — and **any subsequent edit to that stage's text, score or images resets the flag** so it can be posted again.

**Free Post** — textarea + emoji picker (`emoji-picker-element` from jsDelivr) + up to 4 images/GIFs + a grapheme-aware 300-char ring that reserves `SUFFIX_LEN` characters for the hashtag the server will append.

Images in both modes go through `downscaleImage()` before upload: files over ~1.9MB are canvas-re-encoded to JPEG at max 1920px on the long edge, stepping quality down until they fit under Bluesky's 2MB blob limit. GIFs are passed through untouched, since a canvas round-trip would drop the animation. Both modes cap at 4 attachments.

### Header event card

The current tasting event is **hardcoded in `public/index.html`**, not configured: the `TASTING_START_ISO` constant plus the `#header-event` markup (kicker, title, and a `btcNN-theme.jpeg` from `public/`).
`updateCountdown()` runs every 60s and **hides the whole card once the start time passes**.
When signed in, a "Post this" button appears that uploads the theme image and posts it with the live countdown text.
Setting up the next event means editing all of: `TASTING_START_ISO`, the three `header-event` spans, the image filename, the hardcoded post text in the `event-post-btn` handler, and the `BTC` assertions in `test/ui-features.test.js`.

## Tests

`test/ui-features.test.js` uses the built-in `node:test` runner and works by reading `public/index.html` **as a string** and asserting against it with regexes — there is no DOM, jsdom or browser involved.
So the tests are regression guardrails on the markup and inline script (does this element/constant/wiring still exist?), not behavioural tests.
Two are worth knowing about:

- **`getElementById` orphan check** — every `getElementById('x')` must have a matching `id="x"`. A missing id throws, and because everything lives in one inline `<script>`, that single throw kills the whole script and breaks login. This test exists because that actually happened (`73d3fdd`).
- **Event-card assertions** hardcode `BTC67` / `World Cup Whiskies` / `btc67-theme.jpeg`, so they must be updated whenever the event changes.

The `Dockerfile` does not copy `test/`, so tests are a dev-only concern and never ship in the image.

## Deployment

Deployed to Fly.io (`fly.toml`, app `bskyblinddramsgroup`, region `lhr`) via the `Dockerfile` (node:22-alpine, single 256MB shared-CPU machine, `min_machines_running = 1` and `auto_stop_machines = 'off'` so the feed poller stays alive).
`/healthz` is the health-check endpoint and `app.set('trust proxy', true)` is set for Fly's proxy.
`fly deploy` builds and ships.
Env vars are set as Fly secrets, not committed (`.env` is gitignored, and `fly.toml`/`.env` are in `.dockerignore`).

## Gotchas

- **One inline script, no modules.** Any thrown error at load time takes the entire frontend with it — including login. Prefer defensive lookups over assuming an element exists.
- **`showLoggedIn` / `showLoggedOut` are monkey-patched** at the very bottom of the script to also toggle the GIF buttons and the event-post button. The `Init` block runs *before* that patch, which is why a separate `if (sessionId) enableGifBtns(true)` follows it. New login/logout side effects belong in `enableGifBtns()` or the patch, not only in the original functions.
- **Feed intervals differ on purpose:** server polls Bluesky every 5s, browser polls the server every 2s.
- **Untracked scratch files** live in the repo root (`filter_results.py`, `search_results.json`, `ranked_candidates.json`, `bluesky_whisky_accounts_raw.json`, `whisky-candidates.html`) from a one-off exercise to find whisky accounts on Bluesky. They are not part of the app and are not referenced by it.
- **codebase-memory graph coverage is poor here.** The indexer extracts neither JS inside `<script>` blocks nor Express routes registered as inline callbacks, so the graph knows only 4 functions, all from `server.js`. A `search_graph` miss means "not extracted", not "doesn't exist" — use grep/Read for the frontend and the API surface.
