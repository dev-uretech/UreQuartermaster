import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readBundle, verifySignature } from '../skills/urequartermaster/scripts/lib/update/bundle.mjs';
import { VERSION } from '../skills/urequartermaster/scripts/lib/version.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** A throw-away copy of the parts of the repository the maintainer scripts use. */
function repoCopy({ changelog = `# Changelog\n\n## ${VERSION}\n\nFirst public release.\nMore text.\n\n## 0.0.1\n\nOld.\n`, pubkey = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-rel-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  for (const f of ['keygen.mjs', 'release.mjs', 'resign.mjs']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(repo, 'scripts', f));
  fs.cpSync(path.join(REPO, 'skills'), path.join(repo, 'skills'), { recursive: true });
  const skill = path.join(repo, 'skills', 'urequartermaster', 'SKILL.md');
  if (!fs.existsSync(skill)) fs.writeFileSync(skill, '---\nname: urequartermaster\ndescription: test\n---\n');
  if (changelog !== null) fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), changelog);
  // The release key, generated with keygen.mjs and trusted by the copy's pubkey.mjs (committed), as a maintainer would.
  const signing = path.join(root, 'signing');
  fs.mkdirSync(signing);
  const gen = spawnSync(process.execPath, [path.join(repo, 'scripts', 'keygen.mjs'), signing], { cwd: repo, encoding: 'utf8' });
  assert.equal(gen.status, 0, gen.stderr);
  const key = path.join(signing, 'urequartermaster-signing.key');
  const pubFile = path.join(repo, 'skills', 'urequartermaster', 'scripts', 'lib', 'pubkey.mjs');
  fs.writeFileSync(pubFile, `export const PUBLIC_KEY_PEM = ${pubkey ? JSON.stringify(gen.stdout) : 'null'};\n`);
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const keys = path.join(root, 'keys');
  fs.mkdirSync(keys);
  const node = (script, ...args) => spawnSync(process.execPath, [path.join(repo, 'scripts', script), ...args], { cwd: repo, encoding: 'utf8' });
  return { root, repo, keys, key, node };
}

test('keygen writes a 0600 private key, prints only the public key, never overwrites', () => {
  const c = repoCopy();
  const r = c.node('keygen.mjs', c.keys);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n?$/);
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE/);
  const keyFile = path.join(c.keys, 'urequartermaster-signing.key');
  const pem = fs.readFileSync(keyFile, 'utf8');
  assert.match(pem, /BEGIN PRIVATE KEY/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const pub = crypto.createPublicKey(crypto.createPrivateKey(pem)).export({ type: 'spki', format: 'pem' });
  assert.equal(r.stdout.trim(), pub.trim());

  const again = c.node('keygen.mjs', c.keys);
  assert.equal(again.status, 1);
  assert.equal(fs.readFileSync(keyFile, 'utf8'), pem);
  assert.doesNotMatch(again.stdout + again.stderr, /PRIVATE KEY-----/);
});

test('keygen refuses an output folder inside the repository', () => {
  const c = repoCopy();
  for (const dir of [c.repo, path.join(c.repo, 'scripts')]) {
    const r = c.node('keygen.mjs', dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /inside the repository/);
    assert.equal(fs.existsSync(path.join(dir, 'urequartermaster-signing.key')), false);
  }
  assert.equal(c.node('keygen.mjs').status, 2);
});

test('release builds, signs and verifies the bundle and prints the gh command without running it', () => {
  const c = repoCopy();
  const { key } = c;
  const pub = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(key))).export({ type: 'spki', format: 'pem' });
  const r = c.node('release.mjs', '--key', key, '--version', VERSION);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE/);
  const dist = path.join(c.repo, 'dist');
  const gzName = `urequartermaster-${VERSION}.bundle.gz`;
  assert.deepEqual(fs.readdirSync(dist).sort(), ['SHA256SUMS', gzName, `${gzName}.sig`]);
  const buf = fs.readFileSync(path.join(dist, gzName));
  const sig = fs.readFileSync(path.join(dist, `${gzName}.sig`), 'utf8');
  assert.equal(verifySignature(buf, sig, pub), true);
  const b = readBundle(buf);
  assert.equal(b.version, VERSION);
  assert.equal(b.notes, 'First public release.');
  const sums = fs.readFileSync(path.join(dist, 'SHA256SUMS'), 'utf8');
  assert.ok(sums.includes(`${crypto.createHash('sha256').update(buf).digest('hex')}  ${gzName}`));
  assert.match(r.stdout, new RegExp(`gh release create v${VERSION.replace(/\./g, '\\.')} `));
  assert.match(r.stdout, /--notes-file /);
  const notesFile = r.stdout.match(/--notes-file (\S+)/)[1].replace(/^"|"$/g, '');
  assert.match(fs.readFileSync(notesFile, 'utf8'), /First public release\.\nMore text\./);
});

