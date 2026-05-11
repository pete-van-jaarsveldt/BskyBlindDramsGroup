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
  assert.match(html, /function getStageBlobs/);
  assert.match(html, /getStageBlobs\(payload\.dram,\s*payload\.stage\)/);
});

test('bounds login requests so the sign-in button can recover', () => {
  assert.match(html, /LOGIN_TIMEOUT_MS/);
  assert.match(html, /new AbortController\(\)/);
  assert.match(html, /Sign in timed out/);
});

test('shows the current tasting theme and countdown without auto-adding the BTC tag', () => {
  assert.match(html, /BTC65/);
  assert.match(html, /Grape Expectations/);
  assert.match(html, /btc65-theme\.jpeg/);
  assert.match(html, /TASTING_START_ISO/);
  assert.match(html, /id="event-countdown"/);
  assert.doesNotMatch(html, /#BTC65`|#BTC65\s*\$\{/);
});

test('uses collapsible per-dram workflow stages without a Ready stage', () => {
  assert.match(html, /data-stage="appearance"/);
  assert.match(html, /Appearance/);
  assert.match(html, /stage-toggle/);
  assert.match(html, /collapsed/);
  assert.doesNotMatch(html, /data-stage="ready"/i);
});
