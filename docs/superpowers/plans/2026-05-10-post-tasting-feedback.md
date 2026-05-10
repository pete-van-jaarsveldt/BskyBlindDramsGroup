# Post-Tasting Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the seven user-feedback items from the BTC64 live tasting: stop the feed flashing, drop the misleading post-count badge, lazy-load older posts, mark per-stage post buttons as "Posted ✓" to prevent dupes, and remove the confusing "Post Everything" button.

**Architecture:** This is a vanilla single-file Express server (`server.js`) serving a single-file SPA (`public/index.html`). No bundler, no test framework, no TypeScript. Changes follow the existing pattern: minimal in-place edits to those two files. Verification is manual via the live deploy on Fly.io (`fly deploy` after each commit) or local run (`PORT=3000 node server.js`).

**Tech Stack:** Node 22, Express, `@atproto/api`, vanilla JS in the browser, Fly.io for hosting.

---

## File Map

| File | Change |
|------|--------|
| `server.js` | Add optional `?cursor=` query param to `/api/feed`; return cursor in response |
| `public/index.html` | Diff-based feed render; drop polling to 2s; remove `#count-badge` and `#feed-status`; infinite-scroll lazy-load; per-stage "Posted ✓" state; remove "Post Everything" button |
| `docs/superpowers/specs/2026-05-10-post-tasting-feedback-design.md` | Reference (already committed) |

No new files. No test files (no test framework in the repo).

---

## Task 1: Server cursor support on `/api/feed`

**Files:**
- Modify: `server.js` — `fetchFeed()` and the `/api/feed` Express handler

**Goal:** Support fetching older pages of `#blinddrams` posts so the client can lazy-load history. Backward compatible — calls without `?cursor=` behave exactly as today.

- [ ] **Step 1: Refactor `fetchFeed()` to accept an optional cursor and return the result instead of mutating shared state**

In `server.js`, replace the existing `fetchFeed` function (around lines 67–97):

```js
async function fetchPage(cursor) {
  const res = await feedAgent.app.bsky.feed.searchPosts({
    q: '#blinddrams',
    sort: 'latest',
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });

  const posts = [];
  for (const post of res.data.posts) {
    if (BLOCKED_HANDLES.has(post.author.handle)) continue;
    const author = post.author;
    posts.push({
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

  return { posts, cursor: res.data.cursor || null };
}

async function fetchFeed() {
  const page = await fetchPage();
  feedPosts = page.posts;
  feedCursor = page.cursor;
}
```

Also add a module-level `feedCursor` variable. Find:

```js
let feedPosts = [];
```

Replace with:

```js
let feedPosts = [];
let feedCursor = null;
```

- [ ] **Step 2: Update the `/api/feed` handler to support `?cursor=`**

Replace the existing `/api/feed` handler (around lines 108–110):

```js
app.get('/api/feed', async (req, res) => {
  const { cursor } = req.query;
  if (cursor) {
    // Lazy-load older page — fetch on demand, do not affect the cached first page
    try {
      const page = await fetchPage(cursor);
      return res.json({ posts: page.posts, cursor: page.cursor });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  }
  // No cursor → return the cached first page plus the cursor that points to older posts
  res.json({ posts: feedPosts, cursor: feedCursor });
});
```

- [ ] **Step 3: Manually verify with curl**

Run locally (`PORT=3000 node server.js` in another terminal — assumes a `.env` is present), then:

```bash
curl -s http://localhost:3000/api/feed | head -c 200
# Expected: JSON starting {"posts":[...]} with a cursor field

# Take a cursor from a successful run and re-curl with it:
curl -s "http://localhost:3000/api/feed?cursor=PASTE_CURSOR_HERE" | head -c 200
# Expected: A different page of older posts with a (probably new) cursor
```

If you don't want to run locally, skip — Task 5 will exercise the path end-to-end.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "Add cursor pagination support to /api/feed"
```

---

## Task 2: Diff-based feed renderer (kills the flash)

**Files:**
- Modify: `public/index.html` — replace the `pollFeed` function and add a renderer state object

**Goal:** Stop wiping `#feed`'s `innerHTML` on every poll. Track posts by URI in a `Map`, mutate only the changed nodes. After this task the page should be visually static between polls when nothing has changed.

