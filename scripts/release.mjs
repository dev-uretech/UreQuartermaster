#!/usr/bin/env node
// Maintainer tool: builds and signs a release. Not shipped with the skill.
//   node scripts/release.mjs --key <path-to-signing-key> --version X.Y.Z [--allow-dirty]
// Refuses when skills/urequartermaster has uncommitted changes, unless --allow-dirty, and
// unless scripts/lib/pubkey.mjs holds the public key of --key (a null key is refused too).
// Checks that version.mjs and CHANGELOG.md agree with X.Y.Z, builds the bundle from
// skills/urequartermaster, signs it, verifies the signature with the derived public key,
// writes dist/, then prints (does not run) the `gh release create` command.
// The private key is only ever read into memory: never printed, logged or copied.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeBundle, readBundle, verifySignature, versionFromSource, isSemver } from '../skills/urequartermaster/scripts/lib/update/bundle.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKILL = path.join(REPO, 'skills', 'urequartermaster');

function die(msg, code = 1) {
  process.stderr.write(`release: ${msg}\n`);
  process.exit(code);
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--key' || a === '--version') && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else if (a === '--allow-dirty') o.allowDirty = true;
    else die(`unexpected argument ${JSON.stringify(a)}\nusage: node scripts/release.mjs --key <path> --version X.Y.Z [--allow-dirty]`, 2);
  }
  if (!o.key || !o.version) die('usage: node scripts/release.mjs --key <path> --version X.Y.Z', 2);
  return o;
}

// What gets signed must be what is committed: no stray local edits in a release.
function checkCommitted() {
  const r = spawnSync('git', ['status', '--porcelain', '--', 'skills/urequartermaster'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) die('cannot check that skills/urequartermaster is committed (not a git repository, or git is not on PATH); pass --allow-dirty to skip this check');
  if (r.stdout.trim()) die('skills/urequartermaster has uncommitted changes; commit them first or pass --allow-dirty');
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function changelogSection(version) {
  const file = path.join(REPO, 'CHANGELOG.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch {
    die(`CHANGELOG.md not found in ${REPO}: create it with a "## ${version}" section first`);
  }
  const lines = text.split(/\r?\n/);
  const head = new RegExp(`^##\\s+\\[?${esc(version)}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) die(`CHANGELOG.md has no "## ${version}" section`);
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) die(`the "## ${version}" section of CHANGELOG.md is empty`);
  return body;
}

const { key: keyPath, version, allowDirty } = parse(process.argv.slice(2));
if (!isSemver(version)) die(`--version must be X.Y.Z, got ${JSON.stringify(version)}`);
if (!allowDirty) checkCommitted();

const declared = versionFromSource(fs.readFileSync(path.join(SKILL, 'scripts', 'lib', 'version.mjs'), 'utf8'));
if (declared !== version) die(`scripts/lib/version.mjs declares ${declared}, not ${version}`);
const notes = changelogSection(version);

let privateKey;
try { privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath)); } catch (e) {
  die(`cannot read the signing key at ${keyPath} (${e.code || 'invalid key'})`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') die('the signing key is not an Ed25519 private key');
const publicPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });

const { PUBLIC_KEY_PEM } = await import(pathToFileURL(path.join(SKILL, 'scripts', 'lib', 'pubkey.mjs')).href);
const norm = (p) => String(p).replace(/\r\n/g, '\n').trim();
// A release whose code trusts no key (or another key) could never be updated by the copies that install it.
if (!PUBLIC_KEY_PEM) die('scripts/lib/pubkey.mjs has no public key: set PUBLIC_KEY_PEM to the key printed by keygen.mjs and commit it before releasing');
if (norm(PUBLIC_KEY_PEM) !== norm(publicPem)) die('this key does not match the public key in scripts/lib/pubkey.mjs');

const firstLine = notes.split('\n').find((l) => l.trim()).trim();
const bundle = makeBundle(SKILL, { notes: firstLine });
if (readBundle(bundle).version !== version) die('the bundle does not carry the requested version');
const sig = crypto.sign(null, bundle, privateKey).toString('base64');
if (!verifySignature(bundle, sig, publicPem)) die('the signature does not verify with the derived public key');

const dist = path.join(REPO, 'dist');
fs.mkdirSync(dist, { recursive: true });
const gzName = `urequartermaster-${version}.bundle.gz`;
const sigName = `${gzName}.sig`;
fs.writeFileSync(path.join(dist, gzName), bundle);
fs.writeFileSync(path.join(dist, sigName), `${sig}\n`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sha(bundle)}  ${gzName}\n${sha(Buffer.from(`${sig}\n`))}  ${sigName}\n`);

const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urequartermaster-notes-'));
const notesFile = path.join(notesDir, `v${version}.md`);
fs.writeFileSync(notesFile, `${notes}\n`);
const q = (s) => (/\s/.test(s) ? `"${s}"` : s);

process.stdout.write(`Built and verified ${path.join('dist', gzName)} (${bundle.length} bytes, sha256 ${sha(bundle)}).\n`);
process.stdout.write('Publish with:\n');
process.stdout.write(`  gh release create v${version} dist/${gzName} dist/${sigName} dist/SHA256SUMS --title v${version} --notes-file ${q(notesFile)}\n`);
