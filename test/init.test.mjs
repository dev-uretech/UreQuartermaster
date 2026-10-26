import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initAgents, isInside, START, END } from '../skills/urequartermaster/scripts/lib/agent/init.mjs';

const QM = fileURLToPath(new URL('../skills/urequartermaster/scripts/qm.mjs', import.meta.url));
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-init-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  fs.mkdirSync(home, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, UREQM_HOME: data, PATH: path.join(root, 'nobin'), UREQM_NO_UPDATE: '1' };
  return { root, home, env, opts: { home, env, cwd: root, platform: process.platform }, claude: path.join(home, '.claude', 'CLAUDE.md'), codex: path.join(home, '.codex', 'AGENTS.md') };
}
const rd = (f) => fs.readFileSync(f);
const canSymlink = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-sl-'));
  try { fs.symlinkSync(d, path.join(d, 'l')); return true; } catch { return false; }
})();

test('adds a 3-line block to an existing file, leaves the rest untouched', () => {
  const s = setup();
  write(s.claude, '# My rules\n\nBe nice.\n');
  const r = initAgents(s.opts);
  const me = r.find((x) => x.file === s.claude);
  assert.equal(me.changed, true);
  const t = rd(s.claude).toString('utf8');
  assert.ok(t.startsWith('# My rules\n\nBe nice.\n'));
  const m = t.match(new RegExp(`${START}\\n([\\s\\S]*)\\n${END}\\n$`));
  assert.ok(m, t);
  assert.equal(m[1].split('\n').length, 3);
  assert.match(m[1], /urequartermaster skill \(qm search\)/);
});

test('rerun does not duplicate or rewrite', () => {
  const s = setup();
  write(s.claude, 'x\n');
  initAgents(s.opts);
  const once = rd(s.claude);
  const r = initAgents(s.opts).find((x) => x.file === s.claude);
  assert.equal(r.changed, false);
  assert.deepEqual(rd(s.claude), once);
  assert.equal(once.toString().split(START).length, 2);
});

test('a block with different content is replaced in place', () => {
  const s = setup();
  write(s.claude, `before\n\n${START}\nold line\n${END}\nafter\n`);
  const r = initAgents(s.opts).find((x) => x.file === s.claude);
  assert.equal(r.changed, true);
  const t = rd(s.claude).toString();
  assert.ok(t.startsWith('before\n\n') && t.endsWith('\nafter\n'));
  assert.ok(!t.includes('old line'));
  assert.equal(t.split(START).length, 2);
});

test('--remove restores the original byte for byte (LF, CRLF, BOM, no final newline cases)', () => {
  for (const orig of ['# a\n\nb\n', '# a\r\n\r\nb\r\n', '﻿# a\nb\n', '﻿# é\r\nb\r\n', '']) {
    const s = setup();
    write(s.claude, orig);
    initAgents(s.opts);
    const withBlock = rd(s.claude).toString();
    if (orig.includes('\r\n')) assert.ok(!/(^|[^\r])\n/.test(withBlock), 'block uses the file EOL');
    assert.ok(withBlock.includes(START));
    const r = initAgents({ ...s.opts, remove: true }).find((x) => x.file === s.claude);
    assert.equal(r.changed, true);
    assert.deepEqual(rd(s.claude), Buffer.from(orig, 'utf8'), JSON.stringify(orig));
  }
});

test('round trip is exact without a final newline, with mixed EOLs and with bare CR', () => {
  for (const orig of ['A', 'a\r\nB', 'a\nb\r\nc\n', 'a\rb\r', 'a\rb', 'a\nb\r\nc']) {
    const s = setup();
    write(s.claude, orig);
    initAgents(s.opts);
    const t = rd(s.claude).toString();
    assert.ok(t.startsWith(orig) && t.includes(START), JSON.stringify(t));
    const eol = (orig.match(/\r\n|\n|\r/g) || ['\n']).pop();
    assert.ok(t.endsWith(END + eol), `block uses the last EOL of ${JSON.stringify(orig)}`);
    initAgents({ ...s.opts, remove: true });
    assert.deepEqual(rd(s.claude), Buffer.from(orig), JSON.stringify(orig));
  }
});

