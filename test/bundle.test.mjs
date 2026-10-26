import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { makeBundle, readBundle, verifySignature } from '../skills/urequartermaster/scripts/lib/update/bundle.mjs';
import { write, fakeSkill } from './helpers/skill-fixture.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qm-bundle-'));

const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
const b64 = (s) => Buffer.from(s).toString('base64');
const base = () => ({ 'SKILL.md': b64('x'), 'scripts/qm.mjs': b64('y'), 'scripts/lib/version.mjs': b64("export const VERSION = '1.0.0';\n") });

test('makeBundle/readBundle round trip, "/" paths, dotfiles and node_modules skipped', () => {
  const d = fakeSkill(tmp());
  write(path.join(d, '.git', 'config'), 'x');
  write(path.join(d, 'scripts', '.hidden'), 'x');
  write(path.join(d, 'node_modules', 'pkg', 'index.js'), 'x');
  write(path.join(d, '.DS_Store'), 'x');
  const buf = makeBundle(d);
  assert.ok(Buffer.isBuffer(buf));
  const b = readBundle(buf);
  assert.equal(b.version, '1.0.0');
  assert.deepEqual(Object.keys(b.files).sort(), [
    'SKILL.md', 'assets/bin.dat', 'references/notes with space é.md', 'scripts/lib/version.mjs', 'scripts/qm.mjs',
  ]);
  for (const [rel, data] of Object.entries(b.files)) {
    assert.ok(!rel.includes('\\'));
    assert.deepEqual(data, fs.readFileSync(path.join(d, ...rel.split('/'))));
  }
  // deterministic: same tree, same bytes
  assert.deepEqual(makeBundle(d), buf);
});

test('makeBundle refuses symlinks and unexpected top-level entries', () => {
  const d = fakeSkill(tmp());
  write(path.join(d, 'evil.txt'), 'x');
  assert.throws(() => makeBundle(d), /evil\.txt/);
  fs.rmSync(path.join(d, 'evil.txt'));
  try { fs.symlinkSync(path.join(d, 'SKILL.md'), path.join(d, 'scripts', 'link.md')); } catch { return; }
  assert.throws(() => makeBundle(d), /link/);
});

test('notes are carried inside the signed bundle', () => {
  const d = fakeSkill(tmp());
  const b = readBundle(makeBundle(d, { notes: 'Faster search.' }));
  assert.equal(b.notes, 'Faster search.');
});

test('readBundle rejects every unsafe or malformed layout', () => {
  const cases = {
    absolute: { '/etc/passwd': b64('x') },
    dotdot: { 'scripts/../../x': b64('x') },
    dotdotTop: { '../x': b64('x') },
    dot: { 'scripts/./x': b64('x') },
    backslash: { 'scripts\\x.mjs': b64('x') },
    drive: { 'C:/x': b64('x') },
    driveInTop: { 'scripts/C:x': b64('x') },
    nul: { 'scripts/a\0b': b64('x') },
    empty: { '': b64('x') },
    emptySegment: { 'scripts//a': b64('x') },
    trailingSlash: { 'scripts/a/': b64('x') },
    caseDup: { 'scripts/A.mjs': b64('x'), 'scripts/a.mjs': b64('y') },
    caseDupTop: { 'Scripts/qm.mjs': b64('x') },
    badTop: { 'evil/x': b64('x') },
    dotSegment: { 'scripts/.git/config': b64('x') },
    fileAsDir: { 'SKILL.md/x': b64('x') },
    fileDirConflict: { 'scripts/lib': b64('x') },
    trailingDot: { 'scripts/x.': b64('x') },
    reserved: { 'scripts/CON.txt': b64('x') },
    control: { 'scripts/a\u0007b': b64('x') },
    badBase64: { 'scripts/z.mjs': '@@@' },
    nonString: { 'scripts/z.mjs': 5 },
    bidiOverride: { 'references/a\u202egpj.md': b64('x') },
    zeroWidth: { 'references/a\u200bb.md': b64('x') },
    zeroWidthJoiner: { 'references/a\u200db.md': b64('x') },
    bom: { 'references/\ufeffa.md': b64('x') },
    c1Control: { 'references/a\u0085b.md': b64('x') },
    scriptsNonAscii: { 'scripts/caf\u00e9.mjs': b64('x') },
    scriptsSpace: { 'scripts/a b.mjs': b64('x') },
    scriptsHomoglyph: { 'scripts/q\u043c.mjs': b64('x') },
    scriptsNonAsciiDir: { 'scripts/l\u00edb/x.mjs': b64('x') },
  };
  for (const [name, extra] of Object.entries(cases)) {
    assert.throws(() => readBundle(gz({ version: '1.0.0', files: { ...base(), ...extra } })), Error, name);
  }
  const noSkill = base(); delete noSkill['SKILL.md'];
  assert.throws(() => readBundle(gz({ version: '1.0.0', files: noSkill })), /SKILL\.md/);
  const noQm = base(); delete noQm['scripts/qm.mjs'];
  assert.throws(() => readBundle(gz({ version: '1.0.0', files: noQm })), /qm\.mjs/);
  assert.throws(() => readBundle(gz({ version: '1.0.1', files: base() })), /version/); // version.mjs says 1.0.0
  for (const v of ['1.0', 'v1.0.0', '1.0.0-beta', 1, null, '01.0.0']) {
    assert.throws(() => readBundle(gz({ version: v, files: base() })), Error, String(v));
  }
  assert.throws(() => readBundle(gz({ version: '1.0.0', files: [] })));
  assert.throws(() => readBundle(gz({ version: '1.0.0', files: base(), extra: 1 })));
  assert.throws(() => readBundle(gz([1])));
  assert.throws(() => readBundle(Buffer.from('not gzip')));
  assert.throws(() => readBundle(zlib.gzipSync(Buffer.from('{not json'))));
  assert.doesNotThrow(() => readBundle(gz({ version: '1.0.0', files: base() })));
});

test('readBundle caps file count and uncompressed size', () => {
  const many = base();
  for (let i = 0; i < 2000; i++) many[`references/f${i}.md`] = b64('x');
  assert.throws(() => readBundle(gz({ version: '1.0.0', files: many })), /files/);
  const big = { ...base(), 'assets/big.bin': Buffer.alloc(21 * 1024 * 1024).toString('base64') };
  assert.throws(() => readBundle(gz({ version: '1.0.0', files: big })), /large|size|buffer/i);
});

test('verifySignature: valid, one byte flipped, other key, garbage', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const other = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const data = makeBundle(fakeSkill(tmp()));
  const sig = crypto.sign(null, data, privateKey).toString('base64');
  assert.equal(verifySignature(data, sig, pem), true);
  assert.equal(verifySignature(data, `${sig}\n`, pem), true);
  const flipped = Buffer.from(data); flipped[flipped.length >> 1] ^= 1;
  assert.equal(verifySignature(flipped, sig, pem), false);
  const sigBytes = Buffer.from(sig, 'base64'); sigBytes[0] ^= 1;
  assert.equal(verifySignature(data, sigBytes.toString('base64'), pem), false);
  assert.equal(verifySignature(data, sig, other.publicKey.export({ type: 'spki', format: 'pem' })), false);
  assert.equal(verifySignature(data, 'not base64!!', pem), false);
  assert.equal(verifySignature(data, '', pem), false);
  assert.equal(verifySignature(data, sig, null), false);
  assert.equal(verifySignature(data, sig, 'garbage'), false);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(verifySignature(data, sig, rsa), false);
});
