// Claude Code's MCP configuration in ~/.claude.json: user scope (top-level `mcpServers`), local scope
// (`projects[<path>].mcpServers`) and the per-project `disabledMcpServers` list that the /mcp toggle writes.
// Reading gives definitions to the planner and the toggles; nothing here prints them. Writing goes through
// commitClaudeJson only: one qm at a time (mcp.lock), a 0600 backup first, a re-read right before writing
// that refuses when the MCP part changed since the caller read it, and a 0600 temporary file renamed over
// the original, retried when Claude Code saved the file in between.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isObj, real, safe } from '../core/files.mjs';
import { writePrivateAtomic } from '../core/mcp-store.mjs';
import { acquireLock } from '../update/lock.mjs';

const MAX_BACKUPS = 20;
const REMOTE = new Set(['http', 'sse', 'ws', 'websocket', 'streamable-http']);

/** 'stdio' (a local process per session) or the remote transport named in the definition. */
export function transportOf(def) {
  if (!isObj(def)) return 'unknown';
  const t = typeof def.type === 'string' ? def.type.toLowerCase() : '';
  if (t && /^[a-z0-9_-]{1,32}$/.test(t)) return t;
  if (typeof def.command === 'string' || Array.isArray(def.command)) return 'stdio';
  if (typeof def.url === 'string') return 'http';
  return 'unknown';
}
export const isLocalProcess = (def) => transportOf(def) === 'stdio';
export const isRemote = (def) => REMOTE.has(transportOf(def));

/** The file Claude Code really writes: a symbolic link at ~/.claude.json is followed. */
export function claudeJsonTarget(file) {
  const r = real(file);
  return r || file;
}

/** { text, doc, mtimeMs, size } of ~/.claude.json; doc is {} when the file does not exist. Throws on bad JSON. */
export function readClaudeJson(file) {
  const target = claudeJsonTarget(file);
  let text;
  try { text = fs.readFileSync(target, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { text: null, doc: {}, mtimeMs: null, size: null, target };
    throw new Error(`cannot read ${target}`);
  }
  let doc;
  try { doc = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error(`${target} is not valid JSON: refusing to change it`); }
  if (!isObj(doc)) throw new Error(`${target} is not a JSON object: refusing to change it`);
  const st = fs.statSync(target);
  return { text, doc, mtimeMs: st.mtimeMs, size: st.size, target };
}

const objOr = (v) => (isObj(v) ? v : {});
const listOr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

export const userServers = (doc) => objOr(doc.mcpServers);
export const projectEntry = (doc, project) => (isObj(doc.projects) && isObj(doc.projects[project]) ? doc.projects[project] : null);
export const localServers = (doc, project) => objOr(projectEntry(doc, project)?.mcpServers);
export const disabledIn = (doc, project) => listOr(projectEntry(doc, project)?.disabledMcpServers);
export const projectPaths = (doc) => (isObj(doc.projects) ? Object.keys(doc.projects) : []);

/**
 * Hash of every MCP-related part of the file (user servers, and each project's servers and disabled list).
 * Claude Code rewrites the rest of the file all the time; only a change here means a plan is out of date.
 */
export function mcpHash(doc) {
  const parts = { user: userServers(doc), projects: {} };
  for (const p of projectPaths(doc).sort()) {
    const e = doc.projects[p];
    if (!isObj(e)) continue;
    if (isObj(e.mcpServers) && Object.keys(e.mcpServers).length) parts.projects[p] = { s: e.mcpServers };
    const d = listOr(e.disabledMcpServers);
    if (d.length) parts.projects[p] = { ...(parts.projects[p] || {}), d };
  }
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** Timestamped 0600 copy of the current file in <dataDir>/backups/ (folder 0700); keeps the newest 20. */
export function backupClaudeJson(dataDir, text, now = new Date()) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  safe(() => fs.chmodSync(dir, 0o700), null);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '');
  let file = path.join(dir, `claude.json-${stamp}.bak`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `claude.json-${stamp}-${n}.bak`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
  safe(() => fs.chmodSync(file, 0o600), null);
  const old = safe(() => fs.readdirSync(dir).filter((n) => /^claude\.json-.*\.bak$/.test(n)).sort(), []);
  for (const n of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) safe(() => fs.rmSync(path.join(dir, n)), null);
  return file;
}

/**
 * Applies `mutate(doc)` to ~/.claude.json and writes it, keeping mode 0600.
 * `expectedHash` is mcpHash() of the document the caller planned on: if the MCP part changed since, nothing is
 * written. If the file changes between the re-read and the rename (Claude Code saves it often), the write is
 * retried on a fresh read, up to three times. Returns the backup path (null when the file did not exist).
 * `_deps.beforeRename` is a test hook.
 */
export function commitClaudeJson(file, { dataDir, expectedHash, mutate, _deps = {} }) {
  const release = acquireLock(dataDir, { name: 'mcp.lock', what: 'qm mcp change' });
  try {
    let backup = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = readClaudeJson(file);
      if (expectedHash !== undefined && mcpHash(cur.doc) !== expectedHash) {
        throw new Error('the MCP configuration in ~/.claude.json changed since it was read (another session or command edited it): nothing was written, run the command again');
      }
      if (backup === null && cur.text !== null) backup = backupClaudeJson(dataDir, cur.text);
      const doc = JSON.parse(JSON.stringify(cur.doc));
      mutate(doc);
      const text = `${JSON.stringify(doc, null, 2)}${cur.text === null || cur.text.endsWith('\n') ? '\n' : ''}`;
      if (_deps.beforeRename) _deps.beforeRename(attempt);
      // Same file as read? Otherwise Claude Code wrote it meanwhile: read again (its change is kept).
      const st = safe(() => fs.statSync(cur.target), null);
      const same = cur.text === null ? st === null : st !== null && st.mtimeMs === cur.mtimeMs && st.size === cur.size;
      if (!same) continue;
      writePrivateAtomic(cur.target, text);
      return backup;
    }
    throw new Error('~/.claude.json kept changing while qm tried to write it: nothing was written, try again');
  } finally {
    release();
  }
}