test('marker text in the user content is not our block', () => {
  const fenced = `# Docs\n\n\`\`\`md\n${START}\nexample\n${END}\n\`\`\`\n`;
  const s = setup();
  write(s.claude, fenced);
  initAgents({ ...s.opts, remove: true });
  assert.equal(rd(s.claude).toString(), fenced, 'remove leaves the fenced example alone');
  initAgents(s.opts);
  const t = rd(s.claude).toString();
  assert.ok(t.startsWith(fenced));
  assert.ok(t.slice(fenced.length).includes(START), 'block appended after the fence');
  assert.equal(t.split(START).length, 3);
  initAgents(s.opts);
  assert.equal(rd(s.claude).toString(), t, 'rerun is a no-op');
  initAgents({ ...s.opts, remove: true });
  assert.equal(rd(s.claude).toString(), fenced);

  const s2 = setup();
  const inline = `Use ${START} and ${END} to delimit things.\nNote: "${START}" is a marker.\n`;
  write(s2.claude, inline);
  initAgents(s2.opts);
  const t2 = rd(s2.claude).toString();
  assert.ok(t2.startsWith(inline) && t2.endsWith(`${END}\n`));
  initAgents({ ...s2.opts, remove: true });
  assert.equal(rd(s2.claude).toString(), inline);

  const s3 = setup(); // tilde fence is ignored; a real block at column 0 (trailing spaces allowed) is ours
  write(s3.claude, `~~~\n${START}\n~~~\n${START}  \nold\n${END}  \n`);
  const r3 = initAgents(s3.opts).find((x) => x.file === s3.claude);
  assert.equal(r3.action, 'updated');
  assert.ok(!rd(s3.claude).toString().includes('old'));
});

test('indented markers (indented code block) are not ours', () => {
  const s = setup();
  const orig = `text\n\n    ${START}\n    ex\n    ${END}\n`;
  write(s.claude, orig);
  initAgents({ ...s.opts, remove: true });
  assert.equal(rd(s.claude).toString(), orig);
  const r = initAgents(s.opts).find((x) => x.file === s.claude);
  assert.equal(r.action, 'added');
  const t = rd(s.claude).toString();
  assert.ok(t.startsWith(orig) && t.endsWith(`${END}\n`) && t.split(START).length === 3);
  initAgents({ ...s.opts, remove: true });
  assert.equal(rd(s.claude).toString(), orig);
});

test('an unclosed fence at the end: init and remove skip the file, bytes unchanged', () => {
  const s = setup();
  const orig = '# notes\n```js\nconst a=1;\n';
  write(s.claude, orig);
  for (const remove of [false, false, true]) {
    const r = initAgents({ ...s.opts, remove }).find((x) => x.file === s.claude);
    assert.equal(r.changed, false);
    assert.match(r.warning, /unclosed code fence at the end of .*CLAUDE\.md; close it and run again/);
    assert.equal(rd(s.claude).toString(), orig);
  }
});

test('BOM-only file and BOM file with the block at the top round trip', () => {
  for (const orig of ['\ufeff', `\ufeff${START}\nold\n${END}\n`]) {
    const s = setup();
    write(s.claude, orig);
    initAgents(s.opts);
    const once = rd(s.claude);
    assert.ok(once.toString().startsWith('\ufeff'));
    assert.equal(once.toString().split(START).length, 2);
    assert.ok(!once.toString().includes('old'));
    const again = initAgents(s.opts).find((x) => x.file === s.claude);
    assert.equal(again.changed, false);
    assert.deepEqual(rd(s.claude), once);
    const rm = initAgents({ ...s.opts, remove: true }).find((x) => x.file === s.claude);
    assert.equal(rm.changed, true);
    assert.equal(rd(s.claude).toString(), '\ufeff');
  }
});

