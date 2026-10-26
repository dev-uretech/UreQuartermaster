#!/usr/bin/env node
// Maintainer tool for key rotation: re-signs an already built release with another key. Not shipped with the skill.
//   node scripts/resign.mjs --key <path-to-old-signing-key> --version X.Y.Z
// The rotation release carries the NEW public key in pubkey.mjs but must be signed with the OLD key, which the
// installed copies still trust; release.mjs refuses that combination, so it builds with the new key and this
// script replaces dist/<bundle>.sig and dist/SHA256SUMS. The private key is only read into memory, never printed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const USAGE = 'usage: node scripts/resign.mjs --key <path> --version X.Y.Z';

function die(msg, code = 1) {
  process.stderr.write(`resign: ${msg}\n`);
  process.exit(code);
}

const o = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--key' && argv[i + 1] !== undefined) o.key = argv[++i];
  else if (argv[i] === '--version' && argv[i + 1] !== undefined) o.version = argv[++i];
  else die(`unexpected argument ${JSON.stringify(argv[i])}\n${USAGE}`, 2);
}
if (!o.key || !o.version) die(USAGE, 2);
if (!/^\d+\.\d+\.\d+$/.test(o.version)) die(`--version must be X.Y.Z, got ${JSON.stringify(o.version)}`);

const dist = path.join(REPO, 'dist');
const gzName = `urequartermaster-${o.version}.bundle.gz`;
let bundle;
try { bundle = fs.readFileSync(path.join(dist, gzName)); } catch { die(`dist/${gzName} not found: run release.mjs first`); }

let privateKey;
try { privateKey = crypto.createPrivateKey(fs.readFileSync(o.key)); } catch (e) {
  die(`cannot read the signing key at ${o.key} (${e.code || 'invalid key'})`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') die('the signing key is not an Ed25519 private key');

const sig = `${crypto.sign(null, bundle, privateKey).toString('base64')}\n`;
if (!crypto.verify(null, bundle, crypto.createPublicKey(privateKey), Buffer.from(sig.trim(), 'base64'))) {
  die('the new signature does not verify');
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
fs.writeFileSync(path.join(dist, `${gzName}.sig`), sig);
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sha(bundle)}  ${gzName}\n${sha(Buffer.from(sig))}  ${gzName}.sig\n`);
process.stdout.write(`Re-signed dist/${gzName} with the given key and rewrote dist/SHA256SUMS.\n`);
