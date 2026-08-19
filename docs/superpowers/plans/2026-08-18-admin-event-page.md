# Admin Event Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organiser set the next tasting event's number, title, start time and banner from a web page, with no code edit and no manual deploy.

**Architecture:** Event data moves out of seven hardcoded lines in `public/index.html` into a committed `public/event.json` that the page fetches at load. An admin page authenticates against a shared password, then the server writes the new config (and banner) back to the repository as a single atomic commit via the GitHub Git Data API. A new GitHub Actions workflow tests and deploys on push to `main`, so the commit reaches production unattended.

**Tech Stack:** Node 22 ESM, Express 4, `node:test`, `node:crypto`, GitHub REST Git Data API, GitHub Actions, Fly.io.

**Spec:** `docs/superpowers/specs/2026-08-18-admin-event-page-design.md`

## Global Constraints

- Node 22, ESM only (`"type": "module"` in `package.json`). Use `import`, never `require`.
- No build step, no bundler, no framework. `public/index.html` stays a single file with one inline `<script>`.
- Tests run via `npm test`, which is `node --test`. Test files live in `test/` and end in `.test.js`.
- Conventional commit messages: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`.
- `number` is an integer 1–999. `title` is non-empty after trim, maximum **60** characters.
- `startIso` must parse to a valid date **and** carry an explicit UTC offset.
- Banner uploads: `image/jpeg` or `image/png` only, decoded size at most **1000000** bytes.
- Admin login: at most **5** failed attempts per **15 minutes** per IP, then 429.
- Admin token lifetime: **2 hours**.
- The frontend must never throw while handling `event.json`. Any error leaves the event card hidden. A throw in the inline script kills login too.
- Never print or log a secret value. `ADMIN_PASSWORD` and `GITHUB_TOKEN` are read from `process.env` only.

## File Structure

| File | Responsibility |
|---|---|
| `lib/event-config.js` (new) | Pure functions: input validation, banner path, `event.json` serialisation, timing-safe secret compare. No I/O. |
| `lib/github-commit.js` (new) | GitHub Git Data API: read a file, write one atomic commit. `fetch` is injected so it is testable. |
| `public/event.json` (new) | The current event. Single source of truth. |
| `public/admin.html` (new) | Standalone admin page. Own inline script. |
| `server.js` (modify) | Two admin routes wiring the two libs together. |
| `public/index.html` (modify) | Renders the event card from `event.json`. |
| `.github/workflows/deploy.yml` (new) | Test, then deploy on push to `main`. |
| `Dockerfile` (modify) | Must copy `lib/`. |

`lib/` is split in two because the pure logic is trivially unit-testable while the GitHub client needs a fake `fetch`. Keeping them apart means the validation tests have no HTTP machinery in them.

---

### Task 1: `lib/event-config.js` — pure validation and formatting

**Files:**
- Create: `lib/event-config.js`
- Test: `test/event-config.test.js`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_TITLE_LENGTH: number` (60)
  - `MAX_IMAGE_BYTES: number` (1000000)
  - `bannerPath(number: number) => string` — e.g. `'banners/btc68.jpg'`
  - `validateEventInput(input: object) => { ok: true, value: { number, title, startIso, imageBuffer: Buffer|null, imageMime: string|null } } | { ok: false, error: string }`
  - `buildEventJson({ number, title, startIso, imagePath }) => string`
  - `secretMatches(a: string, b: string) => boolean`

- [ ] **Step 1: Write the failing tests**

