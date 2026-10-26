// Moving skill folders safely: a rename, or across devices a copy that is verified file by file
// (content hashes, link targets) before the source is deleted. A failed move never loses the source.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exists } from '../core/files.mjs';

// Map of relative path -> "d" | "l|<target>" | "f|<sha256>": content, not just size.
function treeMap(dir, base = dir, acc = new Map()) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    const rel = path.relative(base, p);
    if (d.isDirectory()) { acc.set(rel, 'd'); treeMap(p, base, acc); }
    else if (d.isSymbolicLink()) acc.set(rel, `l|${fs.readlinkSync(p)}`);
    else acc.set(rel, `f|${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
  }
  return acc;
}

/** True when every entry of folder `a` exists in folder `b` with the same content. */
export function isSubset(a, b) {
  try {
    const ma = treeMap(a);
    const mb = treeMap(b);
    for (const [k, v] of ma) if (mb.get(k) !== v) return false;
    return true;
  } catch { return false; }
}

/**
 * Moves a folder: rename, and only on EXDEV copy + verify + delete. Any other rename error fails with
 * the source untouched. If the copy is good but the source cannot be deleted, the error carries
 * `leftover` (the source path). `rename` and `remove` are test hooks (reached via opts._deps).
 */
export function moveDir(src, dst, { rename = fs.renameSync, remove = (p) => fs.rmSync(p, { recursive: true, force: true }) } = {}) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    rename(src, dst);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }
  try {
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    if (!isSubset(src, dst) || !isSubset(dst, src)) throw new Error('copy does not match the original');
  } catch (e) {
    fs.rmSync(dst, { recursive: true, force: true });
    throw new Error(`Could not move ${src}: ${e.message}`);
  }
  try { remove(src); } catch (e) {
    if (exists(src)) throw Object.assign(new Error(`copied but could not remove ${src}: ${e.code || e.message}`), { leftover: src });
  }
}

/**
 * Arguments for fs.symlinkSync to recreate a folder link. On Windows a junction (absolute
 * target), which needs no Developer Mode or admin rights, like the skills CLI uses there.
 */
export function dirLinkArgs(target, linkPath, platform) {
  if (platform !== 'win32') return [target, linkPath, 'dir'];
  return [path.win32.resolve(path.win32.dirname(linkPath), target), linkPath, 'junction'];
}