test('action labels: added for a new block, updated only when our block is replaced', () => {
  const s = setup();
  write(s.claude, 'x\n');
  const act = () => initAgents(s.opts).find((x) => x.file === s.claude);
  assert.equal(act().action, 'added');
  assert.equal(act().action, 'unchanged');
  write(s.claude, rd(s.claude).toString().replace('Ask the user only', 'Ask the user rarely'));
  assert.equal(act().action, 'updated');
});

test('odd marker arrangements skip the file untouched', () => {
  for (const body of [`${START}\na\n${END}\n${START}\nb\n${END}\n`, `${END}\n${START}\n`, `${START}\nx\n`]) {
    const s = setup();
    write(s.claude, body);
    for (const remove of [false, true]) {
      const r = initAgents({ ...s.opts, remove }).find((x) => x.file === s.claude);
      assert.equal(r.changed, false);
      assert.ok(r.warning);
      assert.equal(rd(s.claude).toString(), body);
    }
  }
});

test('read-only file is skipped with a warning', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions and a non-root user' }, () => {
  const s = setup();
  write(s.claude, 'x\n');
  fs.chmodSync(s.claude, 0o444);
  const r = initAgents(s.opts).find((x) => x.file === s.claude);
  assert.equal(r.changed, false);
  assert.match(r.warning, /read-only/);
  assert.equal(rd(s.claude).toString(), 'x\n');
});

test('hard-linked file is skipped with a warning', () => {
  const s = setup();
  write(s.claude, 'x\n');
  const twin = path.join(s.home, 'twin.md');
  try { fs.linkSync(s.claude, twin); } catch { return; }
  const r = initAgents(s.opts).find((x) => x.file === s.claude);
  assert.equal(r.changed, false);
  assert.match(r.warning, /hard link/);
  assert.equal(rd(twin).toString(), 'x\n');
});

test('isInside: a folder named ..dotfiles is inside, .. is not', () => {
  const h = path.join(path.sep, 'h', 'me');
  assert.equal(isInside(h, path.join(h, '..dotfiles', 'x.md')), true);
  assert.equal(isInside(h, path.join(h, 'a', 'b')), true);
  assert.equal(isInside(h, path.join(h, '..')), false);
  assert.equal(isInside(h, path.join(h, '..', 'other', 'x')), false);
});

test('qm init: warnings go to stderr; exit 1 only when every found file was skipped', () => {
  const s = setup();
  write(s.claude, `${START}\nhalf\n`);
  const run = (...a) => spawnSync(process.execPath, [QM, 'init', ...a], { env: s.env, encoding: 'utf8' });
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Skipped .*CLAUDE\.md/);
  assert.ok(!r.stdout.includes('Skipped'));
  write(s.codex, 'ok\n');
  const r2 = run();
  assert.equal(r2.status, 0);
  assert.match(r2.stderr, /Skipped/);
  assert.equal(run('--agent', 'claude').status, 1);
});

test('--remove with text after the block removes just the block', () => {
  const s = setup();
  write(s.claude, `a\n${START}\nx\ny\nz\n${END}\nb\n`);
  initAgents({ ...s.opts, remove: true });
  assert.equal(rd(s.claude).toString(), 'a\nb\n');
});

test('--remove without a block changes nothing and never creates files', () => {
  const s = setup();
  write(s.claude, 'hello\n');
  const r = initAgents({ ...s.opts, remove: true });
  assert.ok(r.every((x) => !x.changed));
  assert.equal(rd(s.claude).toString(), 'hello\n');
  assert.ok(!fs.existsSync(s.codex));
});

test('creates a missing file only for claude and codex, and only when the parent dir exists', () => {
  const s = setup();
  fs.mkdirSync(path.join(s.home, '.codex'));
  fs.mkdirSync(path.join(s.home, '.gemini'));
  fs.mkdirSync(path.join(s.home, '.copilot'));
  const r = initAgents(s.opts);
  assert.ok(!fs.existsSync(path.join(s.home, '.gemini', 'GEMINI.md')));
  assert.ok(!fs.existsSync(path.join(s.home, '.copilot', 'copilot-instructions.md')));
  write(path.join(s.home, '.gemini', 'GEMINI.md'), 'g\n');
  assert.equal(initAgents(s.opts).find((x) => x.agent === 'gemini').changed, true, 'existing files of other agents are edited');
  assert.ok(fs.existsSync(s.codex));
  assert.equal(rd(s.codex).toString().startsWith(START), true);
  assert.ok(!fs.existsSync(path.join(s.home, '.claude')), 'parent dirs are never created');
  assert.equal(r.find((x) => x.file === s.claude).changed, false);
});