Create `test/event-config.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_IMAGE_BYTES,
  MAX_TITLE_LENGTH,
  bannerPath,
  buildEventJson,
  secretMatches,
  validateEventInput,
} from '../lib/event-config.js';

const good = {
  number: 68,
  title: 'World Cup Whiskies',
  startIso: '2026-09-19T20:00:00+01:00',
};

test('accepts a valid input with no image', () => {
  const result = validateEventInput(good);
  assert.equal(result.ok, true);
  assert.equal(result.value.number, 68);
  assert.equal(result.value.title, 'World Cup Whiskies');
  assert.equal(result.value.startIso, '2026-09-19T20:00:00+01:00');
  assert.equal(result.value.imageBuffer, null);
  assert.equal(result.value.imageMime, null);
});

test('trims the title', () => {
  const result = validateEventInput({ ...good, title: '  Islay Night  ' });
  assert.equal(result.ok, true);
  assert.equal(result.value.title, 'Islay Night');
});

test('rejects a non-integer or out-of-range number', () => {
  for (const number of [0, 1000, 6.5, -1, '68', null, undefined, NaN]) {
    const result = validateEventInput({ ...good, number });
    assert.equal(result.ok, false, `expected ${String(number)} to be rejected`);
    assert.match(result.error, /number/i);
  }
});

test('rejects an empty or over-long title', () => {
  for (const title of ['', '   ', 'x'.repeat(MAX_TITLE_LENGTH + 1), null, 42]) {
    const result = validateEventInput({ ...good, title });
    assert.equal(result.ok, false, `expected ${String(title).slice(0, 12)} to be rejected`);
    assert.match(result.error, /title/i);
  }
});

test('accepts a title of exactly the maximum length', () => {
  const result = validateEventInput({ ...good, title: 'x'.repeat(MAX_TITLE_LENGTH) });
  assert.equal(result.ok, true);
});

test('rejects an unparseable date', () => {
  const result = validateEventInput({ ...good, startIso: 'next Thursday' });
  assert.equal(result.ok, false);
  assert.match(result.error, /date/i);
});

test('rejects a date with no UTC offset, because the countdown would drift by timezone', () => {
  const result = validateEventInput({ ...good, startIso: '2026-09-19T20:00:00' });
  assert.equal(result.ok, false);
  assert.match(result.error, /offset/i);
});

test('accepts both a numeric offset and a Z suffix', () => {
  assert.equal(validateEventInput({ ...good, startIso: '2026-09-19T20:00:00+01:00' }).ok, true);
  assert.equal(validateEventInput({ ...good, startIso: '2026-09-19T19:00:00Z' }).ok, true);
});

test('accepts a jpeg image and decodes it to a Buffer', () => {
  const imageBase64 = Buffer.from('pretend-jpeg-bytes').toString('base64');
  const result = validateEventInput({ ...good, imageBase64, imageMime: 'image/jpeg' });
  assert.equal(result.ok, true);
  assert.equal(result.value.imageMime, 'image/jpeg');
  assert.equal(result.value.imageBuffer.toString(), 'pretend-jpeg-bytes');
});

test('rejects a disallowed image mime type', () => {
  const imageBase64 = Buffer.from('x').toString('base64');
  const result = validateEventInput({ ...good, imageBase64, imageMime: 'image/svg+xml' });
  assert.equal(result.ok, false);
  assert.match(result.error, /jpeg|png/i);
});

test('rejects an image over the byte cap, measured after decoding', () => {
  const imageBase64 = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x41).toString('base64');
  const result = validateEventInput({ ...good, imageBase64, imageMime: 'image/jpeg' });
  assert.equal(result.ok, false);
  assert.match(result.error, /large|size/i);
});

test('rejects image data with no mime type', () => {
  const imageBase64 = Buffer.from('x').toString('base64');
  const result = validateEventInput({ ...good, imageBase64 });
  assert.equal(result.ok, false);
  assert.match(result.error, /mime/i);
});

test('derives the banner path from the number and cannot escape the banners directory', () => {
  assert.equal(bannerPath(68), 'banners/btc68.jpg');
  assert.equal(bannerPath(7), 'banners/btc7.jpg');
  // number is validated as an integer before it reaches bannerPath, so traversal
  // is impossible by construction; this asserts the shape it produces.
  assert.match(bannerPath(999), /^banners\/btc\d+\.jpg$/);
});

test('builds event.json with exactly the four expected keys and a trailing newline', () => {
  const json = buildEventJson({
    number: 68,
    title: 'World Cup Whiskies',
    startIso: '2026-09-19T20:00:00+01:00',
    imagePath: 'banners/btc68.jpg',
  });
  assert.ok(json.endsWith('\n'));
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed).sort(), ['imagePath', 'number', 'startIso', 'title']);
  assert.equal(parsed.number, 68);
  assert.equal(parsed.imagePath, 'banners/btc68.jpg');
});

test('secretMatches is true for identical values and false otherwise', () => {
  assert.equal(secretMatches('correct-horse', 'correct-horse'), true);
  assert.equal(secretMatches('correct-horse', 'correct-horsf'), false);
});

test('secretMatches handles different lengths without throwing', () => {
  // timingSafeEqual throws on length mismatch, so the implementation must hash first
  assert.equal(secretMatches('short', 'much-longer-value'), false);
  assert.equal(secretMatches('', 'x'), false);
});

test('secretMatches is false when either side is missing', () => {
  assert.equal(secretMatches(undefined, 'x'), false);
  assert.equal(secretMatches('x', undefined), false);
  assert.equal(secretMatches('', ''), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/event-config.test.js`
Expected: FAIL — `Cannot find module '../lib/event-config.js'`

- [ ] **Step 3: Implement `lib/event-config.js`**

```js
import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_TITLE_LENGTH = 60;
export const MAX_IMAGE_BYTES = 1_000_000;

const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png']);

// An ISO string with no offset is ambiguous: the countdown would land on a
// different instant depending on the viewer's timezone.
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

export function bannerPath(number) {
  return `banners/btc${number}.jpg`;
}

export function validateEventInput(input = {}) {
  const { number, title, startIso, imageBase64, imageMime } = input;

  if (!Number.isInteger(number) || number < 1 || number > 999) {
    return { ok: false, error: 'number must be an integer between 1 and 999' };
  }

  if (typeof title !== 'string' || !title.trim()) {
    return { ok: false, error: 'title is required' };
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` };
  }

  if (typeof startIso !== 'string' || Number.isNaN(new Date(startIso).getTime())) {
    return { ok: false, error: 'startIso must be a valid date' };
  }
  if (!HAS_OFFSET.test(startIso.trim())) {
    return { ok: false, error: 'startIso must include a UTC offset, e.g. +01:00 or Z' };
  }

  let imageBuffer = null;
  let resolvedMime = null;
  if (imageBase64) {
    if (typeof imageMime !== 'string' || !imageMime) {
      return { ok: false, error: 'imageMime is required when an image is supplied' };
    }
    if (!ALLOWED_IMAGE_MIMES.has(imageMime)) {
      return { ok: false, error: 'image must be image/jpeg or image/png' };
    }
    imageBuffer = Buffer.from(String(imageBase64), 'base64');
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `image is too large; maximum is ${MAX_IMAGE_BYTES} bytes` };
    }
    resolvedMime = imageMime;
  }

  return {
    ok: true,
    value: {
      number,
      title: trimmedTitle,
      startIso: startIso.trim(),
      imageBuffer,
      imageMime: resolvedMime,
    },
  };
}