- [ ] **Step 1: Add a renderer state Map at the top of the script section**

In `public/index.html`, find this line (around line 875):

```js
let lastUpdated  = null;
```

Replace with:

```js
let lastUpdated  = null;
const renderedPosts = new Map(); // uri → { node, likeCount, repostCount, replyCount }
```

- [ ] **Step 2: Add a helper function that updates an existing post node's counts in place**

Find the `renderPost` function (around line 1221) and add this helper immediately after its closing brace:

```js
function updatePostCounts(entry, post) {
  if (entry.likeCount !== post.likeCount) {
    const lc = entry.node.querySelector('.like-btn .lc');
    if (lc) lc.textContent = post.likeCount;
    entry.likeCount = post.likeCount;
  }
  if (entry.replyCount !== post.replyCount) {
    // Reply count is inside the second .action-btn span
    const buttons = entry.node.querySelectorAll('.post-footer .action-btn');
    if (buttons[1]) {
      const span = buttons[1].querySelector('span');
      if (span) span.textContent = post.replyCount;
    }
    entry.replyCount = post.replyCount;
  }
  if (entry.repostCount !== post.repostCount) {
    const buttons = entry.node.querySelectorAll('.post-footer .action-btn');
    if (buttons[2]) {
      const span = buttons[2].querySelector('span');
      if (span) span.textContent = post.repostCount;
    }
    entry.repostCount = post.repostCount;
  }
}
```

- [ ] **Step 3: Replace `pollFeed()` with a diff renderer**

Find `pollFeed` (around line 1531) and replace the entire function with:

```js
async function pollFeed() {
  try {
    const r = await fetch('/api/feed');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { posts, cursor } = await r.json();
    feedErrEl.style.display = 'none';
    // Only seed nextCursor from polling until the user starts lazy-loading;
    // afterwards loadMore manages it
    if (!hasLazyLoaded) nextCursor = cursor;

    // Empty state
    if (!posts.length) {
      if (renderedPosts.size > 0) {
        // Was non-empty, now empty — wipe and show placeholder
        feedEl.innerHTML = '';
        feedEl.appendChild(emptyEl);
        renderedPosts.clear();
      } else if (!feedEl.contains(emptyEl)) {
        feedEl.appendChild(emptyEl);
      }
      emptyEl.style.display = 'block';
      return;
    }

    // Remove the empty placeholder if it's still in the DOM
    if (feedEl.contains(emptyEl)) feedEl.removeChild(emptyEl);

    // Build the set of incoming URIs to detect deletions
    const incomingUris = new Set(posts.map(p => p.uri));

    // Remove posts no longer present (only consider posts inside the first-page set;
    // older lazy-loaded posts have URIs not in `posts` and must be preserved)
    for (const [uri, entry] of renderedPosts) {
      if (entry.firstPage && !incomingUris.has(uri)) {
        entry.node.remove();
        renderedPosts.delete(uri);
      }
    }

    // Walk incoming posts in order, inserting/patching as we go
    let prevNode = null; // tracks where to insert the next new node
    for (const post of posts) {
      let entry = renderedPosts.get(post.uri);
      if (entry) {
        // Existing — patch counts only
        updatePostCounts(entry, post);
        entry.firstPage = true;
        prevNode = entry.node;
      } else {
        // New post — build and insert in correct order
        const node = renderPost(post);
        if (prevNode && prevNode.nextSibling) {
          feedEl.insertBefore(node, prevNode.nextSibling);
        } else if (prevNode) {
          feedEl.appendChild(node);
        } else {
          feedEl.insertBefore(node, feedEl.firstChild);
        }
        renderedPosts.set(post.uri, {
          node,
          likeCount: post.likeCount,
          repostCount: post.repostCount,
          replyCount: post.replyCount,
          firstPage: true,
        });
        prevNode = node;
      }
    }

    lastUpdated = new Date();
  } catch (err) {
    feedErrEl.textContent = `Feed error: ${err.message}`;
    feedErrEl.style.display = 'block';
  }
}
```

Also add this near the top with other state (just after `renderedPosts` from Step 1):

