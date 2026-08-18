# Admin page for event configuration

Date: 2026-08-18
Status: implemented and deployed 2026-08-18 (Fly release v35)
Implementation plan: `docs/superpowers/plans/2026-08-18-admin-event-page.md`

## Problem

The monthly tasting event is hardcoded across seven separate lines of `public/index.html`, plus the `BTC67` literals in `test/ui-features.test.js`.
Changing it requires a developer to edit HTML, update test assertions, and run `fly deploy`.

The current spots are the banner `<img src>` (`:636`), the `#BTC67` kicker (`:637`), the title and date text (`:638`), `TASTING_START_ISO` (`:1006`), the image path the "Post this" button fetches (`:1977`), the post text (`:1992`), the image alt text (`:1996`), and the `BTC67` literals in `test/ui-features.test.js`.

The event that is currently configured (`#BTC67`, starting `2026-08-15T20:00:00+01:00`) is already in the past, so the header card is hidden in production and the next event cannot be set up without a code change.

## Goal

An organiser can set the next event's number, title, start date and banner image from a web page, without touching code and without a developer running a deploy.

## Constraints

These are properties of the existing system, verified 2026-08-18.

- There is no database. All server state is in memory and lost on restart.
- `fly.toml` has no `[mounts]` block, so the machine filesystem is ephemeral. Anything written at runtime is lost on restart or redeploy.
- `public/` is baked into the Docker image at build time via `COPY public/ ./public/`, so an uploaded file cannot simply be written there.
- There is no CI. `.github/workflows` does not exist and deployment is a manual `fly deploy`.
- There is no admin or authorization concept. `sessions` only proves that someone logged in with *some* Bluesky account.
- The entire frontend is one inline `<script>`. Any error thrown at load time kills the whole script, including login.

## Decisions

Each of these was chosen deliberately over the alternatives noted.

**Persistence: commit back to git.**
The server writes the config and banner into the repository itself, rather than to a Fly volume or object storage.
Config stays version-controlled and no new storage infrastructure is needed.
The cost is that each banner lives in git history permanently, and the server needs a repo-write token.

**Deploy: GitHub Actions.**
A new workflow runs `flyctl deploy` on push to `main`, so a commit reaches production without anyone at a terminal.
Without this the git approach would not reach the live site at all.
The workflow runs the test suite first, so a bad commit does not deploy.

**Authorization: a single shared password.**
`ADMIN_PASSWORD` rather than an allowlist of Bluesky handles.
The accepted consequence is no per-person attribution, since every commit comes from one identity.

**Editable fields: number, title, start date/time, banner.**
The "Post this" text and the image alt text are derived from those rather than separately editable, so there is one less thing to get wrong and nothing about the event stays hardcoded.

**Config transport: a committed `public/event.json`, fetched directly.**
`express.static` already serves it, so there is no new API route and no server-side event state.
The server only ever writes this file, via GitHub.

**Commit shape: one atomic commit via the Git Data API.**
The Contents API commits one file per call, so a banner-then-JSON sequence could half-succeed and deploy an `event.json` pointing at an image that does not exist.
Blobs, then a tree, then a commit, then a ref update puts both files in a single commit — and any failure before the ref update leaves `main` untouched, so nothing deploys.

## Architecture

```
admin.html  ──password──▶  POST /api/admin/login  ──▶  short-lived admin token
admin.html  ──token + 4 fields + banner──▶  POST /api/admin/event
                                              │
                                              ├─ validate everything server-side
                                              └─ one atomic commit to main
                                                   (banners/btc68.jpg + event.json)
                                                        │
                                              GitHub Actions: npm test, then flyctl deploy
                                                        │
                                              index.html fetches event.json ──▶ card renders
```

### Components

| Component | Responsibility |
|---|---|
| `public/admin.html` | Standalone page: password step, four fields pre-filled from the current `event.json`, image picker, live countdown preview, Save |
| `public/event.json` | Single source of truth for the current event |
| `public/banners/` | Uploaded banners, named per event |
| `lib/event-config.js` | Pure functions: input validation, JSON building, banner path, timing-safe compare |
| `server.js` admin section | Auth, rate limiting, and the GitHub commit |
| `.github/workflows/deploy.yml` | Test then deploy on push to `main` |

`admin.html` is deliberately a separate file rather than another panel in `index.html`, which is already 2,200 lines.

### `event.json`

```json
{
  "number": 68,
  "title": "World Cup Whiskies",
  "startIso": "2026-09-19T20:00:00+01:00",
  "imagePath": "banners/btc68.jpg"
}
```