export function buildEventJson({ number, title, startIso, imagePath }) {
  return `${JSON.stringify({ number, title, startIso, imagePath }, null, 2)}\n`;
}

// Hash both sides first: timingSafeEqual throws when the buffers differ in
// length, and that exception would itself leak the length of the real secret.
export function secretMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const digest = value => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/event-config.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Add `lib/` to the Docker image**

The Dockerfile copies `server.js` and `public/` explicitly and nothing else. Without this the image builds cleanly and then crashes on boot with `ERR_MODULE_NOT_FOUND`.

In `Dockerfile`, change:

```dockerfile
COPY server.js ./
COPY public/ ./public/
```

to:

```dockerfile
COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
```

- [ ] **Step 6: Verify the image builds and boots with `lib/` present**

Run: `docker build -t blinddrams-libcheck . && docker run --rm blinddrams-libcheck node -e "import('./lib/event-config.js').then(m => console.log('lib present:', typeof m.bannerPath))"`
Expected: prints `lib present: function`

If Docker is not running locally, substitute: `grep -q 'COPY lib/ ./lib/' Dockerfile && echo "COPY line present"` and note in the commit that the image build was not exercised.

- [ ] **Step 7: Commit**

```bash
git add lib/event-config.js test/event-config.test.js Dockerfile
git commit -m "feat: add event config validation and formatting helpers"
```

---

### Task 2: `public/event.json` + render the event card from it

**Files:**
- Create: `public/event.json`
- Modify: `public/index.html` (markup at `:635-640`, DOM refs near `:959`, constants and countdown at `:1006-1029`, event-post handler at `:1964-2000`)
- Modify: `test/ui-features.test.js`

**Interfaces:**
- Consumes: nothing from Task 1 at runtime. `event.json`'s four keys must match `buildEventJson`'s output exactly: `number`, `title`, `startIso`, `imagePath`.
- Produces: `public/event.json` as the contract the admin route writes to in Task 5.

- [ ] **Step 1: Write the failing tests**

In `test/ui-features.test.js`, **delete** the existing test named `'shows the current tasting theme and countdown without auto-adding the BTC tag'` in its entirety and add these in its place:

```js
test('event config lives in event.json with the four expected fields', () => {
  const raw = readFileSync(join(root, 'public', 'event.json'), 'utf8');
  const event = JSON.parse(raw);
  assert.deepEqual(Object.keys(event).sort(), ['imagePath', 'number', 'startIso', 'title']);
  assert.ok(Number.isInteger(event.number));
  assert.ok(typeof event.title === 'string' && event.title.trim());
  assert.ok(!Number.isNaN(new Date(event.startIso).getTime()));
  assert.match(event.startIso, /(Z|[+-]\d{2}:?\d{2})$/);
});

test('the banner named by event.json exists on disk', () => {
  const event = JSON.parse(readFileSync(join(root, 'public', 'event.json'), 'utf8'));
  assert.ok(existsSync(join(root, 'public', event.imagePath)), `missing ${event.imagePath}`);
});

test('index.html reads the event from event.json and hardcodes no event data', () => {
  assert.match(html, /fetch\('event\.json'/);
  assert.doesNotMatch(html, /TASTING_START_ISO/);
  assert.doesNotMatch(html, /BTC\d+/);
  assert.doesNotMatch(html, /btc\d+-theme\.jpeg/);
});

test('the event card starts hidden so a failed event.json fetch cannot show an empty card', () => {
  assert.match(html, /id="header-event"[^>]*style="display:none"/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/ui-features.test.js`
Expected: FAIL — no `public/event.json`, and `index.html` still contains `TASTING_START_ISO` and `BTC67`.

- [ ] **Step 3: Create `public/event.json`**

Seeded with the values currently hardcoded, so behaviour is unchanged. `imagePath` points at the existing image rather than duplicating it into `banners/`. The date is already in the past, so the card stays hidden — that is today's production behaviour preserved, and it clears the first time an event is saved through the admin page.

```json
{
  "number": 67,
  "title": "World Cup Whiskies",
  "startIso": "2026-08-15T20:00:00+01:00",
  "imagePath": "btc67-theme.jpeg"
}
```

- [ ] **Step 4: Make the card hidden by default and its contents empty**

In `public/index.html`, replace the block at `:635-640`:

```html
  <div class="header-event" id="header-event">
    <img class="header-event-img" src="btc67-theme.jpeg" alt="World Cup Whiskies BTC67 theme artwork">
    <span class="header-event-kicker">#BTC67</span>
    <span class="header-event-title">World Cup Whiskies · 15 Aug</span>
```

with:

```html
  <div class="header-event" id="header-event" style="display:none">
    <img class="header-event-img" id="event-img" src="" alt="">
    <span class="header-event-kicker" id="event-kicker"></span>
    <span class="header-event-title" id="event-title"></span>
```

Leave the two following lines (`event-countdown` and `event-post-btn`) untouched.

- [ ] **Step 5: Add the DOM refs**

In `public/index.html`, directly after the `eventCountdown` line at `:959`, add:

```js
const eventImg     = document.getElementById('event-img');
const eventKicker  = document.getElementById('event-kicker');
const eventTitleEl = document.getElementById('event-title');
const headerEvent  = document.getElementById('header-event');
```

- [ ] **Step 6: Replace the constant and the countdown**

In `public/index.html`, replace `:1006`:

```js
const TASTING_START_ISO = '2026-08-15T20:00:00+01:00';
```