```js
let nextCursor    = null;
let hasLazyLoaded = false;
```

- [ ] **Step 4: Manually verify in the browser**

Run the app (or deploy with `fly deploy`). Open the page, watch the feed for 30 seconds without taking any action.

Expected: NO flash on every poll. The DOM is unchanged when there are no new posts. Use DevTools → Elements panel and watch the `#feed` subtree — nodes should not flicker or be replaced.

If you see flashing, check that `renderedPosts` is being populated (drop a `console.log(renderedPosts.size)` at the end of `pollFeed`).

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Diff-based feed render to stop flashing on every poll"
```

---

## Task 3: Drop poll to 2s and remove the noisy `#feed-status` text

**Files:**
- Modify: `public/index.html`

**Goal:** Now that the feed doesn't flash, polling can be more aggressive. Also remove the per-second "updated Xs ago" text update that contributed to perceived churn.

- [ ] **Step 1: Remove the `#feed-status` element from the header**

Find this in the `<header>` block (around line 575):

```html
<span id="count-badge">0 posts</span>
<span id="feed-status">connecting…</span>
```

Replace with:

```html
<span id="count-badge">0 posts</span>
```

(The badge is removed in Task 4 — leave it for now to keep tasks atomic.)

- [ ] **Step 2: Remove the JS reference to `feedStatus`**

Find these lines near the top of the script (around lines 835–839):

```js
const feedEl       = document.getElementById('feed');
const feedStatus   = document.getElementById('feed-status');
const badgeEl      = document.getElementById('count-badge');
```

Replace with:

```js
const feedEl       = document.getElementById('feed');
const badgeEl      = document.getElementById('count-badge');
```

- [ ] **Step 3: Remove all `feedStatus.textContent = …` assignments**

Search for `feedStatus` in the file. There are three occurrences inside `pollFeed` from before Task 2 — Task 2 already removed them, so nothing to do here. If a `feedStatus.textContent` line still exists, delete it.

To verify nothing references the removed binding:

```bash
grep -n "feedStatus" public/index.html
```

Expected: no matches.

- [ ] **Step 4: Drop polling interval from 5s to 2s**

Find this line near the end of the script (around line 1642):

```js
setInterval(pollFeed, 5_000);
```

Replace with:

```js
setInterval(pollFeed, 2_000);
```

- [ ] **Step 5: Manually verify**

