import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile } from '../skills/urequartermaster/scripts/lib/scan/frontmatter.mjs';
import { VERSION } from '../skills/urequartermaster/scripts/lib/version.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SKILL = path.join(REPO, 'skills', 'urequartermaster', 'SKILL.md');
const QM = path.join(REPO, 'skills', 'urequartermaster', 'scripts', 'qm.mjs');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

function qm(...args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-skillmd-'));
  const env = { HOME: home, USERPROFILE: home, UREQM_HOME: path.join(home, 'data'), UREQM_NO_UPDATE: '1', PATH: path.join(home, 'nobin') };
  const r = spawnSync(process.execPath, [QM, ...args], { env, cwd: home, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** The raw frontmatter as { key: single-line value }; fails on anything a strict host might reject. */
function frontmatter(text) {
  assert.ok(!text.startsWith('﻿'), 'no BOM');
  assert.ok(!text.includes('\r'), 'LF line endings');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'frontmatter fenced by --- lines');
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):[ \t]+(.+)$/);
    assert.ok(kv, `single-line "key: value" frontmatter, got ${JSON.stringify(line)}`);
    let v = kv[2].trim();
    assert.ok(!/^[>|]/.test(v), 'no block scalars');
    if (/^".*"$/.test(v)) v = JSON.parse(v);
    out[kv[1]] = v;
  }
  return { fm: out, body: text.slice(m[0].length) };
}

/** Subcommands named in `qm help`. */
function helpCommands() {
  const cmds = new Set();
  for (const m of qm('help').matchAll(/^\s+qm (\S+)/gm)) cmds.add(m[1]);
  return cmds;
}

/** Subcommands cited in a text as `qm <cmd>` or `.../qm.mjs" <cmd>`. */
function citedCommands(text) {
  const cmds = new Set();
  for (const m of text.matchAll(/\bqm(?:\.mjs"?)? +(--?[a-z][a-z-]*|[a-z][a-z-]*)/g)) cmds.add(m[1]);
  return cmds;
}

test('SKILL.md frontmatter: name, and a description that survives truncation', () => {
  const { fm } = frontmatter(fs.readFileSync(SKILL, 'utf8'));
  assert.equal(fm.name, 'urequartermaster');
  assert.equal(typeof fm.description, 'string');
  assert.ok(fm.description.length <= 1024, `description is ${fm.description.length} chars`);
  assert.ok(fm.description.startsWith('Use FIRST for any non-trivial request:'));
  // The indexer reads it the same way.
  const parsed = parseSkillFile(fs.readFileSync(SKILL, 'utf8'), 'urequartermaster');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.name, 'urequartermaster');
  assert.equal(parsed.description, fm.description);
});

test('SKILL.md saved with CRLF (and a BOM) by a Windows editor is read exactly like the LF original', () => {
  const lf = fs.readFileSync(SKILL, 'utf8');
  const parsed = parseSkillFile(lf, 'urequartermaster');
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.ok(crlf.includes('\r\n'));
  assert.deepEqual(parseSkillFile(crlf, 'urequartermaster'), parsed);
  assert.deepEqual(parseSkillFile(`\uFEFF${crlf}`, 'urequartermaster'), parsed);
  assert.ok(parsed.headings.length > 0);
});

test('SKILL.md body: required sections, short', () => {
  const { body } = frontmatter(fs.readFileSync(SKILL, 'utf8'));
  for (const h of ['## When to use', '## Procedure', '## Loading what you found', '## Without Node.js', '## Safety']) {
    assert.match(body, new RegExp(`^${h}\\s*$`, 'm'), `missing section ${h}`);
  }
  assert.ok(body.split('\n').length < 250, 'body under 250 lines');
  assert.match(body, /scripts\/qm\.mjs" search/, 'shows how to run the search');
  assert.match(body, /`→ (Using|Uso|Usando): [^`]+`/, 'shows the one-line "Using" declaration');
  // Every example parses with the rule the acceptance scorer uses.
  const examples = [...body.matchAll(/`(→ [^`]+)`/g)].map((m) => m[1]);
  assert.ok(examples.length >= 3);
  for (const ex of examples) {
    const m = ex.match(/^\s*(→|->)\s*[^:]+:\s*(.+)$/);
    assert.ok(m, ex);
    const names = m[2].split(' + ').map((n) => n.replace(/^(MCP|CLI|plugin) /, ''));
    assert.ok(names.every((n) => /^[a-z0-9][a-z0-9:._-]*$/.test(n)), ex);
  }
  assert.match(body, /corrected\s+`→`\s+line/, 'says to correct the line when loading fails');
});

test('every qm command cited in SKILL.md and README.md exists in qm help', () => {
  const known = helpCommands();
  assert.ok(known.has('search') && known.has('load'), 'help lists search and load');
  for (const file of [SKILL, path.join(REPO, 'README.md')]) {
    const cited = citedCommands(fs.readFileSync(file, 'utf8'));
    assert.ok(cited.size > 0, `${path.basename(file)} cites qm commands`);
    for (const c of cited) assert.ok(known.has(c), `${path.basename(file)} cites "qm ${c}", which qm help does not list`);
  }
});

test('plugin.json and marketplace.json: valid, named urequartermaster, same version as qm', () => {
  const version = qm('--version').trim();
  assert.equal(version, VERSION);
  const plugin = JSON.parse(read('.claude-plugin', 'plugin.json'));
  assert.equal(plugin.name, 'urequartermaster');
  assert.equal(plugin.version, version);
  assert.equal(plugin.license, 'MIT');
  assert.equal(plugin.author.name, 'UreTech');
  assert.ok(plugin.description && plugin.homepage);
  const market = JSON.parse(read('.claude-plugin', 'marketplace.json'));
  assert.equal(market.name, 'urequartermaster');
  assert.equal(market.owner.name, 'UreTech');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'urequartermaster');
  assert.equal(market.plugins[0].source, './');
  assert.equal(market.plugins[0].version, version);
  assert.equal(JSON.parse(read('package.json')).version, version);
  assert.match(read('CHANGELOG.md'), new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`, 'm'));
});

test('public texts carry no AI signature', () => {
  for (const f of [SKILL, ...['README.md', 'RELEASING.md', 'CHANGELOG.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'].map((p) => path.join(REPO, p))]) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /Co-Authored-By|Generated with|written by (Claude|an AI)/i, path.basename(f));
  }
});