with:

```js
let eventConfig = null;   // { number, title, startIso, imagePath }, or null until event.json loads
```

Then replace the whole of `updateCountdown` plus the two lines that follow it (`:1015-1029`):

```js
function updateCountdown() {
  const diff = new Date(TASTING_START_ISO).getTime() - Date.now();
  if (diff <= 0) {
    document.getElementById('header-event').style.display = 'none';
    return;
  }
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  eventCountdown.textContent = `${days}d ${hours}h ${minutes}m to go`;
}

updateCountdown();
setInterval(updateCountdown, 60_000);
```

with:

```js
function eventIsUpcoming() {
  return Boolean(eventConfig) && new Date(eventConfig.startIso).getTime() > Date.now();
}

function updateCountdown() {
  if (!eventIsUpcoming()) {
    headerEvent.style.display = 'none';
    return;
  }
  const diff = new Date(eventConfig.startIso).getTime() - Date.now();
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  eventCountdown.textContent = `${days}d ${hours}h ${minutes}m to go`;
  headerEvent.style.display = '';
}

// Everything about the event card is data-driven. Any failure here must leave the
// card hidden rather than throw: this is one inline script, so an uncaught error
// would take login down with it.
async function loadEvent() {
  try {
    const r = await fetch('event.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const ev = await r.json();
    if (!Number.isInteger(ev?.number) || !ev?.title || !ev?.startIso || !ev?.imagePath) return;
    if (Number.isNaN(new Date(ev.startIso).getTime())) return;
    eventConfig = ev;
    const dayMonth = new Date(ev.startIso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    eventImg.src = ev.imagePath;
    eventImg.alt = `${ev.title} #BTC${ev.number} theme artwork`;
    eventKicker.textContent = `#BTC${ev.number}`;
    eventTitleEl.textContent = `${ev.title} · ${dayMonth}`;
    updateCountdown();
    if (sessionId) setEventPostVisible(true);
  } catch {
    /* leave the card hidden */
  }
}

loadEvent();
setInterval(updateCountdown, 60_000);
```

**Do not move the `setEventPostVisible(true)` call earlier, and do not remove the `await`s before it.**
It is needed: a visitor who is already signed in on page load runs `enableGifBtns(true)` at the very bottom of the script, at which point `eventConfig` is still `null`, so the button is hidden and nothing would ever re-show it.
It is safe only because it sits *after* two `await`s — `eventPostBtn` is a `const` declared much further down the file, so it is in its temporal dead zone during synchronous execution and reachable only once the microtask resumes. Calling `setEventPostVisible` synchronously from here would throw a `ReferenceError` and kill the whole inline script, login included.

- [ ] **Step 7: Drive the "Post this" button from the config**

In `public/index.html`, in the event-post handler, replace `:1977`:

```js
    const imgRes = await fetch('/btc67-theme.jpeg');
```

with:

```js
    const imgRes = await fetch(`/${eventConfig.imagePath}`);
```

Replace `:1992`:

```js
    const text = `World Cup Whiskies — ${countdown} #BTC67 #BlindDrams`;
```

with:

```js
    const text = `${eventConfig.title} — ${countdown} #BTC${eventConfig.number} #BlindDrams`;
```

Replace `:1996`:

```js
      body: JSON.stringify({ sessionId, text, blobs: [{ blob: uploadData.blob, alt: 'World Cup Whiskies #BTC67', aspectRatio: { width: 1000, height: 600 } }] }),
```

with:

```js
      body: JSON.stringify({ sessionId, text, blobs: [{ blob: uploadData.blob, alt: `${eventConfig.title} #BTC${eventConfig.number}`, aspectRatio: { width: 1000, height: 600 } }] }),
```

Then guard the handler's entry. Replace its first line:

```js
    if (!sessionId) return;
```

with:

```js
    if (!sessionId || !eventIsUpcoming()) return;
