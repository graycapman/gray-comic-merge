// Lazy thumbnails: decoded only for visible rows, a few at a time, with a bounded cache.
import { PREVIEW_EXTS } from '../paths.js';

const MAX_CACHE = 400;
const cache = new Map(); // id -> object URL
export const broken = new Set(); // ids whose image could not be decoded
const waiting = new Map(); // id -> [callbacks]
const queue = [];
let active = 0;

export const peek = (id) => cache.get(id);

async function makeThumb(item) {
  const blob = await item.read();
  const bmp = await createImageBitmap(blob, { resizeWidth: 96, resizeQuality: 'low' });
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.7));
  return URL.createObjectURL(out);
}

async function pump() {
  while (active < 3 && queue.length) {
    const item = queue.shift();
    active++;
    makeThumb(item)
      .then((url) => {
        cache.set(item.id, url);
        if (cache.size > MAX_CACHE) {
          const [oldId, oldUrl] = cache.entries().next().value;
          URL.revokeObjectURL(oldUrl);
          cache.delete(oldId);
        }
        (waiting.get(item.id) || []).forEach((cb) => cb(url));
      })
      .catch(() => { broken.add(item.id); (waiting.get(item.id) || []).forEach((cb) => cb(null)); })
      .finally(() => { waiting.delete(item.id); active--; pump(); });
  }
}

/** Calls `cb(url|null)` when the thumbnail is ready. Returns true when a request was queued. */
export function requestThumb(item, cb) {
  if (!PREVIEW_EXTS.has(item.ext) || broken.has(item.id)) return false;
  if (waiting.has(item.id)) { waiting.get(item.id).push(cb); return true; }
  waiting.set(item.id, [cb]);
  queue.push(item);
  pump();
  return true;
}

/** Drops queued work for pages that scrolled away. */
export function pruneQueue(visibleIds) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!visibleIds.has(queue[i].id)) { waiting.delete(queue[i].id); queue.splice(i, 1); }
  }
}
