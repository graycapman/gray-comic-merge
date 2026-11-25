// Path and file-type helpers. Archive paths always use "/" internally.

export const SUPPORTED_IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'jxl', 'tif', 'tiff',
]);
// Formats a browser can decode for thumbnails and previews.
export const PREVIEW_EXTS = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp']);
const KNOWN_UNSUPPORTED_IMAGES = new Set([
  'svg', 'heic', 'heif', 'ico', 'psd', 'tga', 'xcf', 'raw', 'cr2', 'nef', 'dng', 'jp2', 'j2k', 'ai', 'eps',
]);
export const ARCHIVE_EXTS = new Set(['cbz', 'zip']);
const UNSUPPORTED_ARCHIVE_EXTS = new Set(['cbr', 'rar', '7z', 'cb7', 'cbt', 'tar', 'gz']);

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', jxl: 'image/jxl', tif: 'image/tiff', tiff: 'image/tiff',
};
export const mimeFor = (ext) => MIME[ext] || 'application/octet-stream';

const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

export function splitPath(path) {
  const i = path.lastIndexOf('/');
  const dir = i < 0 ? '' : path.slice(0, i);
  const base = path.slice(i + 1);
  const dot = base.lastIndexOf('.');
  return {
    dir,
    base,
    stem: dot > 0 ? base.slice(0, dot) : base,
    ext: dot > 0 ? base.slice(dot + 1).toLowerCase() : '',
  };
}

/** Normalises separators and removes "." / ".." segments so names are safe to display and reuse. */
export function normalizeArchivePath(name) {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .join('/');
}

/**
 * Decides what an entry is. Nothing is dropped silently: callers list every
 * non-image result in the import report together with `reason`.
 */
export function classifyEntry(path) {
  const { base, ext } = splitPath(path);
  const lower = base.toLowerCase();
  if (path.split('/').includes('__MACOSX') || JUNK_NAMES.has(lower) || base.startsWith('._')) {
    return { kind: 'skip', category: 'system', reason: 'system file (ignored)' };
  }
  if (SUPPORTED_IMAGE_EXTS.has(ext)) return { kind: 'image', ext };
  if (KNOWN_UNSUPPORTED_IMAGES.has(ext)) {
    return { kind: 'skip', category: 'unsupported-image', reason: `unsupported image format (.${ext})` };
  }
  if (ARCHIVE_EXTS.has(ext)) return { kind: 'archive', ext };
  if (UNSUPPORTED_ARCHIVE_EXTS.has(ext)) {
    return { kind: 'skip', category: 'unsupported-archive', reason: `.${ext} archives are not supported; convert to CBZ first` };
  }
  return { kind: 'skip', category: 'not-image', reason: ext ? `not an image (.${ext})` : 'not an image' };
}

/** Longest folder prefix shared by every directory in `dirs` ('' when none). */
export function commonDirPrefix(dirs) {
  if (!dirs.length) return '';
  let prefix = dirs[0].split('/').filter(Boolean);
  for (const d of dirs) {
    const parts = d.split('/').filter(Boolean);
    let i = 0;
    while (i < prefix.length && i < parts.length && prefix[i] === parts[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix.length) break;
  }
  return prefix.join('/');
}

const FORBIDDEN = /[<>:"\\|?*\u0000-\u001f]/g;

/** Makes one path segment safe for Windows, macOS and Linux. */
export function sanitizeSegment(segment) {
  let s = segment.replace(FORBIDDEN, '_').replace(/[. ]+$/, '');
  if (s === '' || s === '.' || s === '..') s = '_';
  return s;
}

export function pad(n, width) {
  return String(n).padStart(width, '0');
}
