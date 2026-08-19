// An AT-URI embeds its author's DID as the authority segment:
//   at://did:plc:bzm3t46uibvh5zg42toqnuqx/app.bsky.feed.post/3mtf6bzu7pk2h
// So "who wrote this post" is answerable from the URI alone, with no API call.
const AT_URI_AUTHOR = /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\//;

export function authorDidFromUri(uri) {
  if (typeof uri !== 'string') return null;
  const match = uri.match(AT_URI_AUTHOR);
  return match ? match[1] : null;
}

// Whether `viewerDid` wrote the post at `uri`.
//
// Deliberately fails OPEN: if either identity cannot be established this returns
// false, so callers treat the post as someone else's. This is a product rule
// ("don't like your own posts"), not a security control — and blocking every like
// because one URI failed to parse would be a worse bug than permitting one
// self-like. The comparison is still trustworthy where it matters, because the
// author DID comes from the URI itself rather than from client-supplied data.
export function isOwnPost(uri, viewerDid) {
  const authorDid = authorDidFromUri(uri);
  if (!authorDid || !viewerDid) return false;
  return authorDid === viewerDid;
}