```

- [ ] **Step 8: Only offer the post button when there is an event to post**

`setEventPostVisible` is called from `enableGifBtns`, which runs on login. Without this, signing in shows "Post this" even when no event is loaded. Replace the body of `setEventPostVisible`:

```js
function setEventPostVisible(on) {
  eventPostBtn.style.display = on ? 'inline-flex' : 'none';
}
```

with:

```js
function setEventPostVisible(on) {
  eventPostBtn.style.display = on && eventIsUpcoming() ? 'inline-flex' : 'none';
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 10: Parse-check the inline script**

`npm test` only matches text and cannot catch a syntax error, while a parse failure in this file kills login.

Run:

```bash
python3 -c "import re,io;h=io.open('public/index.html',encoding='utf-8').read();b=re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>',h,re.S);assert len(b)==1;io.open('/tmp/inline.js','w',encoding='utf-8').write(b[0])" && node --check /tmp/inline.js && echo "SYNTAX OK"
```

Expected: prints `SYNTAX OK`

- [ ] **Step 11: Commit**

```bash
git add public/event.json public/index.html test/ui-features.test.js
git commit -m "feat: render the header event card from event.json"
```

---

### Task 3: `lib/github-commit.js` — atomic commits via the Git Data API

**Files:**
- Create: `lib/github-commit.js`
- Test: `test/github-commit.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `readRepoFile({ token, repo, branch, path }, fetchImpl?) => Promise<string|null>` — decoded UTF-8, or `null` on 404.
  - `commitFiles({ token, repo, branch, message, files }, fetchImpl?) => Promise<{ commitSha: string, commitUrl: string }>` where `files` is `[{ path, content, encoding }]` and `encoding` is `'utf-8'` or `'base64'`.

`fetchImpl` defaults to global `fetch` and exists so the tests can drive the whole sequence without network access.

- [ ] **Step 1: Write the failing tests**

Create `test/github-commit.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { commitFiles, readRepoFile } from '../lib/github-commit.js';

const OPTS = {
  token: 'test-token',
  repo: 'owner/repo',
  branch: 'main',
  message: 'chore: test commit',
};

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

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/github-commit.test.js`
Expected: FAIL — `Cannot find module '../lib/github-commit.js'`

- [ ] **Step 3: Implement `lib/github-commit.js`**

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/github-commit.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add lib/github-commit.js test/github-commit.test.js
git commit -m "feat: add atomic GitHub commit helper for admin writes"
```

---

### Task 4: `POST /api/admin/login`

**Files:**
- Modify: `server.js` (add an admin section after the Klipy routes, before the health check at `:342`)
- Test: `test/admin-routes.test.js` (create)

**Interfaces:**
- Consumes: `secretMatches` from `lib/event-config.js` (Task 1).
- Produces: an `adminSessions` Map (`token -> { expiresAt }`) and a `requireAdmin(req)` helper returning `true`/`false`, both used by Task 5.

`server.js` logs into Bluesky on import, so its routes cannot be imported into a test without side effects. Route wiring is therefore asserted as text, consistent with the existing suite, while the real logic sits in `lib/` and is unit-tested there. This is a known limitation, not an oversight.

- [ ] **Step 1: Write the failing tests**

Create `test/admin-routes.test.js`:

```js
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
  // as a console argument. A regex matching the bare name gives a false positive
  // on the perfectly correct startup warning.
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*\$\{[^}]*ADMIN_PASSWORD/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*,\s*ADMIN_PASSWORD\b/);
  assert.doesNotMatch(server, /console\.[a-z]+\(\s*ADMIN_PASSWORD\b/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*\$\{[^}]*\bpassword\b/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*,\s*password\b/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*req\.body\.password/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/admin-routes.test.js`
Expected: FAIL — `server.js` contains no `ADMIN_PASSWORD`.

- [ ] **Step 3: Extend the env destructure**

In `server.js`, replace `:6`:

```js
const { BSKY_HANDLE, BSKY_APP_PASSWORD, PORT = 3000, KLIPY_API_KEY } = process.env;
```

with:

```js
const {
  BSKY_HANDLE,
  BSKY_APP_PASSWORD,
  PORT = 3000,
  KLIPY_API_KEY,
  ADMIN_PASSWORD,
  GITHUB_TOKEN,
  GITHUB_REPO = 'pete-van-jaarsveldt/BskyBlindDramsGroup',
} = process.env;
```

And after the existing `KLIPY_API_KEY` warning block at `:12-14`, add:

```js
if (!ADMIN_PASSWORD || !GITHUB_TOKEN) {
  console.warn('ADMIN_PASSWORD or GITHUB_TOKEN not set — the admin page will be unavailable');
}
```

- [ ] **Step 4: Add the import**

In `server.js`, after the existing imports at `:1-4`, add:

```js
import { bannerPath, buildEventJson, secretMatches, validateEventInput } from './lib/event-config.js';
import { commitFiles, readRepoFile } from './lib/github-commit.js';
```

- [ ] **Step 5: Add the login route**

In `server.js`, insert immediately before `// Health check` at `:342`:

```js
// ── Admin ─────────────────────────────────────────────────────────────────────
const ADMIN_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const ADMIN_MAX_ATTEMPTS = 5;
const ADMIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes

const adminSessions = new Map();   // token → { expiresAt }
const adminAttempts = new Map();   // ip → { count, windowStart }

function adminConfigured() {
  return Boolean(ADMIN_PASSWORD && GITHUB_TOKEN);
}

function requireAdmin(req) {
  const token = req.body?.adminToken;
  const session = adminSessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

// A single shared password is the only barrier in front of a repo-write token,
// so throttle guesses. In-memory, so it resets on restart — acceptable because a
// restart is not attacker-triggerable and the machine is long-lived.
function attemptAllowed(ip) {
  const now = Date.now();
  const record = adminAttempts.get(ip);
  if (!record || now - record.windowStart > ADMIN_ATTEMPT_WINDOW_MS) {
    adminAttempts.set(ip, { count: 0, windowStart: now });
    return true;
  }
  return record.count < ADMIN_MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const record = adminAttempts.get(ip) || { count: 0, windowStart: Date.now() };
  record.count += 1;
  adminAttempts.set(ip, record);
}

app.post('/api/admin/login', (req, res) => {
  if (!adminConfigured()) return res.status(503).json({ error: 'Admin not configured' });

  const ip = req.ip;
  if (!attemptAllowed(ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again later' });
  }

  const { password } = req.body ?? {};
  if (!secretMatches(password, ADMIN_PASSWORD)) {
    recordFailure(ip);
    console.warn(`Admin login failed from ${ip}`);
    return res.status(401).json({ error: 'Incorrect password' });
  }

  adminAttempts.delete(ip);
  for (const [token, session] of adminSessions) {
    if (session.expiresAt <= Date.now()) adminSessions.delete(token);
  }

  const adminToken = randomUUID();
  const expiresAt = Date.now() + ADMIN_TOKEN_TTL_MS;
  adminSessions.set(adminToken, { expiresAt });
  console.log('Admin login succeeded');
  res.json({ adminToken, expiresAt });
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- test/admin-routes.test.js`
Expected: PASS, all tests green.

- [ ] **Step 7: Verify the server still boots**

Run: `node --check server.js && echo "SYNTAX OK"`
Expected: prints `SYNTAX OK`

- [ ] **Step 8: Commit**

```bash
git add server.js test/admin-routes.test.js
git commit -m "feat: add rate-limited admin login endpoint"
```

---

### Task 5: `POST /api/admin/event`

**Files:**
- Modify: `server.js` (append to the admin section added in Task 4)
- Modify: `test/admin-routes.test.js`

**Interfaces:**
- Consumes: `requireAdmin`, `adminConfigured` (Task 4); `validateEventInput`, `bannerPath`, `buildEventJson` (Task 1); `commitFiles`, `readRepoFile` (Task 3).
- Produces: the endpoint `public/admin.html` calls in Task 6. Response shape: `{ ok: true, commitUrl, actionsUrl }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/admin-routes.test.js`:

```js
test('the event route validates through the shared helper rather than inline', () => {
  assert.match(server, /validateEventInput\(/);
  assert.match(server, /status\(400\)/);
});

test('imagePath is carried forward when no new banner is uploaded', () => {
  // Deriving it from the number unconditionally would point the card at a
  // banners/btcNN.jpg that was never uploaded.
  assert.match(server, /readRepoFile\(/);
  assert.match(server, /imagePath/);
});

test('the commit goes through the atomic helper and reports the commit URL', () => {
  assert.match(server, /commitFiles\(/);
  assert.match(server, /commitUrl/);
  assert.match(server, /actionsUrl/);
});

test('a GitHub failure is surfaced as a 502, not swallowed', () => {
  assert.match(server, /status\(502\)/);
});

test('the GitHub token VALUE is never logged or returned', () => {
  // Same false-positive trap as the ADMIN_PASSWORD test: GITHUB_TOKEN is named in
  // the startup warning string, which is correct. Target the value instead.
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*\$\{[^}]*GITHUB_TOKEN/);
  assert.doesNotMatch(server, /console\.[a-z]+\([^)]*,\s*GITHUB_TOKEN\b/);
  assert.doesNotMatch(server, /res\.json\([^)]*GITHUB_TOKEN/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/admin-routes.test.js`
Expected: FAIL — `server.js` contains no `validateEventInput(` call.

- [ ] **Step 3: Implement the route**

In `server.js`, append to the admin section, immediately before `// Health check`:

```js
app.post('/api/admin/event', async (req, res) => {
  if (!adminConfigured()) return res.status(503).json({ error: 'Admin not configured' });
  if (!requireAdmin(req)) return res.status(401).json({ error: 'Not signed in to admin' });

  const check = validateEventInput(req.body ?? {});
  if (!check.ok) return res.status(400).json({ error: check.error });
  const { number, title, startIso, imageBuffer, imageMime } = check.value;

  const repoOpts = { token: GITHUB_TOKEN, repo: GITHUB_REPO, branch: 'main' };

  try {
    const files = [];
    let imagePath;

    if (imageBuffer) {
      imagePath = bannerPath(number);
      files.push({
        path: `public/${imagePath}`,
        content: imageBuffer.toString('base64'),
        encoding: 'base64',
      });
    } else {
      // No new banner: keep whatever the committed config already points at.
      const current = await readRepoFile({ ...repoOpts, path: 'public/event.json' });
      const parsed = current ? JSON.parse(current) : null;
      imagePath = parsed?.imagePath;
      if (!imagePath) {
        return res.status(400).json({ error: 'No existing banner to keep — upload an image' });
      }
    }

    files.push({
      path: 'public/event.json',
      content: buildEventJson({ number, title, startIso, imagePath }),
      encoding: 'utf-8',
    });

    const { commitUrl } = await commitFiles({
      ...repoOpts,
      message: `chore: set BTC${number} ${title} banner and date`,
      files,
    });

    console.log(`Admin updated event to BTC${number}`);
    res.json({
      ok: true,
      commitUrl,
      actionsUrl: `https://github.com/${GITHUB_REPO}/actions`,
    });
  } catch (err) {
    console.error('Admin event update failed:', err.message);
    res.status(502).json({ error: `Could not save: ${err.message}` });
  }
});
```

Note the image is uploaded as `image/jpeg` or `image/png` but always stored at a `.jpg` path. `imageMime` is validated for safety and is otherwise unused; the browser serves the file by content sniffing and the existing themes are all JPEG. If PNG support ever needs a correct extension, that is where to change it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 5: Verify the server still parses**

Run: `node --check server.js && echo "SYNTAX OK"`
Expected: prints `SYNTAX OK`

- [ ] **Step 6: Commit**

```bash
git add server.js test/admin-routes.test.js
git commit -m "feat: add admin event update endpoint writing an atomic commit"
```

---

### Task 6: `public/admin.html`

**Files:**
- Create: `public/admin.html`
- Test: `test/admin-page.test.js` (create)

**Interfaces:**
- Consumes: `POST /api/admin/login` (Task 4), `POST /api/admin/event` (Task 5), `public/event.json` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing tests**

Create `test/admin-page.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/admin-page.test.js`
Expected: FAIL — `ENOENT` on `public/admin.html`

- [ ] **Step 3: Create `public/admin.html`**

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>#BlindDrams — event admin</title>
<style>
  :root { --bg:#14100c; --panel:#1e1811; --line:#3a2f22; --text:#f2e9dc; --muted:#a89880; --accent:#e49a13; --red:#e0524a; --green:#4caf7d; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,sans-serif; }
  .card { max-width:520px; margin:0 auto; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:22px; }
  h1 { margin:0 0 4px; font-size:19px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:18px; }
  label { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:var(--muted); margin:14px 0 5px; }
  input { width:100%; padding:10px 11px; background:#120e0a; border:1px solid var(--line); border-radius:7px; color:var(--text); font-size:15px; }
  input:focus { outline:none; border-color:var(--accent); }
  button { margin-top:18px; width:100%; padding:11px; background:var(--accent); border:0; border-radius:7px; color:#1a1206; font-size:15px; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  #preview { margin-top:14px; padding:10px 12px; background:#120e0a; border:1px solid var(--line); border-radius:7px; font-size:13px; color:var(--muted); }
  #msg { margin-top:14px; font-size:13px; display:none; }
  #msg.err { color:var(--red); display:block; }
  #msg.ok { color:var(--green); display:block; }
  #msg a { color:var(--accent); }
  #form-step { display:none; }
</style>

<div class="card">
  <h1>#BlindDrams event admin</h1>
  <div class="sub">Sets the header banner and countdown. Saving commits to GitHub and redeploys automatically.</div>

  <div id="login-step">
    <label for="f-password">Admin password</label>
    <input id="f-password" type="password" autocomplete="current-password">
    <button id="login-btn">Sign in</button>
  </div>

  <div id="form-step">
    <label for="f-number">Event number (the NN in #BTCNN)</label>
    <input id="f-number" type="number" min="1" max="999" step="1">

    <label for="f-title">Title</label>
    <input id="f-title" type="text" maxlength="60" placeholder="World Cup Whiskies">

    <label for="f-start">Start (your local time)</label>
    <input id="f-start" type="datetime-local">

    <label for="f-image">Banner image (optional — keeps the current one if empty)</label>
    <input id="f-image" type="file" accept="image/jpeg,image/png">

    <div id="preview">Fill in a date to preview the countdown.</div>
    <button id="save-btn">Save &amp; deploy</button>
  </div>

  <div id="msg"></div>
</div>

<script>
const loginStep = document.getElementById('login-step');
const formStep  = document.getElementById('form-step');
const fPassword = document.getElementById('f-password');
const loginBtn  = document.getElementById('login-btn');
const fNumber   = document.getElementById('f-number');
const fTitle    = document.getElementById('f-title');
const fStart    = document.getElementById('f-start');
const fImage    = document.getElementById('f-image');
const preview   = document.getElementById('preview');
const saveBtn   = document.getElementById('save-btn');
const msg       = document.getElementById('msg');

let adminToken = null;

function say(text, kind) {
  msg.innerHTML = text;
  msg.className = kind;
}

// datetime-local gives no offset; build one from the browser's own offset so the
// stored value is unambiguous. The server rejects an offset-less date.
function toOffsetIso(localValue) {
  const d = new Date(localValue);
  if (Number.isNaN(d.getTime())) return null;
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const pad = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`;
}