Reload the page. Network tab → filter for `/api/feed`. Expected: a request every 2s. The header should still look correct (with the count badge present — that's removed next task).

- [ ] **Step 6: Commit**

```bash
git add public/index.html
git commit -m "Drop poll to 2s and remove feed-status text"
```

---

## Task 4: Remove the post count badge

**Files:**
- Modify: `public/index.html`

**Goal:** The `99 posts` badge plateaued at 100 because of the API limit and is misleading. Drop it.

- [ ] **Step 1: Remove the badge element from the header**

Find (around line 575):

```html
<span id="count-badge">0 posts</span>
```

Delete the line entirely.

- [ ] **Step 2: Remove the JS reference and its assignment**

Find (around line 837):

```js
const badgeEl      = document.getElementById('count-badge');
```

Delete the line.

Inside `pollFeed`, search for any `badgeEl.textContent = …`. If Task 2's rewrite already removed all such lines, you're done. Otherwise delete them.

Verify:

```bash
grep -n "badgeEl\|count-badge" public/index.html
```

Expected: no matches.

- [ ] **Step 3: Remove the responsive CSS rule that targets `#count-badge`**

Find (around line 605):

```css
#count-badge { margin-left:58px; }
```

Delete the line. Also remove the corresponding CSS in the main block (around lines 79–84):

```css
#count-badge {
  background:rgba(228,154,19,.16); color:var(--accent2);
  border:1px solid rgba(228,154,19,.42);
  font-size:.7rem; font-weight:700;
  padding:2px 8px; border-radius:999px;
}
```

Delete that block as well.

- [ ] **Step 4: Manually verify**

Reload the page. The header should show only the brand block, the pulse dot, and nothing else trailing it. No console errors.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Remove misleading post count badge"
```

---

## Task 5: Lazy-load older posts on scroll

**Files:**
- Modify: `public/index.html`

**Goal:** When the user scrolls near the bottom of the feed, fetch the next page from the cursor returned by the server (Task 1) and append it. The 2s background poll continues to refresh only the first page.

- [ ] **Step 1: Add lazy-load state**

Near the other state at the top of the script, just after `let hasLazyLoaded = false;` from Task 2, add:

```js
let loadingMore = false;
let exhausted   = false;
```

- [ ] **Step 2: Add the `loadMore()` function**

Add this immediately after the `pollFeed` function:

```js
async function loadMore() {
  if (loadingMore || exhausted || !nextCursor) return;
  loadingMore = true;
  hasLazyLoaded = true; // freeze nextCursor management against polling
  try {
    const r = await fetch(`/api/feed?cursor=${encodeURIComponent(nextCursor)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { posts, cursor } = await r.json();

    if (!posts.length) {
      exhausted = true;
      return;
    }

    // Append posts that aren't already rendered (cursor pages should be disjoint from page 1)
    for (const post of posts) {
      if (renderedPosts.has(post.uri)) continue;
      const node = renderPost(post);
      feedEl.appendChild(node);
      renderedPosts.set(post.uri, {
        node,
        likeCount: post.likeCount,
        repostCount: post.repostCount,
        replyCount: post.replyCount,
        firstPage: false, // protect from deletion by the diff renderer
      });
    }

    if (cursor) {
      nextCursor = cursor;
    } else {
      exhausted = true;
    }
  } catch (err) {
    console.error('Load more failed:', err);
  } finally {
    loadingMore = false;
  }
}
```

- [ ] **Step 3: Wire scroll detection on the feed panel**

Add this after `loadMore` is defined:

```js
const feedPanel = document.querySelector('.feed-panel');
feedPanel.addEventListener('scroll', () => {
  const distanceFromBottom = feedPanel.scrollHeight - feedPanel.scrollTop - feedPanel.clientHeight;
  if (distanceFromBottom < 400) loadMore();
});
```

- [ ] **Step 4: Manually verify**

Deploy or run locally. Once the feed has loaded, scroll to the bottom of the feed panel. The DevTools Network tab should show one request to `/api/feed?cursor=…`. The feed should grow with older posts appended below the existing ones. Continue scrolling — additional pages should load until exhausted.

Edge case to verify: the polling cycle does not delete the lazy-loaded older posts. Wait through one or two 2s polls after lazy-loading — older posts should remain.

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "Lazy-load older feed pages on scroll"
```

---

## Task 6: Per-stage "Posted ✓" state

**Files:**
- Modify: `public/index.html`

**Goal:** After a successful per-stage post, the button reads `Posted ✓` and is disabled. If the user edits the stage afterwards, the button reverts to `Post`.

- [ ] **Step 1: Add posted-state tracking**

Find `let activeDram = 1;` (around line 1325). Immediately after it, add:

```js
// posted[dram][stage] = true once that stage has been successfully posted
const posted = {};
for (let i = 1; i <= 5; i++) {
  posted[i] = { appearance:false, nose:false, palate:false, finish:false, score:false };
}
```

- [ ] **Step 2: Add a helper to apply visual state to a stage button**

Add this near the other helpers (e.g. just before `stagePostBtns.forEach`):

```js
function applyPostedStyle(btn, isPosted) {
  if (isPosted) {
    btn.disabled = true;
    btn.textContent = 'Posted ✓';
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'var(--green)';
  } else {
    btn.disabled = false;
    btn.textContent = 'Post';
    btn.style.color = '';
    btn.style.borderColor = '';
  }
}

function refreshStageButtons() {
  stagePostBtns.forEach(btn => {
    applyPostedStyle(btn, posted[activeDram][btn.dataset.stagePost]);
  });
}
```

- [ ] **Step 3: Mark posted on success in the per-stage post handler**

Find the `stagePostBtns.forEach` block (around line 1498):

```js
stagePostBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    saveDram();
    const stage = btn.dataset.stagePost;
    if (!hasStageDraft(activeDram, stage)) return;
    btn.disabled = true; btn.textContent = '…';
    try {
      await postTasting({ dram: activeDram, stage });
      const label = STAGES.find(item => item.key === stage)?.label.toLowerCase();
      showTastingFb(`✓ Dram ${activeDram} ${label} posted!`, 'ok');
      if (stage === 'score') markDone(activeDram);
    } catch(e) { showTastingFb(e.message, 'err'); }
    finally { btn.disabled = false; btn.textContent = 'Post'; }
  });
});
```

Replace with:

```js
stagePostBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    saveDram();
    const stage = btn.dataset.stagePost;
    if (!hasStageDraft(activeDram, stage)) return;
    btn.disabled = true; btn.textContent = '…';
    try {
      await postTasting({ dram: activeDram, stage });
      const label = STAGES.find(item => item.key === stage)?.label.toLowerCase();
      showTastingFb(`✓ Dram ${activeDram} ${label} posted!`, 'ok');
      if (stage === 'score') markDone(activeDram);
      posted[activeDram][stage] = true;
      applyPostedStyle(btn, true);
    } catch(e) {
      showTastingFb(e.message, 'err');
      applyPostedStyle(btn, false);
    }
  });
});
```

- [ ] **Step 4: Re-enable the button when the user edits the stage**

Find the `stageFields.forEach` block (around line 1369):

```js
stageFields.forEach(field => {
  field.addEventListener('input', () => {
    dramState[activeDram][field.dataset.stageField] = field.value;
    updateStageStatus(field.dataset.stageField === 'scoreNote' ? 'score' : field.dataset.stageField);
  });
});
```

Replace with:

```js
stageFields.forEach(field => {
  field.addEventListener('input', () => {
    dramState[activeDram][field.dataset.stageField] = field.value;
    const stage = field.dataset.stageField === 'scoreNote' ? 'score' : field.dataset.stageField;
    updateStageStatus(stage);
    if (posted[activeDram][stage]) {
      posted[activeDram][stage] = false;
      const btn = document.querySelector(`[data-stage-post="${stage}"]`);
      if (btn) applyPostedStyle(btn, false);
    }
  });
});
```

- [ ] **Step 5: Re-enable the score button when score stars or score note change**

Find the star-button click handler (around line 1400):

```js
b.addEventListener('click', () => {
    const v = parseInt(b.dataset.score);
    const newVal = dramState[activeDram].score === v ? null : v;
    dramState[activeDram].score = newVal;
    renderTStars(newVal);
    updateStageStatus('score');
  });
