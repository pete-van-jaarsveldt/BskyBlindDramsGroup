import assert from 'node:assert/strict';
import test from 'node:test';
import { authorDidFromUri, isOwnPost } from '../lib/post-identity.js';

const MINE = 'did:plc:bzm3t46uibvh5zg42toqnuqx';
const THEIRS = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const myPost = `at://${MINE}/app.bsky.feed.post/3mtf6bzu7pk2h`;
const theirPost = `at://${THEIRS}/app.bsky.feed.post/3mtf6bzu7pk2h`;

test('extracts the author DID that an AT-URI embeds', () => {
  assert.equal(authorDidFromUri(myPost), MINE);
  assert.equal(authorDidFromUri(theirPost), THEIRS);
});

test('handles the did:web method as well as did:plc', () => {
  assert.equal(
    authorDidFromUri('at://did:web:example.com/app.bsky.feed.post/abc'),
    'did:web:example.com',
  );
});

test('returns null for anything that is not an AT-URI with a DID authority', () => {
  for (const bad of [
    '',
    null,
    undefined,
    42,
    'https://bsky.app/profile/x/post/y',
    'at://handle.bsky.social/app.bsky.feed.post/abc', // handle authority, not a DID
    'at://',
    'notauri',
  ]) {
    assert.equal(authorDidFromUri(bad), null, `expected null for ${String(bad)}`);
  }
});

test('identifies a post authored by the viewer', () => {
  assert.equal(isOwnPost(myPost, MINE), true);
});

test('does not flag someone else\'s post as the viewer\'s own', () => {
  assert.equal(isOwnPost(theirPost, MINE), false);
});

test('is not fooled by a DID that merely shares a prefix', () => {
  const lookalike = `at://${MINE}extra/app.bsky.feed.post/abc`;
  assert.equal(isOwnPost(lookalike, MINE), false);
});

test('fails OPEN when identity cannot be established, so a hiccup cannot block all likes', () => {
  // This is a product rule, not a security control: the server also cannot be
  // tricked into a self-like, because the DID it compares comes from the URI
  // itself. Blocking every like on an unparseable input would be the worse bug.
  assert.equal(isOwnPost(myPost, null), false);
  assert.equal(isOwnPost(myPost, undefined), false);
  assert.equal(isOwnPost(null, MINE), false);
  assert.equal(isOwnPost('garbage', MINE), false);
});
