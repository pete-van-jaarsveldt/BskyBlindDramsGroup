# AGENTS.md — BskyBlindDramsGroup

## Architecture

- Single-file monolith: `server.js` (Express API) + `public/index.html` (vanilla HTML/CSS/JS SPA, ~2150 lines).
- No TypeScript, no bundler, no build step, no frontend framework.
- ESM modules (`"type": "module"` in package.json) — use `import`, not `require`.
- No database. In-memory `Map` for user sessions; `#BlindDrams` hashtag on Bluesky is the data store. Sessions are lost on server restart.
- Client polls `/api/feed` every 2s; server returns a cached feed populated by a background 5s polling loop.

## Commands

| What | Command |
|------|---------|
| Start server | `npm start` (→ `node server.js`, port 3000) |
| Run tests | `npm test` (→ `node --test`) |
| Lint/typecheck | **None configured** |
| Deploy | `fly deploy` (Fly.io, app `bskyblinddramsgroup`, region `lhr`) |

## Environment

Copy `.env.example` to `.env`. Required: `BSKY_HANDLE`, `BSKY_APP_PASSWORD`. Optional: `PORT` (default 3000), `KLIPY_API_KEY` (GIF picker disabled if missing). The app **crashes** if Bluesky credentials are missing.

## Key conventions / gotchas

- **Auto-hashtag**: The server appends `#BlindDrams` to every user post that doesn't already include it (`server.js:197-198`).
- **Dual agents**: `feedAgent` (singleton, read-only, used for polling) vs. per-session `userAgent` (created per login, used for posting/liking/uploading).
- **Diff-based rendering**: Client patches existing DOM nodes in-place on feed updates instead of rebuilding — prevents visual flicker.
- **Per-stage dedup**: Tasting panel tracks `posted[dram][stage]` booleans; a posted stage shows "Posted ✓" until text is edited, preventing duplicate posts during Bluesky indexing delay.
- **Blocked handles**: Posts from `toptags.bsky.social` and `trendtags.bsky.social` are filtered out.
- **GIF proxy**: Klipy GIFs go through server proxy routes (`/api/klipy/*`) — server downloads the GIF and re-uploads as a Bluesky blob to stay under the 1MB limit.

## Tests

- Located in `test/ui-features.test.js`. Pure static HTML regex assertions on `public/index.html` — no browser, no server.
- Run single test: `node --test --test-name-pattern="logo"`.
- New UI features must ship with a test verifying HTML structure.