function renderPreview() {
  const iso = toOffsetIso(fStart.value);
  if (!iso) { preview.textContent = 'Fill in a date to preview the countdown.'; return; }
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) {
    preview.textContent = `${iso} — that is in the past, so the card will stay hidden.`;
    return;
  }
  const mins = Math.floor(diff / 60000);
  preview.textContent = `Countdown will read: ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h ${mins % 60}m to go`;
}

fStart.addEventListener('input', renderPreview);

async function prefill() {
  try {
    const r = await fetch('event.json', { cache: 'no-cache' });
    if (!r.ok) return;
    const ev = await r.json();
    fNumber.value = ev.number ?? '';
    fTitle.value = ev.title ?? '';
    if (ev.startIso) {
      const d = new Date(ev.startIso);
      if (!Number.isNaN(d.getTime())) {
        fStart.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      }
    }
    renderPreview();
  } catch { /* an empty form is fine */ }
}

loginBtn.addEventListener('click', async () => {
  loginBtn.disabled = true;
  say('', '');
  try {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: fPassword.value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Sign in failed');
    adminToken = data.adminToken;
    fPassword.value = '';
    loginStep.style.display = 'none';
    formStep.style.display = 'block';
    prefill();
  } catch (err) {
    say(err.message, 'err');
  } finally {
    loginBtn.disabled = false;
  }
});

