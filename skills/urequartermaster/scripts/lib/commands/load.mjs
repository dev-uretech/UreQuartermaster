// `qm load`: prints a skill's SKILL.md (or a short block for other kinds) under a third-party notice.
// Project and library skills are re-checked before reading: their files must still lie inside the
// folder they came from. The body is capped at 512 KB and stripped of control characters.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../core/paths.mjs';
import { clean, cleanBody } from '../core/text.mjs';
import { verifyEntryTrust } from '../scan/trust.mjs';
import { UsageError, parseArgs, oneLine, isProject, currentIndex, LOAD_NOTICE, PROJECT_SOURCE } from './common.mjs';

const MAX_SKILL_BYTES = 512 * 1024;

// Edit distance, bounded by the shorter string: cheap enough for a few thousand names.
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarNames(entries, wanted, n = 3) {
  const w = wanted.toLowerCase();
  const seen = new Set();
  const scored = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const sub = name.includes(w) || w.includes(name);
    scored.push({ name: e.name, s: distance(w, name) - (sub ? 100 : 0) });
  }
  return scored.sort((a, b) => a.s - b.s || a.name.localeCompare(b.name)).slice(0, n).map((x) => x.name);
}

function findEntry(entries, wanted) {
  const w = wanted.toLowerCase();
  const live = (e) => !e.duplicateOf;
  return entries.find((e) => e.id === wanted)
    || entries.find((e) => live(e) && e.name.toLowerCase() === w)
    || entries.find((e) => e.name.toLowerCase() === w);
}

function readSkill(file) {
  const fd = fs.openSync(file, 'r');
  if (!fs.fstatSync(fd).isFile()) { fs.closeSync(fd); throw Object.assign(new Error('not a regular file'), { code: 'ENOTFILE' }); }
  try {
    const buf = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
    }
    if (got <= MAX_SKILL_BYTES) return buf.toString('utf8', 0, got);
    return `${buf.toString('utf8', 0, MAX_SKILL_BYTES)}\n\n[truncated: file is larger than 512 KB]\n`;
  } finally { fs.closeSync(fd); }
}

export function cmdLoad(argv, out) {
  const { pos } = parseArgs(argv, {});
  if (pos.length !== 1) throw new UsageError('load needs exactly one name or id');
  const idx = currentIndex();
  const entries = idx ? idx.entries : [];
  const e = findEntry(entries, pos[0]);
  if (!e) {
    const near = similarNames(entries, pos[0]);
    const lines = [`No entry named "${clean(pos[0])}".`];
    if (near.length) lines.push('Most similar names:', ...near.map((n) => `  ${clean(n)}`));
    process.stderr.write(`${lines.join('\n')}\n`);
    return 1;
  }
  if (e.kind === 'skill' && e.path) {
    if (!verifyEntryTrust(e, { cwd: process.cwd(), dataDir: dataDir(process.env) })) {
      process.stderr.write(`Refusing to load "${clean(e.name)}": its files lead outside the project or library folder it came from.\n`);
      return 1;
    }
    let body;
    try { body = readSkill(e.path); } catch (err) {
      process.stderr.write(`Cannot read ${clean(e.path)}: ${err.code || err.message}\n`);
      return 1;
    }
    out(`# Skill: ${clean(e.name)}`);
    out(`# Base directory: ${clean(path.dirname(e.path))}`);
    if (isProject(e)) out(PROJECT_SOURCE);
    out(LOAD_NOTICE);
    out('');
    const text = cleanBody(body);
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return 0;
  }
  out(`# ${clean(e.kind)}: ${clean(e.name)}`);
  if (isProject(e)) out(PROJECT_SOURCE);
  out(LOAD_NOTICE);
  out(`kind: ${clean(e.kind)}`);
  out(`name: ${clean(e.name)}`);
  out(`source: ${clean(e.source)}`);
  out(`description: ${oneLine(e.description)}`);
  out(`usage: ${clean(e.usage)}`);
  out(`path: ${clean(e.path) || '-'}`);
  return 0;
}
