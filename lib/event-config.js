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