fPassword.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });

function readImage() {
  const file = fImage.files?.[0];
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ imageBase64: String(reader.result).split(',')[1], imageMime: file.type });
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.readAsDataURL(file);
  });
}

saveBtn.addEventListener('click', async () => {
  saveBtn.disabled = true;
  say('Saving…', 'ok');
  try {
    const startIso = toOffsetIso(fStart.value);
    if (!startIso) throw new Error('Pick a start date and time');
    const image = await readImage();
    const r = await fetch('/api/admin/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminToken,
        number: Number(fNumber.value),
        title: fTitle.value,
        startIso,
        ...(image || {}),
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      if (r.status === 401) {
        adminToken = null;
        formStep.style.display = 'none';
        loginStep.style.display = 'block';
      }
      throw new Error(data.error || 'Save failed');
    }
    say(`Committed — live in about two minutes. <a href="${data.actionsUrl}" target="_blank" rel="noopener">Watch the deploy</a>`, 'ok');
    fImage.value = '';
  } catch (err) {
    say(err.message, 'err');
  } finally {
    saveBtn.disabled = false;
  }
});
</script>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/admin-page.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Parse-check the admin page's inline script**

Run:

```bash
python3 -c "import re,io;h=io.open('public/admin.html',encoding='utf-8').read();b=re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>',h,re.S);assert len(b)==1;io.open('/tmp/admin.js','w',encoding='utf-8').write(b[0])" && node --check /tmp/admin.js && echo "SYNTAX OK"
```

