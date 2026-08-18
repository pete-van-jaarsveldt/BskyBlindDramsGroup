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
