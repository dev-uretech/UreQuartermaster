// Installing a verified bundle and rolling back. Nothing on disk changes before the signature, the
// tag/bundle version match and the downgrade check pass; the installed copy is then swapped by renames
// under the update lock, keeping the previous version in <dataDir>/backup (three at most), so an
// interrupted update or rollback leaves a working installation behind.
import fs from 'node:fs';
import path from 'node:path';
import { readBundle, verifySignature, isSemver, versionFromSource, VERSION_FILE, REQUIRED } from './bundle.mjs';
import { VERSION } from '../version.mjs';
import { dataDir as defaultDataDir } from '../core/paths.mjs';
import { isBelow } from '../core/files.mjs';
import { clean } from '../core/text.mjs';
import { acquireLock } from './lock.mjs';
import { semverCompare } from './release.mjs';

const KEEP_BACKUPS = 3;
const BACKUP_NAME = /^(\d+\.\d+\.\d+)-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:-(\d+))?$/;

/** Version declared by the installed copy's version.mjs, or null. */
export function installedVersionOf(skillDir) {
  try { return versionFromSource(fs.readFileSync(path.join(skillDir, ...VERSION_FILE.split('/')), 'utf8')); } catch { return null; }
}

/** rename, or on EXDEV copy then vacate the source with a same-device rename before deleting. */
function moveDir(src, dst, rename) {
  try { rename(src, dst); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  try {
    fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  } catch (e) {
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
    throw e;
  }
  const trash = `${src}.old-${process.pid}-${Date.now()}`;
  try { fs.renameSync(src, trash); } catch (e) {
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
    throw e;
  }
  try { fs.rmSync(trash, { recursive: true, force: true }); } catch {}
}

const stamp = (d) => d.toISOString().replace(/[:.]/g, '-');
function freePath(p) {
  if (!fs.existsSync(p)) return p;
  for (let i = 1; ; i++) if (!fs.existsSync(`${p}-${i}`)) return `${p}-${i}`;
}

/** Backups, newest first: by mtime (set when a backup is made), then by stamp. */
function listBackups(root) {
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  return names
    .map((name) => ({ name, m: BACKUP_NAME.exec(name), path: path.join(root, name) }))
    .filter((b) => b.m)
    .map((b) => ({ ...b, t: mtime(b.path) }))
    .sort((a, b) => b.t - a.t
      || (a.m[2] === b.m[2] ? Number(b.m[3] || 0) - Number(a.m[3] || 0) : a.m[2] < b.m[2] ? 1 : -1));
}

/** Marks a fresh backup as the newest: a rename keeps the folder's old mtime. */
function touch(p) {
  const t = new Date();
  try { fs.utimesSync(p, t, t); } catch {}
}

/** Keeps `keep` (always) plus the newest others, up to KEEP_BACKUPS in all. */
function pruneBackups(root, keep) {
  const others = listBackups(root).filter((b) => b.path !== keep);
  for (const b of others.slice(KEEP_BACKUPS - (keep ? 1 : 0))) {
    try { fs.rmSync(b.path, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Verifies, then installs a signed bundle in place of skillDir. Nothing on disk changes
 * before the signature, the tag/bundle version match and the downgrade check pass.
 */
export function applyUpdate({ skillDir, bundleBuf, sigBase64, publicKeyPem, tagVersion, _deps = {} }) {
  if (!publicKeyPem) throw new Error('No release key: refusing to install');
  if (!verifySignature(bundleBuf, sigBase64, publicKeyPem)) throw new Error('The release signature does not verify');
  const bundle = readBundle(bundleBuf);
  if (!isSemver(tagVersion) || bundle.version !== tagVersion) {
    throw new Error(`Bundle version ${bundle.version} does not match the release tag ${clean(tagVersion)}`);
  }
  const real = fs.realpathSync(skillDir);
  const installed = _deps.currentVersion || installedVersionOf(real) || VERSION;
  if (semverCompare(bundle.version, installed) <= 0) {
    throw new Error(`Release ${bundle.version} is not newer than the installed ${installed}`);
  }
  const rename = _deps.rename || fs.renameSync;
  const writeFile = _deps.writeFile || fs.writeFileSync;
  const data = _deps.dataDir || defaultDataDir(_deps.env || process.env);
  const now = _deps.now || new Date();
  const unlock = acquireLock(data);
  const staging = `${real}.new-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging);
    for (const [rel, bytes] of Object.entries(bundle.files)) {
      const target = path.join(staging, ...rel.split('/'));
      if (!isBelow(staging, target)) throw new Error(`Bundle path escapes the folder: ${rel}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeFile(target, bytes, { flag: 'wx' });
    }
    const backupRoot = path.join(data, 'backup');
    fs.mkdirSync(backupRoot, { recursive: true });
    const backup = freePath(path.join(backupRoot, `${installed}-${stamp(now)}`));
    moveDir(real, backup, rename);
    touch(backup);
    try {
      rename(staging, real);
    } catch (e) {
      try { moveDir(backup, real, rename); } catch (e2) {
        throw new Error(`Update failed (${e.message}) and the previous version could not be put back (${e2.message}); it is in ${backup}`);
      }
      throw e;
    }
    pruneBackups(backupRoot, backup);
    return { from: installed, to: bundle.version, backup, notes: bundle.notes };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    unlock();
  }
}

const looksInstalled = (dir) => REQUIRED.every((r) => fs.existsSync(path.join(dir, ...r.split('/'))));

/** Puts the most recent backup back; the replaced copy becomes a backup itself. */
export function rollback(skillDir, { _deps = {} } = {}) {
  const data = _deps.dataDir || defaultDataDir(_deps.env || process.env);
  const rename = _deps.rename || fs.renameSync;
  const now = _deps.now || new Date();
  const backupRoot = path.join(data, 'backup');
  const target = listBackups(backupRoot).find((b) => looksInstalled(b.path));
  if (!target) throw new Error('No backup to roll back to');
  const unlock = acquireLock(data);
  try {
    const real = fs.realpathSync(skillDir);
    const current = installedVersionOf(real) || VERSION;
    const staging = `${real}.new-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    moveDir(target.path, staging, rename);
    let displaced;
    try {
      displaced = freePath(path.join(backupRoot, `${current}-${stamp(now)}`));
      moveDir(real, displaced, rename);
      touch(displaced);
      try { rename(staging, real); } catch (e) { moveDir(displaced, real, rename); throw e; }
    } catch (e) {
      try { moveDir(staging, target.path, rename); } catch {}
      throw e;
    }
    pruneBackups(backupRoot, displaced);
    return { from: current, to: installedVersionOf(real) || target.m[1] };
  } finally {
    unlock();
  }
}
