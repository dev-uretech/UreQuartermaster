// Which MCP servers each project really used: counts the tool_use blocks named mcp__<server>__<tool> in Claude
// Code's session transcripts (<claude dir>/projects/*/*.jsonl, and the subagent transcripts below them) newer
// than a cutoff. Read-only. Only tool names, timestamps and the session's working folder are taken from a
// transcript; nothing else in it (prompts, tool inputs, results) is kept or printed.
import fs from 'node:fs';
import path from 'node:path';
import { safe } from '../core/files.mjs';

const CHUNK = 4 * 1024 * 1024;
const MAX_DEPTH = 4; // projects/<p>/<session>/subagents/<agent>.jsonl

/** Claude Code's tool-name form of a server name: anything but letters, digits, '_' and '-' becomes '_'. */
export const toolKey = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

/** Every .jsonl transcript under `root`, modified at or after `since` (ms). */
export function transcriptFiles(root, since) {
  const out = [];
  const walk = (dir, depth) => {
    for (const d of safe(() => fs.readdirSync(dir, { withFileTypes: true }), [])) {
      const p = path.join(dir, d.name);
      if (d.isDirectory() && depth < MAX_DEPTH) walk(p, depth + 1);
      else if (d.isFile() && d.name.endsWith('.jsonl')) {
        const st = safe(() => fs.statSync(p), null);
        if (st && st.mtimeMs >= since) out.push(p);
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

const NEEDLE = Buffer.from('"name":"mcp__');
const CWD = Buffer.from('"cwd":"');
const NL = 10;

/**
 * Calls fn(line) once for each line of `file` that contains `needle`, reading it in chunks (transcripts can be
 * hundreds of MB): only the matching lines are decoded. Also returns the first line holding `"cwd":"`.
 */
function matchingLines(file, needle, fn) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  let cwdLine = null;
  try {
    const chunk = Buffer.alloc(CHUNK);
    let carry = Buffer.alloc(0);
    const scan = (data, end) => {
      if (cwdLine === null) {
        const c = data.indexOf(CWD);
        if (c >= 0 && c < end) cwdLine = lineAt(data, c, end);
      }
      let from = 0;
      for (;;) {
        const i = data.indexOf(needle, from);
        if (i < 0 || i >= end) break;
        const start = data.lastIndexOf(NL, i) + 1;
        let stop = data.indexOf(NL, i);
        if (stop < 0 || stop > end) stop = end;
        fn(data.toString('utf8', start, stop));
        from = stop + 1;
      }
    };
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, CHUNK, null);
      if (n <= 0) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      const last = data.lastIndexOf(NL);
      if (last < 0) { carry = Buffer.from(data); continue; }
      scan(data, last);
      carry = Buffer.from(data.subarray(last + 1));
    }
    if (carry.length) scan(carry, carry.length);
  } finally {
    fs.closeSync(fd);
  }
  return cwdLine;
}

function lineAt(data, i, end) {
  const start = data.lastIndexOf(NL, i) + 1;
  let stop = data.indexOf(NL, i);
  if (stop < 0 || stop > end) stop = end;
  return data.toString('utf8', start, stop);
}

const CWD_RE = /"cwd":("(?:[^"\\]|\\.)*")/;

/**
 * Counts per transcript: { cwd, calls: Map<toolName, count> } for the tool_use blocks whose name starts
 * with "mcp__", dated at or after `since` (lines without a timestamp count when the file is recent).
 */
export function scanTranscript(file, since) {
  const calls = new Map();
  let cwd = null;
  const cwdLine = matchingLines(file, NEEDLE, (line) => {
    if (!line.includes('"tool_use"')) return;
    const o = safe(() => JSON.parse(line), null);
    if (!o || typeof o !== 'object') return;
    if (typeof o.timestamp === 'string') {
      const t = Date.parse(o.timestamp);
      if (Number.isFinite(t) && t < since) return;
    }
    if (cwd === null && typeof o.cwd === 'string') cwd = o.cwd;
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    for (const b of content) {
      if (b && b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith('mcp__')) {
        calls.set(b.name, (calls.get(b.name) || 0) + 1);
      }
    }
  });
  if (cwdLine) {
    const m = CWD_RE.exec(cwdLine);
    const first = m ? safe(() => JSON.parse(m[1]), null) : null;
    if (typeof first === 'string' && first) cwd = first;
  }
  return { cwd: typeof cwd === 'string' && cwd ? cwd : null, calls };
}

/**
 * Maps a tool name to a known server: `keys` maps the tool-name form of each configured server (for plugin
 * servers "plugin_<plugin>_<server>") to its display name. The longest matching key wins; an unknown server
 * (a claude.ai connector, a removed server) is returned as its raw tool-name form with known=false.
 */
export function serverOfTool(toolName, keys) {
  const rest = toolName.slice('mcp__'.length);
  let best = null;
  for (const k of keys.keys()) if (rest.startsWith(`${k}__`) && (!best || k.length > best.length)) best = k;
  if (best) return { name: keys.get(best), known: true };
  const i = rest.indexOf('__');
  return { name: i > 0 ? rest.slice(0, i) : rest, known: false };
}

/**
 * Usage over the transcripts: Map<server, Map<project, calls>>, plus the unknown servers.
 * A subagent transcript without its own working folder takes its session's.
 */
export function collectUsage({ projectsDir, since, keys }) {
  const usage = new Map();
  const unknown = new Map();
  const sessionCwd = new Map();
  const files = transcriptFiles(projectsDir, since);
  // Main transcripts first, so subagents can borrow the session's folder.
  files.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || (a < b ? -1 : 1));
  for (const f of files) {
    const r = scanTranscript(f, since);
    const rel = path.relative(projectsDir, f).split(path.sep);
    const sessionId = rel.length >= 2 ? `${rel[0]}/${rel[1].replace(/\.jsonl$/, '')}` : f;
    if (rel.length === 2 && r.cwd) sessionCwd.set(sessionId, r.cwd);
    const project = r.cwd || sessionCwd.get(sessionId) || null;
    for (const [tool, n] of r.calls) {
      const s = serverOfTool(tool, keys);
      const target = s.known ? usage : unknown;
      if (!target.has(s.name)) target.set(s.name, new Map());
      const m = target.get(s.name);
      const k = project || '(unknown project)';
      m.set(k, (m.get(k) || 0) + n);
    }
  }
  return { usage, unknown, files: files.length };
}