test('release refuses a wrong version, a missing changelog or section, and a non-Ed25519 key', () => {
  const c = repoCopy();
  const { key } = c;
  const wrong = c.node('release.mjs', '--key', key, '--version', '9.9.9');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /version\.mjs/);

  const noSection = repoCopy({ changelog: '# Changelog\n\n## 0.0.1\n' });
  const r2 = noSection.node('release.mjs', '--key', noSection.key, '--version', VERSION);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /CHANGELOG\.md has no "## /);

  const noLog = repoCopy({ changelog: null });
  const r3 = noLog.node('release.mjs', '--key', noLog.key, '--version', VERSION);
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /CHANGELOG\.md not found/);

  const rsa = path.join(c.keys, 'rsa.key');
  fs.writeFileSync(rsa, crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const r4 = c.node('release.mjs', '--key', rsa, '--version', VERSION);
  assert.equal(r4.status, 1);
  assert.match(r4.stderr, /Ed25519/);
  assert.doesNotMatch(r4.stdout + r4.stderr, /PRIVATE/);
  assert.equal(fs.existsSync(path.join(c.repo, 'dist')), false);
});

test('release refuses when pubkey.mjs has no key, or a key other than the signing one', () => {
  const none = repoCopy({ pubkey: false });
  const r1 = none.node('release.mjs', '--key', none.key, '--version', VERSION);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /pubkey\.mjs has no public key/);
  assert.equal(fs.existsSync(path.join(none.repo, 'dist')), false);

  const c = repoCopy();
  assert.equal(c.node('keygen.mjs', c.keys).status, 0); // a second, untrusted key
  const r2 = c.node('release.mjs', '--key', path.join(c.keys, 'urequartermaster-signing.key'), '--version', VERSION);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /does not match the public key/);
  assert.doesNotMatch(r2.stdout + r2.stderr, /PRIVATE/);
  assert.equal(fs.existsSync(path.join(c.repo, 'dist')), false);
});

test('resign replaces the signature with one from another key (key rotation) and rewrites SHA256SUMS', () => {
  const c = repoCopy(); // pubkey.mjs holds the new key
  assert.equal(c.node('release.mjs', '--key', c.key, '--version', VERSION).status, 0);
  assert.equal(c.node('keygen.mjs', c.keys).status, 0);
  const oldKey = path.join(c.keys, 'urequartermaster-signing.key');
  const pubOf = (k) => crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(k))).export({ type: 'spki', format: 'pem' });
  const r = c.node('resign.mjs', '--key', oldKey, '--version', VERSION);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE/);
  const gzName = `urequartermaster-${VERSION}.bundle.gz`;
  const buf = fs.readFileSync(path.join(c.repo, 'dist', gzName));
  const sig = fs.readFileSync(path.join(c.repo, 'dist', `${gzName}.sig`), 'utf8');
  assert.equal(verifySignature(buf, sig, pubOf(oldKey)), true);
  assert.equal(verifySignature(buf, sig, pubOf(c.key)), false);
  const sums = fs.readFileSync(path.join(c.repo, 'dist', 'SHA256SUMS'), 'utf8');
  assert.ok(sums.includes(`${crypto.createHash('sha256').update(sig).digest('hex')}  ${gzName}.sig`));
  assert.equal(c.node('resign.mjs', '--key', oldKey, '--version', '9.9.9').status, 1);
  assert.equal(c.node('resign.mjs', '--key', oldKey).status, 2);
});

test('release refuses uncommitted changes in the skill unless --allow-dirty', () => {
  const c = repoCopy();
  const { key } = c;
  const skill = path.join(c.repo, 'skills', 'urequartermaster');
  fs.appendFileSync(path.join(skill, 'SKILL.md'), '\nlocal edit\n');
  const r = c.node('release.mjs', '--key', key, '--version', VERSION);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /uncommitted changes/);
  assert.equal(fs.existsSync(path.join(c.repo, 'dist')), false);
  git(c.repo, 'checkout', '--', '.');
  fs.writeFileSync(path.join(skill, 'references-untracked.md'), 'x');
  assert.match(c.node('release.mjs', '--key', key, '--version', VERSION).stderr, /uncommitted changes/);
  fs.rmSync(path.join(skill, 'references-untracked.md'));
  fs.writeFileSync(path.join(c.repo, 'outside-skill.txt'), 'x'); // changes elsewhere do not matter
  assert.equal(c.node('release.mjs', '--key', key, '--version', VERSION).status, 0);
  fs.appendFileSync(path.join(skill, 'SKILL.md'), '\nlocal edit\n');
  const forced = c.node('release.mjs', '--key', key, '--version', VERSION, '--allow-dirty');
  assert.equal(forced.status, 0, forced.stderr);
  fs.rmSync(path.join(c.repo, '.git'), { recursive: true, force: true });
  assert.match(c.node('release.mjs', '--key', key, '--version', VERSION).stderr, /not a git repository/);
});
