// Release bundles: one gzip'd JSON file holding every file of the skill, signed as a whole
// with Ed25519. readBundle() is the gate for anything that came over the network, so it
// rejects every layout that could write outside the skill folder or collide on disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const TOP_LEVEL_FILES = ['SKILL.md', 'LICENSE', 'README.md'];
export const TOP_LEVEL_DIRS = ['scripts', 'references', 'assets', 'templates'];
export const REQUIRED = ['SKILL.md', 'scripts/qm.mjs'];
export const VERSION_FILE = 'scripts/lib/version.mjs';
const MAX_FILES = 2000;
const MAX_TOTAL = 20 * 1024 * 1024; // decoded bytes
// The JSON carries base64 (4/3 of the data) plus names: cap the inflated text accordingly.
const MAX_JSON = Math.ceil(MAX_TOTAL * 4 / 3) + 1024 * 1024;
const MAX_NOTES = 500;
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// Characters Windows refuses in names, plus every control character.
const BAD_CHARS = /[\x00-\x1f\x7f<>:"|?*\\]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

export const isSemver = (v) => typeof v === 'string' && SEMVER.test(v);

/** Reads `export const VERSION = 'x.y.z'` from version.mjs source text; null if absent. */
export function versionFromSource(text) {
  const m = /export const VERSION = '([^']*)';/.exec(String(text));
  return m && isSemver(m[1]) ? m[1] : null;
}

function segmentError(seg) {
  if (seg === '' || seg === '.' || seg === '..') return 'empty, "." or ".." segment';
  if (seg.startsWith('.')) return 'hidden entry';
  if (BAD_CHARS.test(seg)) return 'forbidden character';
  if (/[. ]$/.test(seg)) return 'name ends with a dot or space';
  if (RESERVED.test(seg)) return 'reserved device name';
  if (/[\p{Cc}\p{Cf}]/u.test(seg)) return 'control or invisible formatting character';
  return null;
}

/** Throws unless `rel` is a safe relative path inside an expected top-level entry. */
export function checkRelPath(rel) {
  const bad = (why) => { throw new Error(`Bundle path ${JSON.stringify(rel)} rejected: ${why}`); };
  if (typeof rel !== 'string' || rel === '') bad('empty name');
  if (rel.length > 400) bad('too long');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) bad('absolute path');
  const segs = rel.split('/');
  for (const s of segs) { const e = segmentError(s); if (e) bad(e); }
  if (TOP_LEVEL_FILES.includes(segs[0])) { if (segs.length !== 1) bad(`${segs[0]} must be a file`); }
  else if (TOP_LEVEL_DIRS.includes(segs[0])) { if (segs.length < 2) bad(`${segs[0]} must be a folder`); }
  else bad('unexpected top-level entry');
  // Executable code: plain ASCII names only.
  if (segs[0] === 'scripts' && !segs.every((x) => /^[A-Za-z0-9._-]+$/.test(x))) bad('names under scripts/ must be ASCII letters, digits, ".", "_" or "-"');
  return segs;
}

/** gzip of JSON { files, notes?, version } with sorted keys: same tree, same bytes. */
export function makeBundle(skillDir, { notes } = {}) {
  const files = {};
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`Symbolic links cannot go in a release: ${r}`);
      if (st.isDirectory()) {
        if (!rel && !TOP_LEVEL_DIRS.includes(name)) throw new Error(`Unexpected top-level entry in the skill: ${r}`);
        walk(p, r);
      } else if (st.isFile()) {
        checkRelPath(r);
        files[r] = fs.readFileSync(p).toString('base64');
      } else throw new Error(`Not a regular file: ${r}`);
    }
  };
  walk(skillDir, '');
  const version = versionFromSource(files[VERSION_FILE] ? Buffer.from(files[VERSION_FILE], 'base64').toString('utf8') : '');
  if (!version) throw new Error(`${VERSION_FILE} does not declare a VERSION`);
  const sorted = {};
  for (const k of Object.keys(files).sort()) sorted[k] = files[k];
  const doc = { files: sorted };
  if (notes !== undefined) doc.notes = String(notes).slice(0, MAX_NOTES);
  doc.version = version;
  const out = { version, files: sorted, notes: doc.notes };
  checkBundle(out); // a release must pass the same gate as an install
  return zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 });
}