```

Replace with:

```js
b.addEventListener('click', () => {
    const v = parseInt(b.dataset.score);
    const newVal = dramState[activeDram].score === v ? null : v;
    dramState[activeDram].score = newVal;
    renderTStars(newVal);
    updateStageStatus('score');
    if (posted[activeDram].score) {
      posted[activeDram].score = false;
      const btn = document.querySelector('[data-stage-post="score"]');
      if (btn) applyPostedStyle(btn, false);
    }
  });
```

Stage image add/remove also counts as an edit. Find `renderStageImages` (around line 1090) — its remove handler ends with `updateStageStatus(stage);`. After the existing `splice` call, add the same posted-flag reset. Replace this block:

```js
wrap.querySelector('.img-rm').onclick = () => {
      list.splice(idx, 1);
      renderStageImages(stage);
      updateStageStatus(stage);
    };
```

With:

```js
wrap.querySelector('.img-rm').onclick = () => {
      list.splice(idx, 1);
      renderStageImages(stage);
      updateStageStatus(stage);
      if (posted[activeDram][stage]) {
        posted[activeDram][stage] = false;
        const btn = document.querySelector(`[data-stage-post="${stage}"]`);
        if (btn) applyPostedStyle(btn, false);
      }
    };
```

And also in the stage image-input change handler (around line 1057):

```js
stageImgInputs.forEach(input => {
  input.addEventListener('change', async () => {
    const stage = input.dataset.stageImgInput;
    const list = stageImages[activeDram][stage];
    const button = document.querySelector(`[data-stage-img-btn="${stage}"]`);
    await addImagesToList(input.files, list, () => renderStageImages(stage), button);
    input.value = '';
    updateStageStatus(stage);
  });
});
```

Replace with:

```js
stageImgInputs.forEach(input => {
  input.addEventListener('change', async () => {
    const stage = input.dataset.stageImgInput;
    const list = stageImages[activeDram][stage];
    const button = document.querySelector(`[data-stage-img-btn="${stage}"]`);
    await addImagesToList(input.files, list, () => renderStageImages(stage), button);
    input.value = '';
    updateStageStatus(stage);
    if (posted[activeDram][stage]) {
      posted[activeDram][stage] = false;
      const stageBtn = document.querySelector(`[data-stage-post="${stage}"]`);
      if (stageBtn) applyPostedStyle(stageBtn, false);
    }
  });
});
```

The Klipy GIF picker also adds images. Find `onKlipySelect` (around line 1490) and locate this block inside the success path:

```js
} else {
      const list = stageImages[activeDram][klipyTarget];
      list.push(item);
      renderStageImages(klipyTarget);
      updateStageStatus(klipyTarget);
      const stageBtn = document.querySelector(`[data-stage-img-btn="${klipyTarget}"]`);
      if (stageBtn) stageBtn.disabled = list.length >= 4;
    }
