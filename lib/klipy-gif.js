// Bluesky only animates a GIF when it is posted as an external embed pointing at
// static.klipy.com — an uploaded image blob is served back by the CDN as a still
// webp. This mirrors resolveGif() in bluesky-social/social-app: the Bluesky client
// reads the dimensions from `hh`/`ww` and swaps in the video file named by the
// `mp4`/`webm` slugs, which Klipy names independently of the .gif.

export function isKlipyMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'static.klipy.com' && url.pathname.startsWith('/ii/');
  } catch {
    return false;
  }
}

function fileSlug(url) {
  const name = url?.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : undefined;
}

// `media` is one size of a Klipy item's `file` object, e.g. item.file.md
export function buildKlipyGifUri(media) {
  const gif = media?.gif;
  if (!isKlipyMediaUrl(gif?.url)) throw new Error('Not a Klipy GIF');
  if (!(gif.width > 0 && gif.height > 0)) throw new Error('GIF dimensions missing');

  const params = new URLSearchParams({ hh: String(gif.height), ww: String(gif.width) });
  const mp4  = isKlipyMediaUrl(media.mp4?.url)  && fileSlug(media.mp4.url);
  const webm = isKlipyMediaUrl(media.webm?.url) && fileSlug(media.webm.url);
  if (mp4)  params.set('mp4', mp4);
  if (webm) params.set('webm', webm);

  return `${gif.url.split('?')[0]}?${params}`;
}
