// Names and sources the library accepts: git URLs and local folders for `qm add`, collection names
// and parked folder names. Everything is checked against an allowlist before git or the file system
// sees it: no option-like first character, no shell metacharacters, no control or bidi characters,
// no Windows reserved device names.
import path from 'node:path';
import { isDir } from '../core/files.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CTRL = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u061c\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const SHELLY = /[;|&$`<>"'\\]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const isReserved = (n) => RESERVED.test(String(n).split('.')[0].trim());
const HOST = '[A-Za-z0-9][A-Za-z0-9.-]*(?::\\d+)?';
const USERINFO = '(?:[^\\s@/-][^\\s@/]*@)?';
const URL_RES = [
  new RegExp(`^https://${USERINFO}${HOST}/[^\\s]+$`),
  new RegExp(`^ssh://${USERINFO}${HOST}/[^\\s]+$`),
  /^git@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s:-][^\s]*$/, // scp-like
];

/** Throws unless `src` is https://, ssh://, scp-like git@host:path or an absolute local directory. */
export function validateSource(src) {
  const refuse = (why) => new Error(`Source not accepted (${why}). Use https://…, ssh://…, git@host:path or an absolute path to a local folder.`);
  if (typeof src !== 'string' || !src) throw refuse('empty');
  if (CTRL.test(src)) throw refuse('control characters');
  if (src.startsWith('-')) throw refuse('looks like an option');
  if (URL_RES.some((re) => re.test(src))) {
    if (SHELLY.test(src)) throw refuse('shell metacharacters');
    return src;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src) && !/^[A-Za-z]:[\\/]/.test(src)) throw refuse('unsupported scheme or format');
  if (path.isAbsolute(src)) {
    if (!isDir(src)) throw refuse('not an existing folder');
    return src; // the user's own folder; spaces are fine here
  }
  throw refuse('unsupported scheme or format');
}

/** Collection name from the last path segment of the source, without .git, lowercased (not validated). */
export function deriveName(src) {
  let s = String(src).replace(/[\\/]+$/, '');
  s = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'), s.lastIndexOf(':')) + 1);
  return s.replace(/\.git$/i, '').toLowerCase();
}

export function checkName(name) {
  const n = String(name).toLowerCase();
  if (!NAME_RE.test(n) || isReserved(n)) throw new Error(`Invalid collection name "${name}": use 1-64 characters from a-z, 0-9, ".", "_", "-", starting with a letter or digit.`);
  return n;
}

/** True when `name` can be used as one folder name on every platform. */
export function safeFolderName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 128 && !/[\\/\x00-\x1f\x7f<>:"|?*]/.test(name) && !isReserved(name)
    && name !== '.' && name !== '..' && !name.startsWith('.') && !/[. ]$/.test(name);
}