```

Replace with:

```js
} else {
      const list = stageImages[activeDram][klipyTarget];
      list.push(item);
      renderStageImages(klipyTarget);
      updateStageStatus(klipyTarget);
      const stageBtn = document.querySelector(`[data-stage-img-btn="${klipyTarget}"]`);
      if (stageBtn) stageBtn.disabled = list.length >= 4;
      if (posted[activeDram][klipyTarget]) {
        posted[activeDram][klipyTarget] = false;
        const postBtn = document.querySelector(`[data-stage-post="${klipyTarget}"]`);
        if (postBtn) applyPostedStyle(postBtn, false);
      }
    }
```

- [ ] **Step 6: Refresh button styles when switching dram tabs**

Find `loadDram` (around line 1354) — its body ends with `dramTabs.forEach(t => t.classList.toggle('active', parseInt(t.dataset.dram) === n));`. Add a call to refresh:

Replace:

```js
function loadDram(n) {
  saveDram();
  activeDram = n;
  const s = dramState[n];
  stageFields.forEach(field => {
    field.value = s[field.dataset.stageField] || '';
  });
  renderTStars(s.score);
  renderAllStageImages();
  updateAllStageStatuses();
  tDramNum.textContent = n;
  dramTabs.forEach(t => t.classList.toggle('active', parseInt(t.dataset.dram) === n));
}
```

With:

```js
function loadDram(n) {
  saveDram();
  activeDram = n;
  const s = dramState[n];
  stageFields.forEach(field => {
    field.value = s[field.dataset.stageField] || '';
  });
  renderTStars(s.score);
  renderAllStageImages();
  updateAllStageStatuses();
  refreshStageButtons();
  tDramNum.textContent = n;
  dramTabs.forEach(t => t.classList.toggle('active', parseInt(t.dataset.dram) === n));
}
```

- [ ] **Step 7: Reset posted state on sign-out**

Find `showLoggedOut` (around line 1583) — the body has a reset loop `for (let i = 1; i <= 5; i++) { dramState[i] = blankDramState(); stageImages[i] = blankStageImages(); }`. Add the posted reset just after that loop:

Replace:

```js
  for (let i = 1; i <= 5; i++) {
    dramState[i] = blankDramState();
    stageImages[i] = blankStageImages();
  }
  loadDram(1);
  dramTabs.forEach(t => t.classList.remove('done'));
}
```

With:

```js
  for (let i = 1; i <= 5; i++) {
    dramState[i] = blankDramState();
    stageImages[i] = blankStageImages();
    posted[i] = { appearance:false, nose:false, palate:false, finish:false, score:false };
  }
  loadDram(1);
  dramTabs.forEach(t => t.classList.remove('done'));
}
```

- [ ] **Step 8: Manually verify**

Run the app, sign in, go to the Tasting tab. Type into Appearance and click **Post**. The button should say `Posted ✓` and be disabled. Type more into Appearance — the button should re-enable and read `Post` again. Switch dram tabs — the new tab's buttons should reflect that dram's posted state, and switching back should restore the `Posted ✓` state.

Verify the Score stage too — clicking a star or editing the score note should re-enable the Score post button.

Verify image flows: add an image, post score, then remove that image. Button should re-enable.

- [ ] **Step 9: Commit**

```bash
git add public/index.html
git commit -m "Per-stage Posted state to prevent duplicate clicks"
```

---

## Task 7: Remove the "Post Everything" button

**Files:**
- Modify: `public/index.html`

**Goal:** Remove the bottom button and its handler. The user always wanted simpler — one post per stage, full stop.

- [ ] **Step 1: Remove the HTML container**

Find (around line 772):

```html
<div id="tasting-feedback"></div>
        <div class="post-all-wrap">
          <button class="post-all-btn" id="t-post-all">Post Everything for Dram <span id="t-dram-num">1</span></button>
        </div>
      </div>
