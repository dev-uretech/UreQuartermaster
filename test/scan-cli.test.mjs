import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCli, CURATED_CLIS } from '../skills/urequartermaster/scripts/lib/scan/cli-tools.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qm-cli-'));
function exe(dir, name, mode = 0o755) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, '#!/bin/sh\n');
  fs.chmodSync(f, mode);
  return f;
}
const cfg = (clis = []) => ({ clis, mcpDescriptions: {} });

test('curated list covers the common tools', () => {
  const names = CURATED_CLIS.map((c) => c.name);
  for (const n of ['gh', 'git', 'gcloud', 'bq', 'gsutil', 'aws', 'az', 'kubectl', 'helm', 'terraform', 'docker', 'podman', 'wp', 'composer', 'php',
    'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'uv', 'pipx', 'ffmpeg', 'imagemagick', 'pandoc', 'sqlite3', 'psql', 'mysql', 'redis-cli',
    'stripe', 'vercel', 'netlify', 'firebase', 'supabase', 'flyctl', 'railway', 'heroku', 'wrangler', 'rclone', 'jq', 'yq', 'rg', 'curl']) {
    assert.ok(names.includes(n), n);
  }
  for (const c of CURATED_CLIS) assert.ok(c.description && !c.description.includes('\n'), c.name);
});

test('POSIX: finds executables on a fake PATH, ignores non-executable files and empty entries', { skip: process.platform === 'win32' }, () => {
  const root = tmp();
  const a = path.join(root, 'bin a');
  const b = path.join(root, 'bin-b');
  const gh = exe(a, 'gh');
  exe(a, 'gcloud', 0o644); // not executable here
  const gcloud = exe(b, 'gcloud');
  const magick = exe(b, 'magick');
  exe(b, 'mytool');
  fs.mkdirSync(path.join(b, 'jq')); // a folder is not a command
  const env = { PATH: ['', a, path.join(root, 'missing'), b].join(':') };
  const out = scanCli(cfg([{ name: 'mytool', description: 'My tool' }, { name: 'absent', description: 'x' }, { name: '../evil', description: 'x' }]), env, { platform: 'linux' });
  const by = Object.fromEntries(out.map((e) => [e.id, e]));
  assert.deepEqual(Object.keys(by).sort(), ['cli:gcloud', 'cli:gh', 'cli:imagemagick', 'cli:mytool']);
  assert.deepEqual(by['cli:gh'], {
    id: 'cli:gh', kind: 'cli', name: 'gh', description: CURATED_CLIS.find((c) => c.name === 'gh').description,
    headings: [], path: gh, source: 'path', state: 'available', usage: 'gh --help',
  });
  assert.equal(by['cli:gcloud'].path, gcloud);
  assert.deepEqual([by['cli:imagemagick'].path, by['cli:imagemagick'].usage], [magick, 'magick --help']);
  assert.deepEqual([by['cli:mytool'].description, by['cli:mytool'].source, by['cli:mytool'].usage], ['My tool', 'config', 'mytool --help']);
});

test('POSIX: imagemagick falls back to convert outside Windows', { skip: process.platform === 'win32' }, () => {
  const b = tmp();
  exe(b, 'convert');
  assert.deepEqual(scanCli(cfg(), { PATH: b }, { platform: 'darwin' }).map((e) => [e.id, e.usage]), [['cli:imagemagick', 'convert --help']]);
});

test('Windows: PATHEXT, case-insensitive Path key, quoted entries, no convert', () => {
  const root = tmp();
  const a = path.join(root, 'Program Files', 'GitHub CLI');
  const b = path.join(root, 'npm');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'gh.exe'), '');
  fs.writeFileSync(path.join(b, 'gcloud.cmd'), '');
  fs.writeFileSync(path.join(b, 'vercel.ps1'), '');
  fs.writeFileSync(path.join(b, 'convert.exe'), ''); // Windows' own convert.exe is a disk tool
  fs.writeFileSync(path.join(b, 'jq'), ''); // no extension: not runnable on Windows
  const env = { Path: `"${a}";;${b}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const out = scanCli(cfg([{ name: 'mytool', description: '' }]), env, { platform: 'win32' });
  assert.deepEqual(out.map((e) => e.id).sort(), ['cli:gcloud', 'cli:gh']);
  assert.equal(out.find((e) => e.id === 'cli:gh').path, path.join(a, 'gh.exe'));
  assert.equal(out.find((e) => e.id === 'cli:gcloud').usage, 'gcloud --help');
  const withPs1 = scanCli(cfg(), { Path: b, PATHEXT: '.EXE;.CMD;.PS1' }, { platform: 'win32' });
  assert.deepEqual(withPs1.map((e) => e.id).sort(), ['cli:gcloud', 'cli:vercel']);
});

test('no PATH -> empty, never throws on odd config', () => {
  assert.deepEqual(scanCli(cfg(), {}, { platform: 'linux' }), []);
  assert.deepEqual(scanCli({ clis: 'oops' }, { PATH: '' }, { platform: 'linux' }), []);
  assert.deepEqual(scanCli(undefined, {}, { platform: 'linux' }), []);
});
