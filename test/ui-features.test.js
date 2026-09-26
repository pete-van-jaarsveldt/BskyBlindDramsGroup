import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');

test('renders the Blind Tasting Consortium logo from a public asset', () => {
  assert.match(html, /<img[^>]+src="blinddrams-logo\.jpeg"/);
  assert.ok(existsSync(join(root, 'public', 'blinddrams-logo.jpeg')));
});

test('defines a mobile-friendly layout breakpoint', () => {
  assert.match(html, /@media\s*\(max-width:\s*760px\)/);
  assert.match(html, /\.layout\s*{\s*flex-direction:\s*column/);
});

test('keeps feed images visually smaller than full-width cards', () => {
  assert.match(html, /--feed-image-max:/);
  assert.match(html, /max-width:\s*var\(--feed-image-max\)/);
});

test('allows image attachments from each dram tasting page', () => {
  assert.match(html, /data-stage-img-input="appearance"/);
  assert.match(html, /data-stage-img-input="nose"/);
  assert.match(html, /data-stage-img-input="palate"/);
  assert.match(html, /data-stage-img-input="finish"/);
  assert.match(html, /data-stage-img-input="score"/);
  assert.match(html, /function attachmentPayload/);
  assert.match(html, /attachmentPayload\(stageImages\[payload\.dram\]\[payload\.stage\]\)/);
});

test('posts picked GIFs as link cards, not image blobs, so they stay animated', () => {
  assert.match(html, /const item = \{ gif: data\.gif,/);
  assert.match(html, /\.\.\.attachmentPayload\(pendingBlobs\)/);
});

test('bounds login requests so the sign-in button can recover', () => {
  assert.match(html, /LOGIN_TIMEOUT_MS/);
  assert.match(html, /new AbortController\(\)/);
  assert.match(html, /Sign in timed out/);
});

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

test('every getElementById reference resolves to an element id (a missing id throws and kills the whole inline script, breaking login)', () => {
  const referenced = [...new Set([...html.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))];
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const orphans = referenced.filter(id => !defined.has(id));
  assert.deepEqual(orphans, [], `getElementById() references with no matching id="..." in the markup: ${orphans.join(', ')}`);
});

test('downscales oversized photos client-side so posts stay under the 2MB Bluesky blob limit', () => {
  assert.match(html, /function downscaleImage/);
  assert.match(html, /createImageBitmap/);          // decode for canvas re-encode
  assert.match(html, /BSKY_MAX_BLOB_BYTES\s*=\s*2_?000_?000/);
  assert.match(html, /image\/gif/);                 // GIFs passed through untouched (preserve animation)
  // the single upload chokepoint must route through the downscaler
  assert.match(html, /async function uploadImageFile[\s\S]*?downscaleImage\(/);
});

test('uses collapsible per-dram workflow stages without a Ready stage', () => {
  assert.match(html, /data-stage="appearance"/);
  assert.match(html, /Appearance/);
  assert.match(html, /stage-toggle/);
  assert.match(html, /collapsed/);
  assert.doesNotMatch(html, /data-stage="ready"/i);
});