test('--dry-run writes nothing', () => {
  const s = setup();
  write(s.claude, 'x\n');
  const r = initAgents({ ...s.opts, dryRun: true }).find((x) => x.file === s.claude);
  assert.equal(r.changed, true);
  assert.equal(rd(s.claude).toString(), 'x\n');
});

test('agents filter limits the files touched', () => {
  const s = setup();
  write(s.claude, 'x\n');
  write(s.codex, 'y\n');
  initAgents({ ...s.opts, agents: ['codex'] });
  assert.equal(rd(s.claude).toString(), 'x\n');
  assert.ok(rd(s.codex).toString().includes(START));
});

test('a malformed block (start without end) is skipped with a warning', () => {
  const s = setup();
  write(s.claude, `a\n${START}\nhalf\n`);
  const r = initAgents(s.opts).find((x) => x.file === s.claude);
  assert.equal(r.changed, false);
  assert.ok(r.warning);
  assert.equal(rd(s.claude).toString(), `a\n${START}\nhalf\n`);
});

test('UTF-16 files are skipped with a warning', () => {
  const s = setup();
  fs.mkdirSync(path.dirname(s.claude), { recursive: true });
  fs.writeFileSync(s.claude, Buffer.from('﻿hello\n', 'utf16le'));
  const before = rd(s.claude);
  const r = initAgents(s.opts).find((x) => x.file === s.claude);
  assert.equal(r.changed, false);
  assert.ok(r.warning);
  assert.deepEqual(rd(s.claude), before);
});

test('symlinked file: written through when the target is inside home, skipped otherwise', { skip: !canSymlink && 'no symlinks' }, () => {
  const s = setup();
  const inside = path.join(s.home, 'dotfiles', 'claude.md');
  write(inside, 'mine\n');
  fs.mkdirSync(path.dirname(s.claude), { recursive: true });
  fs.symlinkSync(inside, s.claude);
  initAgents(s.opts);
  assert.ok(fs.lstatSync(s.claude).isSymbolicLink(), 'link is kept');
  assert.ok(rd(inside).toString().includes(START));

  const s2 = setup();
  const outside = path.join(s2.root, 'elsewhere', 'claude.md');
  write(outside, 'theirs\n');
  fs.mkdirSync(path.dirname(s2.claude), { recursive: true });
  fs.symlinkSync(outside, s2.claude);
  const r = initAgents(s2.opts).find((x) => x.file === s2.claude);
  assert.equal(r.changed, false);
  assert.ok(r.warning);
  assert.equal(rd(outside).toString(), 'theirs\n');
});

test('no temp files are left behind', () => {
  const s = setup();
  write(s.claude, 'x\n');
  initAgents(s.opts);
  assert.deepEqual(fs.readdirSync(path.dirname(s.claude)), ['CLAUDE.md']);
});

test('qm init, --dry-run and --remove through the CLI', () => {
  const s = setup();
  write(s.claude, 'x\n');
  const run = (...a) => spawnSync(process.execPath, [QM, 'init', ...a], { env: s.env, encoding: 'utf8' });
  const d = run('--dry-run');
  assert.equal(d.status, 0);
  assert.match(d.stdout, /would/i);
  assert.equal(rd(s.claude).toString(), 'x\n');
  const r = run();
  assert.equal(r.status, 0);
  assert.ok(rd(s.claude).toString().includes(START));
  assert.equal(run('--remove').status, 0);
  assert.equal(rd(s.claude).toString(), 'x\n');
  assert.equal(run('--bogus').status, 2);
});
