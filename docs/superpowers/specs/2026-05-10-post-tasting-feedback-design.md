# Post-Tasting Feedback — Design

Source: live user feedback from the BTC64 tasting on 2026-05-09.

## Goals

Make the feed and posting flow less stressful during a live tasting:

1. Feed updates without visual flashing
2. No accidental duplicate posts caused by the 10–15s post-to-display delay
3. Feed history is unbounded (no arbitrary 100-post cap on what's shown)
4. Remove cognitive overhead from the compose panel ("Post Everything" caused confusion)

Non-goals:

- Changing the scoring text (confirmed correct as-is)
- Changes to Klipy GIF picker, login, or event card

## Changes

### 1. Diff-based feed render

**Problem:** `/api/feed` is polled every 5s and the entire `#feed` container is wiped and rebuilt via `innerHTML`, causing a visible flash even when nothing changed. Reported as making the page hard to use.

**Fix:**

- Track rendered posts client-side in a `Map<uri, HTMLElement>`
- On each poll, compare incoming `posts` to the rendered map:
  - **New post (not in map)** → build node, insert at correct position (top for newest)
  - **Existing post** → patch in place: update like/repost/reply counts only, do not rebuild the node
  - **Missing post** → remove node
  - **No changes** → do nothing, no DOM mutation
- Keep author, text, images, timestamps cached on the node — they don't change after creation, so don't re-render them
- Drop the `feed-status` "updated Xs ago" line. It was triggering a per-second text update that contributed to the perceived churn. The pulse dot in the header is sufficient as a "we're live" signal.

Once flashing is gone, **drop the polling interval from 5s to 2s** for snappier feel. Capacity check:

- Server-side: one shared `feedAgent` polls Bluesky regardless of viewer count → ~30 calls/min total to `app.bsky.feed.searchPosts`
- That endpoint's quota is roughly 3000 points per 5 minutes → we use ~150, well within bounds
- Browsers hitting `/api/feed` every 2s just read a cached array in server memory; no upstream call

### 2. Lazy-load older posts; remove the count badge

**Problem:** The `N posts` badge plateaued at 99–100 because Bluesky's `searchPosts` returns at most 100 results per call. The number stopped reflecting reality once the tasting passed that threshold.

**Fix:**

- Remove the `#count-badge` element from the header entirely
- Server `/api/feed` accepts an optional `?cursor=<bsky-cursor>` query param; when present, forwards it to `searchPosts` to fetch the next page
- Server response includes the `cursor` returned by Bluesky (or `null` when exhausted) so the client knows whether more pages exist
- Client tracks `nextCursor` and the rendered post URIs
- When the user scrolls within ~400px of the bottom of `.feed-panel`, fetch the next page using `nextCursor` and append using the same diff renderer (new posts only, ignore duplicates)
- The 2s background poll continues to refresh only the **first page** (newest posts) — never overwrites the lazily-loaded older history

### 3. Per-stage Post buttons show "Posted ✓"; remove "Post Everything"

**Problem:** People re-clicked stage Post buttons during the 10–15s delay before their post appeared in the feed, producing duplicates. Separately, the "Post Everything" button at the bottom of the compose panel produced surprising combined posts (e.g. Finish + Score in one post) when used after partial individual posting. User asked to remove it entirely.

**Fix:**

- Track per-stage post state per dram: `posted[dram][stage] = true | false`
- After a successful per-stage post:
  - Button label → `Posted ✓`
  - Button disabled
  - Button styled in success-green (reuse the existing `.dram-tab.done` colour)
- If the user then **edits** that stage's text, score, or image list:
  - `posted[dram][stage] = false`
  - Button reverts to `Post`, enabled
- State resets on sign-out (already handled by the existing `showLoggedOut` reset loop)
- **Remove** the `.post-all-wrap` container, `#t-post-all` button, and `tPostAll` event handler entirely
- Keep the `tasting-feedback` div for per-stage success/error messages

## Files affected

- `server.js` — `/api/feed` cursor support
- `public/index.html` — feed renderer rewrite, count badge removal, lazy-load scroll handler, stage button state, removal of Post Everything button + handler

## Out of scope

- Server-side feed caching beyond what already exists (the polling cache is fine)
- A "real" pagination control (back/forward) — infinite scroll only
- Persisting `posted` state across page reloads (in-memory only is acceptable; sign-out clears it)