```

Replace with:

```html
<div id="tasting-feedback"></div>
      </div>
```

- [ ] **Step 2: Remove the related JS bindings**

Find (around lines 1330–1331):

```js
const tPostAll     = document.getElementById('t-post-all');
const tDramNum     = document.getElementById('t-dram-num');
```

Delete both lines.

- [ ] **Step 3: Remove the click handler**

Find (around line 1515):

```js
// Post everything
tPostAll.addEventListener('click', async () => {
  saveDram();
  if (!STAGES.some(stage => hasStageDraft(activeDram, stage.key))) {
    showTastingFb('Nothing filled in yet.', 'err'); return;
  }
  tPostAll.disabled = true; tPostAll.textContent = 'Posting…';
  try {
    await postTasting({ dram: activeDram });
    showTastingFb(`✓ Dram ${activeDram} posted!`, 'ok');
    markDone(activeDram);
  } catch(e) { showTastingFb(e.message, 'err'); }
  finally { tPostAll.disabled = false; tPostAll.textContent = `Post Everything for Dram ${activeDram}`; }
});
```

Delete the entire block.

- [ ] **Step 4: Remove the `tDramNum.textContent = n;` line in `loadDram`**

Find inside `loadDram` (around line 1364):

```js
tDramNum.textContent = n;
```

Delete the line.

- [ ] **Step 5: Remove the now-unused CSS**

Find and delete these blocks (around lines 504–507):

```css
.post-all-wrap { padding:0 11px 11px; flex-shrink:0; }
.post-all-btn { width:100%; padding:8px; background:var(--accent); color:#120d05; border:none; border-radius:7px; font-size:.82rem; font-weight:700; cursor:pointer; transition:opacity .15s; }
.post-all-btn:hover:not(:disabled) { opacity:.85; }
.post-all-btn:disabled { opacity:.45; cursor:not-allowed; }
```

- [ ] **Step 6: Verify no references remain**

```bash
grep -n "tPostAll\|t-post-all\|post-all\|tDramNum\|t-dram-num" public/index.html
```

Expected: no matches.

- [ ] **Step 7: Manually verify**

Reload the app, sign in, go to Tasting tab. The bottom of the panel should now end with the last stage card; no big amber button. No console errors.

- [ ] **Step 8: Commit**

```bash
git add public/index.html
git commit -m "Remove Post Everything button"
```

---

## Task 8: Deploy

- [ ] **Step 1: Deploy to Fly.io**

```bash
fly deploy
```

Expected: deployment succeeds, app reachable at https://bskyblinddramsgroup.fly.dev/.

- [ ] **Step 2: Smoke-test the live app**

Open the live URL in a browser:

1. Header has no "0 posts" badge and no "connecting…" text — only the brand block and pulse dot
2. Network panel shows one `/api/feed` request every 2s
3. Feed renders without flashing during polls
4. Sign in
5. In the Tasting tab, type into Appearance → click Post → button reads `Posted ✓` and is disabled
6. Edit the Appearance text → button re-enables to `Post`
7. The bottom of the compose panel does NOT show a "Post Everything" button
8. Scroll to the bottom of the feed → a network request is made to `/api/feed?cursor=…` and older posts appear below

If anything fails, debug, fix, and redeploy.