function checkBundle({ version, files }) {
  const names = Object.keys(files);
  if (names.length > MAX_FILES) throw new Error(`Bundle has too many files (${names.length} > ${MAX_FILES})`);
  const seen = new Map(); // case-folded path -> 'file' | 'dir'
  for (const rel of names) {
    const segs = checkRelPath(rel);
    for (let i = 1; i <= segs.length; i++) {
      const key = segs.slice(0, i).join('/').normalize('NFC').toLowerCase();
      const kind = i === segs.length ? 'file' : 'dir';
      const prev = seen.get(key);
      if (prev && (prev === 'file' || kind === 'file')) throw new Error(`Bundle path ${JSON.stringify(rel)} collides with another entry`);
      seen.set(key, kind);
    }
  }
  for (const req of REQUIRED) if (!Object.hasOwn(files, req)) throw new Error(`Bundle is missing ${req}`);
  if (!Object.hasOwn(files, VERSION_FILE)) throw new Error(`Bundle is missing ${VERSION_FILE}`);
  const declared = versionFromSource(Buffer.isBuffer(files[VERSION_FILE]) ? files[VERSION_FILE].toString('utf8') : Buffer.from(files[VERSION_FILE], 'base64').toString('utf8'));
  if (declared !== version) throw new Error(`Bundle version ${version} does not match ${VERSION_FILE} (${declared})`);
}

/** Parses and validates a bundle. Returns { version, notes, files: { rel: Buffer } }. */
export function readBundle(buf) {
  let text;
  try {
    text = zlib.gunzipSync(buf, { maxOutputLength: MAX_JSON }).toString('utf8');
  } catch (e) {
    throw new Error(e && e.code === 'ERR_BUFFER_TOO_LARGE' ? 'Bundle is too large' : 'Bundle is not valid gzip');
  }
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('Bundle is not valid JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Bundle is not an object');
  for (const k of Object.keys(doc)) if (!['version', 'files', 'notes'].includes(k)) throw new Error(`Bundle has an unexpected field "${k}"`);
  if (!isSemver(doc.version)) throw new Error('Bundle version is not x.y.z');
  if (doc.notes !== undefined && (typeof doc.notes !== 'string' || doc.notes.length > MAX_NOTES)) throw new Error('Bundle notes are invalid');
  if (!doc.files || typeof doc.files !== 'object' || Array.isArray(doc.files)) throw new Error('Bundle files are not an object');
  const files = Object.create(null);
  let total = 0;
  const names = Object.keys(doc.files);
  if (names.length > MAX_FILES) throw new Error(`Bundle has too many files (${names.length} > ${MAX_FILES})`);
  for (const rel of names) {
    const v = doc.files[rel];
    if (typeof v !== 'string' || !BASE64.test(v)) throw new Error(`Bundle file ${JSON.stringify(rel)} is not base64`);
    const data = Buffer.from(v, 'base64');
    total += data.length;
    if (total > MAX_TOTAL) throw new Error('Bundle is too large');
    files[rel] = data;
  }
  checkBundle({ version: doc.version, files });
  return { version: doc.version, notes: doc.notes ?? null, files };
}

/** Ed25519 signature check over the exact bytes; any problem means false. */
export function verifySignature(buf, sigBase64, publicKeyPem) {
  try {
    if (!publicKeyPem || typeof sigBase64 !== 'string') return false;
    const key = crypto.createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const s = sigBase64.trim();
    if (!BASE64.test(s)) return false;
    const sig = Buffer.from(s, 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, buf, key, sig);
  } catch {
    return false;
  }
}