Everything else is derived by the frontend, preserving today's exact output:

- Kicker: `#BTC68`
- Header title: `<title> · <day> <month>` from `startIso`
- Image alt: `<title> #BTC68`
- Post text: `<title> — <countdown> #BTC68 #BlindDrams`

The post text already contains `#BlindDrams`, so `/api/post`'s tag-appending logic correctly leaves it alone.

## Data flow: frontend

`#header-event` starts hidden.
On load, `loadEvent()` fetches `event.json`, validates the four fields are present and well-typed, populates the image, kicker and title, and then calls `updateCountdown()`.

`updateCountdown()` keeps the card hidden when there is no config or when the start time has passed, and otherwise shows it with the remaining time. The existing 60-second interval is unchanged.

A missing, unparseable or invalid `event.json` leaves the card hidden and must not throw.
This matters more than it looks: a throw here would kill the single inline script and take login down with it, which is the failure mode already fixed once in `73d3fdd`.

The "Post this" button is shown only when the user is signed in *and* a valid future event is loaded, and it fetches the banner from `event.imagePath`.

`TASTING_START_ISO` is deleted.

## Data flow: server

### `POST /api/admin/login`

Returns 503 when `ADMIN_PASSWORD` is unset, mirroring how the `/api/klipy/*` routes degrade without `KLIPY_API_KEY`.

Compares with `crypto.timingSafeEqual` over SHA-256 digests of both values, so the buffers are always equal length — `timingSafeEqual` throws on a length mismatch, which would otherwise leak length through an exception.

Per-IP attempt counting: at most 5 failed attempts per 15 minutes, then 429 for the remainder of that window.
`app.set('trust proxy', true)` is already configured, so `req.ip` is the real client address behind Fly's proxy.
This is the only barrier in front of the repo-write token, so it is required, not optional.
The counter lives in memory and therefore resets on restart, which is acceptable: a restart is not attacker-triggerable here, and the machine is long-lived (`min_machines_running = 1`, `auto_stop_machines = 'off'`).

On success, mints a UUID into an in-memory `adminSessions` Map with a 2 hour expiry and returns it.
Expired entries are swept on access; the map is tiny.

### `POST /api/admin/event`

Requires a valid unexpired admin token, otherwise 401.

Validation, all server-side, none of it trusting the client:

| Field | Rule |
|---|---|
| `number` | Integer, 1–999 |
| `title` | Non-empty after trim, max 60 characters |
| `startIso` | Parses to a valid date and carries an explicit UTC offset |
| `imageBase64` | Optional. When present, `image/jpeg` or `image/png`, decoded size at most 1MB |

The image is optional so a typo in the title can be corrected without re-uploading a banner.
The 1MB cap exists because the file enters git history permanently; the existing theme images are 230–280KB.

**When an image is uploaded**, its path is built from the validated integer as `banners/btc<number>.jpg`, so path traversal is impossible by construction rather than by sanitising a client-supplied name.

**When no image is uploaded, `imagePath` keeps its existing value** and the commit contains only `event.json`.
This matters: deriving `imagePath` from `number` unconditionally would, on a number change without a new upload, point the card at a `banners/btc<new>.jpg` that does not exist.
So the server reads the current `event.json` from the repository as part of building the commit, and carries `imagePath` forward unless a new image replaces it.

A wrong-but-valid date is caught by the admin page's live countdown preview rather than by validation, since a past date is legitimate for testing.

Commit sequence against `GITHUB_REPO` using `GITHUB_TOKEN`:

1. Read the `heads/main` ref for the base commit SHA.
2. Read that commit for its tree SHA.
3. Create a blob per changed file — `event.json` as UTF-8, and the banner as base64 only when one was uploaded.
4. Create a tree with `base_tree` set to the base tree, each changed path at mode `100644` — two entries when a banner was uploaded, otherwise one.
5. Create a commit whose message follows the existing history style, e.g. `chore: set BTC68 World Cup Whiskies banner and date`.
6. Update the `heads/main` ref to the new commit.

Any failure before step 6 leaves `main` untouched and therefore triggers no deploy.
Responds with the commit URL and the Actions run URL so the page can link to the running deploy.

## Error handling

| Failure | Response |
|---|---|
| `ADMIN_PASSWORD` or `GITHUB_TOKEN` unset | 503, admin page reports "not configured" |
| Wrong password | 401, increments the rate-limit counter |
| Too many attempts | 429 |
| Invalid or expired admin token | 401, page returns to the password step |
| Field validation failure | 400 naming the offending field |
| GitHub API failure | 502; ref untouched, nothing deploys |
| `event.json` missing or invalid | Card stays hidden; no throw; login unaffected |