Expected: prints `SYNTAX OK`

- [ ] **Step 6: Commit**

```bash
git add public/admin.html test/admin-page.test.js
git commit -m "feat: add admin page for setting the next event"
```

---

### Task 7: CI workflow and documentation

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `.env.example`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the whole feature.
- Produces: nothing.

This workflow is what makes the git-commit approach reach production. Without it, saving from the admin page commits and stops.

- [ ] **Step 1: Create the workflow**

Verified against Fly's current documentation on 2026-08-18. The test step is added ahead of the deploy so a bad commit cannot ship.

```yaml
name: Fly Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    name: Test and deploy
    runs-on: ubuntu-latest
    concurrency: deploy-group
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm install
      - run: npm test
      - uses: superfly/flyctl-actions/setup-flyctl@master
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

`npm install` rather than `npm ci`.

**Correction (2026-08-19):** the original reason given here — "because this repo has no `package-lock.json`" — was wrong and was asserted without checking. `package-lock.json` has been tracked since the initial commit `566b819`, and `npm ci --dry-run` succeeds, so `npm ci` is viable and would be the better CI choice (reproducible, and it fails loudly if the lockfile and `package.json` disagree).

- [ ] **Step 2: Validate the workflow parses as YAML**

Run: `python3 -c "import sys,yaml;yaml.safe_load(open('.github/workflows/deploy.yml'));print('YAML OK')"`
Expected: prints `YAML OK`

If PyYAML is unavailable, run `python3 -c "import json;print('skipped')"` and rely on GitHub's own validation on push.

- [ ] **Step 3: Document the new env vars**

Replace `.env.example` with:

```
BSKY_HANDLE=whisky@vanjaarsveldt.com
BSKY_APP_PASSWORD=your-app-password-here
PORT=3000
KLIPY_API_KEY=your-klipy-api-key-here
ADMIN_PASSWORD=choose-a-strong-password
GITHUB_TOKEN=fine-grained-pat-with-contents-write-on-this-repo-only
GITHUB_REPO=pete-van-jaarsveldt/BskyBlindDramsGroup
```

- [ ] **Step 4: Update `CLAUDE.md`**

Replace the "Header event card" section, which documents the now-removed hardcoding, with:

```markdown
### Header event card

The current event lives in `public/event.json` (`number`, `title`, `startIso`, `imagePath`) and is fetched by `index.html` at load.
The card starts hidden and is shown only once that fetch succeeds and the start time is still in the future, so a missing or malformed `event.json` degrades to no card rather than throwing — which in a single inline script would take login down too.
Everything else is derived: the `#BTCNN` kicker, the `title · day month` header, the image alt, and the "Post this" text.

To change the event, use `/admin.html` rather than editing code. It needs `ADMIN_PASSWORD` and `GITHUB_TOKEN`, commits `event.json` (plus the banner, if a new one was uploaded) to `main` as one atomic commit, and the `Fly Deploy` workflow then deploys it.
```

Then in the `Commands` section, add `KLIPY_API_KEY`'s new siblings to the env var list:

```markdown
- `ADMIN_PASSWORD`, `GITHUB_TOKEN` — required for the admin page at `/admin.html`. Without them `/api/admin/*` returns 503 and the page reports "not configured".
- `GITHUB_REPO` — optional, defaults to `pete-van-jaarsveldt/BskyBlindDramsGroup`.
```

Finally, in the `Gotchas` section, add:

```markdown
- **`Dockerfile` copies paths explicitly.** `server.js`, `lib/` and `public/` each have their own `COPY`. A new top-level directory needs a new line or the image builds fine and crashes on boot.
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/deploy.yml .env.example CLAUDE.md
git commit -m "ci: deploy to Fly on push to main"
```

---

## After the plan: what Pete must do

None of this can be done by an implementer, because all three are credentials.

1. **`fly secrets set ADMIN_PASSWORD=...`** — chosen by Pete.
2. **`fly secrets set GITHUB_TOKEN=...`** — a fine-grained PAT with *Contents: read and write*, scoped to `BskyBlindDramsGroup` only.
3. **`fly tokens create deploy`**, then add the output as the `FLY_API_TOKEN` repository secret under Settings → Secrets and variables → Actions.

Until 1 and 2 are set, `/api/admin/*` returns 503 and the admin page says "not configured" — the rest of the site is unaffected.
Until 3 is set, the workflow runs the tests and fails at the deploy step.

Local development uses the same names in `.env`. Note dotenv reads `.env` only; a file named `.env.local` is silently ignored by this app.

## First live run

After the first deploy carrying this feature:

1. Open `/admin.html`, sign in, and save an event **with** a banner. Confirm the commit appears on `main` and the `Fly Deploy` run goes green.
2. Reload the site and confirm the card shows the new banner, kicker, title and countdown.
3. Sign in on the main page and confirm "Post this" produces `<title> — Nd Nh Nm to go #BTCNN #BlindDrams`.
4. Save again changing **only the title**, with no image. Confirm the commit touches `event.json` alone and the banner still resolves — this is the `imagePath` carry-forward path.
