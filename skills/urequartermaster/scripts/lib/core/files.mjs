// File-system helpers shared by the scanners, the library and the stores.
// Read helpers never throw: a missing or unreadable path gives the fallback (null, false, []).
// writeFileAtomic replaces a file in one rename, so a reader never sees half a file.
import fs from 'node:fs';
import path from 'node:path';

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** fn(), or `fallback` when it throws. */
export const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
export const real = (p) => safe(() => fs.realpathSync(p), null);
export const lstat = (p) => safe(() => fs.lstatSync(p), null);
export const exists = (p) => lstat(p) !== null; // the path itself, links included
export const isDir = (p) => safe(() => fs.statSync(p).isDirectory(), false); // follows symlinks
export const isFile = (p) => safe(() => fs.statSync(p).isFile(), false); // follows symlinks
export const isPlainDir = (p) => { const st = lstat(p); return !!st && st.isDirectory() && !st.isSymbolicLink(); };
export const listDir = (p) => safe(() => fs.readdirSync(p, { withFileTypes: true }), []);

/** True when `child` is strictly below `parent` (lexically: no realpath is taken). */
export const isBelow = (parent, child) => {
  const r = path.relative(parent, child);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
};

/** Parsed JSON object in `file` (a leading BOM is ignored); null when missing, malformed or not an object. */
export function readJsonObject(file) {
  return safe(() => {
    const v = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return isObj(v) ? v : null;
  }, null);
}

/** Writes `data` to a temporary file next to `file`, then renames it over `file`. */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}