The admin page cannot know when the deploy finishes, so it reports success as "committed — live in about two minutes" with a link to the Actions run rather than claiming the site is updated.

## Testing

### Replacing the literal assertions

`test/ui-features.test.js` currently asserts on `BTC67`, `World Cup Whiskies` and `btc67-theme.jpeg` as literal strings, which would have to be edited every month — exactly the toil this work removes.

Those become mechanism assertions:

- `public/event.json` exists, parses, and has a well-typed `number`, `title`, `startIso` and `imagePath`.
- The file named by `imagePath` exists under `public/`.
- `index.html` fetches `event.json`, and contains no `BTC\d+` literal and no `TASTING_START_ISO`.
- `admin.html` exists, carries `noindex`, has the four fields, and posts to `/api/admin/event`.

### First real server tests

The existing suite only regex-matches `index.html` as text and cannot execute anything.
Extracting the pure logic into `lib/event-config.js` gives the project its first behavioural tests, in a new `test/event-config.test.js`:

- Validation accepts a known-good input and rejects each field's failure modes individually, including a non-integer number, an over-long title, a date with no offset, an unparseable date, a wrong MIME type, and an oversized image.
- The banner path is derived correctly and cannot escape `banners/`.
- The timing-safe comparison returns true for equal values and false for differing values, including values of different lengths.
- `event.json` is built with exactly the four expected keys.

This keeps the route handlers thin and is the only restructuring proposed here.

### Verification beyond the suite

`npm test` cannot catch a syntax error, because it only matches text while the whole frontend is one inline script where a parse failure kills everything.
Frontend changes must additionally be parse-checked by extracting the inline script and running `node --check` on it.

## Files

New:

- `public/admin.html`
- `public/event.json` — seeded with the current BTC67 values so nothing regresses; `imagePath` initially points at the existing `btc67-theme.jpeg` rather than duplicating it into `banners/`. Note the seeded start date is already in the past, so the card is correctly hidden immediately after this ships — that is the current production behaviour preserved, not a fault, and it clears the first time an event is saved through the admin page
- `public/banners/` — created on first upload
- `lib/event-config.js`
- `test/event-config.test.js`
- `.github/workflows/deploy.yml`

Modified:

- `server.js` — admin routes
- `public/index.html` — render the card from `event.json`, delete the hardcoded values
- `test/ui-features.test.js` — mechanism assertions
- `Dockerfile` — add `COPY lib/ ./lib/`
- `.env.example` — `ADMIN_PASSWORD`, `GITHUB_TOKEN`, `GITHUB_REPO`
- `CLAUDE.md` — replace the "event config is hardcoded in five places" guidance

### Dockerfile trap

The Dockerfile copies `server.js` and `public/` explicitly and nothing else.
Adding `lib/` without a matching `COPY` line produces an image that builds successfully and then crashes on boot with a module-not-found error.

## Credentials

Three secrets are required. All three must be created by Pete, since they are credentials.

| Secret | Where | How |
|---|---|---|
| `ADMIN_PASSWORD` | Fly secret | Chosen by Pete, `fly secrets set` |
| `GITHUB_TOKEN` | Fly secret | Fine-grained PAT, Contents read/write, scoped to this repository only |
| `FLY_API_TOKEN` | GitHub repo secret | `fly tokens create deploy` |

`GITHUB_REPO` defaults to `pete-van-jaarsveldt/BskyBlindDramsGroup` and needs no secret.

## Security note

This adds a GitHub Actions workflow and a repo-write token to a project that has neither today.
A compromise of the admin page therefore becomes a compromise of the repository, rather than only a wrong banner.
The mitigations are the fine-grained token scoped to one repository with contents-only permission, the rate limit, and the timing-safe comparison.
The alternative that keeps the blast radius at "wrong banner" is a Fly volume, which was considered and not chosen.

## Out of scope

- Editing past events or keeping an event history. `event.json` holds one current event; git history is the record.
- Changing what happens when the countdown expires. The card continues to hide itself.
- Any change to the tasting or free-post compose flows.

## Verify at implementation time

- The `superfly/flyctl-actions/setup-flyctl` action name and usage against current Fly documentation rather than from memory.
- The exact GitHub Git Data API request shapes for blob, tree, commit and ref-update against current GitHub documentation.
