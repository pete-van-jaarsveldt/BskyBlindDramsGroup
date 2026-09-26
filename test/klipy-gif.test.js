import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKlipyGifUri, isKlipyMediaUrl } from '../lib/klipy-gif.js';

const DIR = 'https://static.klipy.com/ii/925f17378dd1893b674a723c07535afe/67/79';
const media = {
  gif:  { url: `${DIR}/r8B63esk.gif`, width: 220, height: 180 },
  mp4:  { url: `${DIR}/ZwZwgW9b.mp4`, width: 320, height: 320 },
  webm: { url: `${DIR}/isz1rikxb8lob0.webm`, width: 320, height: 320 },
};

test('builds the URL shape the Bluesky app recognises as a playable Klipy GIF', () => {
  const uri = new URL(buildKlipyGifUri(media));
  assert.equal(uri.origin + uri.pathname, media.gif.url);
  assert.equal(uri.searchParams.get('hh'), '180');
  assert.equal(uri.searchParams.get('ww'), '220');
  assert.equal(uri.searchParams.get('mp4'), 'ZwZwgW9b');
  assert.equal(uri.searchParams.get('webm'), 'isz1rikxb8lob0');
});

test('omits video slugs Klipy did not supply', () => {
  const uri = new URL(buildKlipyGifUri({ gif: media.gif }));
  assert.equal(uri.searchParams.has('mp4'), false);
  assert.equal(uri.searchParams.has('webm'), false);
});

test('rejects media that is not hosted on static.klipy.com', () => {
  assert.throws(() => buildKlipyGifUri({ gif: { ...media.gif, url: 'https://evil.example/x.gif' } }));
  assert.throws(() => buildKlipyGifUri({ gif: { ...media.gif, width: 0 } }));
  assert.throws(() => buildKlipyGifUri({}));
});

test('isKlipyMediaUrl only accepts https static.klipy.com /ii/ paths', () => {
  assert.equal(isKlipyMediaUrl(`${DIR}/V7nUIQRC.jpg`), true);
  assert.equal(isKlipyMediaUrl('http://static.klipy.com/ii/a.jpg'), false);
  assert.equal(isKlipyMediaUrl('https://static.klipy.com.evil.example/ii/a.jpg'), false);
  assert.equal(isKlipyMediaUrl('not a url'), false);
});
