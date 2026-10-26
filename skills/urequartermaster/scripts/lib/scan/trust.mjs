// Trust rules for third-party skills. Every skill name must be shell-inert, since the agent puts it on
// a command line. Skills from places the user does not control (the current repository and library
// collections) must also have a plain folder and SKILL.md (not links) that resolve inside their own
// root. These checks run at scan time and again when a skill is loaded.
import fs from 'node:fs';
import path from 'node:path';
import { safe, real } from '../core/files.mjs';

/** True when every path exists and its realpath is `root` itself or below it. `root` must already be a realpath. */
export function checkContained(root, ...paths) {
  if (typeof root !== 'string' || !root) return false;
  return paths.every((p) => {
    const t = real(p);
    if (t === null) return false;
    const rel = path.relative(root, t);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// A skill name is the one third-party field the agent is told to put on a command line
// (`qm load <name>`), so it must be shell-inert: letters, digits, marks, '.', '_', '-', first
// char a letter or digit (never an option), at most 128 chars. ':' is reserved for plugin:skill.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._-]{0,127}$/u;
/** True when `n` is a safe single skill (or plugin) name. */
export const isSafeName = (n) => typeof n === 'string' && NAME_RE.test(n);
/** True when every ':'-separated part of an index name is safe (covers plugin:skill). */
export const isSafeEntryName = (n) => typeof n === 'string' && n.split(':').length <= 2 && n.split(':').every(isSafeName);

const isLink = (p) => safe(() => fs.lstatSync(p).isSymbolicLink(), true);

/**
 * Untrusted skill (project or library): the folder and SKILL.md are plain, not links, and both
 * resolve inside `root` (realpath of the skills dir or of the collection).
 */
export function plainSkillInside(root, folder, file) {
  const plain = (p, kind) => safe(() => { const st = fs.lstatSync(p); return !st.isSymbolicLink() && (kind === 'dir' ? st.isDirectory() : st.isFile()); }, false);
  return plain(folder, 'dir') && plain(file, 'file') && checkContained(root, folder, file);
}

// Trust root of a library collection: refuses links at <dataDir>/library and at the collection itself.
export function libraryRoot(dataDir, collection) {
  const lib = path.join(dataDir, 'library');
  const cDir = path.join(lib, collection);
  if (isLink(lib) || isLink(cDir)) return null;
  const root = real(cDir);
  return root !== null && checkContained(real(lib), root) ? root : null;
}

/**
 * Re-verifies, at load time, a skill that does not come from a trusted user dir.
 * Project: trustRoot must still be realpath(cwd) and skills dir, folder and SKILL.md lie inside it.
 * Library: same lstat/inside-library rules as the scan. Other entries: true.
 */
export function verifyEntryTrust(e, { cwd, dataDir }) {
  if (!e.path) return true;
  const folder = path.dirname(e.path);
  if (e.source === 'project') {
    const cwdReal = real(cwd);
    const skillsDir = path.dirname(folder);
    const root = real(skillsDir);
    return cwdReal !== null && root !== null && e.trustRoot === root && checkContained(cwdReal, skillsDir)
      && plainSkillInside(root, folder, e.path);
  }
  if (typeof e.source === 'string' && e.source.startsWith('library:')) {
    if (!dataDir) return false;
    const root = libraryRoot(dataDir, e.source.slice('library:'.length));
    return root !== null && (!e.trustRoot || e.trustRoot === root) && plainSkillInside(root, folder, e.path);
  }
  return true;
}
