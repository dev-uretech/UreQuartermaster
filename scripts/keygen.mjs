#!/usr/bin/env node
// Maintainer tool: creates the Ed25519 release signing key. Not shipped with the skill.
//   node scripts/keygen.mjs <folder-outside-the-repository>
// Writes <folder>/urequartermaster-signing.key (PKCS#8 PEM, mode 0600, never overwritten)
// and prints only the public key PEM, to be pasted into skills/urequartermaster/scripts/lib/pubkey.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const KEY_NAME = 'urequartermaster-signing.key';

function die(msg, code = 1) {
  process.stderr.write(`keygen: ${msg}\n`);
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith('-')) die('usage: node scripts/keygen.mjs <folder outside the repository>', 2);

let outDir;
try { outDir = fs.realpathSync.native(path.resolve(args[0])); } catch { die(`folder not found: ${args[0]} (create it first)`); }
if (!fs.statSync(outDir).isDirectory()) die(`not a folder: ${args[0]}`);
const repo = fs.realpathSync.native(REPO);
const rel = path.relative(repo.toLowerCase(), outDir.toLowerCase());
if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
  die('refusing to write the private key inside the repository; choose a folder outside it');
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const file = path.join(outDir, KEY_NAME);
try {
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
} catch (e) {
  die(e.code === 'EEXIST' ? `${file} already exists; it is never overwritten` : `cannot write ${file}: ${e.code || e.message}`);
}
process.stdout.write(publicKey.export({ type: 'spki', format: 'pem' }));
