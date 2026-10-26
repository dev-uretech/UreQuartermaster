// qm init: adds (or removes) a short block in the agents' global instruction files.
// The rest of each file is preserved byte for byte: it is read and written as latin1,
// which maps every byte to one char and back, and the block itself is pure ASCII.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentLocations } from '../core/paths.mjs';

export const START = '<!-- urequartermaster:start -->';
export const END = '<!-- urequartermaster:end -->';
export const BLOCK_LINES = [
  'Before non-trivial tasks, check which local tools fit: run the urequartermaster skill (qm search) and use what it finds.',
  'Prefer an installed skill, MCP server, plugin or CLI over doing the work by hand; say which ones you use in one line.',
  'Ask the user only when two different tools are equally plausible. A skill that is not installed may be in the library: qm load <name>.',
];

const blockText = (eol) => [START, ...BLOCK_LINES, END].join(eol);

export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

function writeAtomic(file, buf) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    let mode;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
    fs.writeFileSync(tmp, buf, mode ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

const BOM = '\xef\xbb\xbf';
const TERMINATOR = /\r\n|\n|\r/g;
const CREATE_MISSING = new Set(['claude', 'codex']);

/** The file's own line ending: that of its last line break, else its first (same thing), else LF. */
function lastEol(text) {
  let last = '\n';
  for (const m of text.matchAll(TERMINATOR)) last = m[0];
  return last;
}

/**
 * Marker lines of `text`: a marker counts only when it is a whole line (surrounding whitespace allowed)
 * and outside a fenced code block (``` or ~~~). Markers inside fences or in the middle of a sentence are
 * the user's own content and are ignored.
 */
function findMarkers(full) {
  // A leading BOM is not part of the first line; positions stay relative to the whole text.
  const off = full.startsWith(BOM) ? BOM.length : 0;
  const text = full.slice(off);
  const found = [];
  let fence = null; // { ch, len }
  let pos = 0;
  for (const m of [...text.matchAll(TERMINATOR), { index: text.length, 0: '' }]) {
    const lineStart = pos;
    const lineEnd = m.index; // end of content, before the terminator
    pos = m.index + m[0].length;
    const line = text.slice(lineStart, lineEnd);
    const t = line.trim();
    const f = /^(`{3,}|~{3,})(.*)$/.exec(t);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === '') fence = null;
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = { ch: f[1][0], len: f[1].length }; continue; }
    // Only column 0 counts: an indented marker is part of an indented code block or a list.
    const tail = line.trimEnd();
    if (tail === START) found.push({ type: 'start', lineStart: lineStart + off, lineEnd: lineEnd + off });
    else if (tail === END) found.push({ type: 'end', lineStart: lineStart + off, lineEnd: lineEnd + off });
  }
  return { found, openFence: fence !== null };
}

/** New content for `text` (latin1 string), or null when nothing changes. Throws for odd marker arrangements. */
function transform(text, remove, file) {
  const eol = lastEol(text);
  const { found: mk, openFence } = findMarkers(text);
  if (openFence) throw new Error(`unclosed code fence at the end of ${file}; close it and run again`);
  let s = -1;
  let endAt = -1;
  if (mk.length) {
    if (mk.length !== 2 || mk[0].type !== 'start' || mk[1].type !== 'end') {
      throw new Error('has marker lines in an unexpected arrangement (not one start followed by one end)');
    }
    s = mk[0].lineStart;
    endAt = mk[1].lineEnd;
  }

  if (remove) {
    if (s === -1) return null;
    let before = text.slice(0, s);
    let after = text.slice(endAt);
    const m = /^(\r\n|\n|\r)/.exec(after);
    if (m) after = after.slice(m[0].length);
    if (after === '') {
      // Undo what init appended: one blank line, or the single separator it added to a file with no final newline.
      if (before.endsWith(eol + eol)) before = before.slice(0, -eol.length);
      else if (before.endsWith(eol)) before = before.slice(0, -eol.length);
    }
    return { text: before + after, existing: true };
  }
  if (s !== -1) {
    const next = text.slice(0, s) + blockText(eol) + text.slice(endAt);
    return next === text ? null : { text: next, existing: true };
  }
  const bom = text.startsWith(BOM) ? BOM : '';
  const body = text.slice(bom.length);
  if (body === '') return { text: `${bom}${blockText(eol)}${eol}`, existing: false };
  // Exactly one line break is added: a blank line before the block if the file ended with a break, else just the separator.
  return { text: `${text}${eol}${blockText(eol)}${eol}`, existing: false };
}

/**
 * @param {{ remove?: boolean, dryRun?: boolean, agents?: string[], home?: string, env?: object, platform?: string, cwd?: string }} o
 * @returns {{ file: string, agent: string, changed: boolean, action: string, warning?: string }[]}
 */
export function initAgents({ remove = false, dryRun = false, agents, ...opts } = {}) {
  const results = [];
  const loc = agentLocations(opts);
  const home = opts.home || os.homedir();
  for (const { file, agent } of loc.instructionFiles) {
    if (agents && !agents.includes(agent)) continue;
    const res = { file, agent, changed: false, action: 'unchanged', present: false };
    results.push(res);
    const skip = (why) => { res.action = 'skipped'; res.warning = why; };
    try {
      let target = file;
      let lst = null;
      try { lst = fs.lstatSync(file); } catch { /* missing */ }
      res.present = !!lst;
      if (lst && lst.isSymbolicLink()) {
        let real;
        try { real = fs.realpathSync(file); } catch { skip('is a dangling symlink'); continue; }
        let realHome;
        try { realHome = fs.realpathSync(home); } catch { realHome = home; }
        if (!realHome || !isInside(realHome, real)) { skip(`is a symlink to ${real}, outside your home directory`); continue; }
        target = real;
      } else if (lst && !lst.isFile()) { skip('is not a regular file'); continue; }
      if (lst) {
        if (fs.statSync(target).nlink > 1) { skip('is a hard link (replacing it would break the link)'); continue; }
        try { fs.accessSync(target, fs.constants.W_OK); } catch { skip('is read-only'); continue; }
      }

      let text = '';
      if (lst) {
        const buf = fs.readFileSync(target);
        if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) { skip('is UTF-16 encoded'); continue; }
        text = buf.toString('latin1');
      } else {
        if (remove || !CREATE_MISSING.has(agent) || !fs.existsSync(path.dirname(file))) continue;
      }
      let next;
      try { next = transform(text, remove, file); } catch (e) { skip(e.message); continue; }
      if (next === null) continue;
      res.changed = true;
      res.action = remove ? 'removed' : (next.existing ? 'updated' : (lst ? 'added' : 'created'));
      if (!dryRun) writeAtomic(target, Buffer.from(next.text, 'latin1'));
    } catch (e) {
      res.changed = false;
      skip(`could not be updated (${e && e.code ? e.code : 'error'})`);
    }
  }
  return results;
}
