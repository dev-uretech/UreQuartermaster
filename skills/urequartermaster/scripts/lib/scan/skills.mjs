// Skill discovery: installed skill folders, Claude Code plugins, and the qm library.
// Never throws on unreadable folders or files: they are skipped.
// Duplicates (same name) are returned too, marked with `duplicateOf`; later steps ignore them.
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillFile } from './frontmatter.mjs';
import { safe, real, isDir, isFile, listDir } from '../core/files.mjs';
import { checkContained, isSafeName, plainSkillInside, libraryRoot } from './trust.mjs';
import { pluginInstalls, enabledPlugins, cacheLatest } from './claude-plugins.mjs';

const LIBRARY_MAX_DEPTH = 6;
const MAX_FILE = 256 * 1024; // a SKILL.md larger than this is cut before parsing

// Declared name if safe, else the folder name, else the folder name with unsafe runs turned into '-'.
function safeSkillName(declared, dirName) {
  if (isSafeName(declared)) return declared;
  if (isSafeName(dirName)) return dirName;
  const s = String(dirName ?? '').replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 128);
  return isSafeName(s) ? s : null;
}

function readSkill(file, dirName) {
  const text = safe(() => {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_FILE);
      const n = fs.readSync(fd, buf, 0, MAX_FILE, 0);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  }, null);
  if (text === null) return null;
  return parseSkillFile(text, dirName);
}

// Immediate children of `dir` that hold a SKILL.md (symlinked folders included).
function topLevelSkills(dir) {
  const out = [];
  for (const d of listDir(dir)) {
    const folder = path.join(dir, d.name);
    if (!(d.isDirectory() || d.isSymbolicLink()) || !isDir(folder)) continue;
    const file = path.join(folder, 'SKILL.md');
    if (isFile(file)) out.push({ file, dirName: d.name });
  }
  return out;
}

// SKILL.md files below `root`, at most `maxDepth` folder levels, no folder visited twice.
function deepSkills(root, maxDepth) {
  const out = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    const r = real(dir);
    if (r === null || seen.has(r)) return;
    seen.add(r);
    const file = path.join(dir, 'SKILL.md');
    if (isFile(file)) { out.push({ file, dirName: path.basename(dir) }); return; }
    if (depth >= maxDepth) return;
    for (const d of listDir(dir)) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      if (d.isDirectory() || d.isSymbolicLink()) {
        const sub = path.join(dir, d.name);
        if (isDir(sub)) walk(sub, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

function priorityOf(entry) {
  if (entry.source.startsWith('plugin:')) return 0;
  if (entry.source === 'agents') return 1;
  if (entry.source.startsWith('library:')) return 3;
  return 2;
}

export function scanSkills(locations, { dataDir, config, cwd } = {}) {
  const found = []; // { entry, real }

  const add = (file, dirName, make) => {
    const r = real(file);
    if (r === null) return;
    const parsed = safe(() => readSkill(file, dirName), null);
    if (!parsed) return;
    const name = safeSkillName(parsed.name, dirName);
    if (!name) return;
    found.push({ real: r, entry: { kind: 'skill', description: parsed.description, headings: parsed.headings, path: file, ...make(name) } });
  };

  // Claude Code plugins
  const enabled = enabledPlugins(locations.claudeSettingsFile);
  for (const { plugin, key, marketplace, installPaths } of pluginInstalls(locations)) {
    if (!isSafeName(plugin)) continue;
    const on = enabled[key] === true;
    let skills = installPaths.flatMap((p) => topLevelSkills(path.join(p, 'skills')));
    if (!skills.length && marketplace) {
      // Stale or empty installPath: fall back to this plugin's highest cached version.
      const latest = cacheLatest(locations.pluginCache, marketplace, plugin);
      if (latest) skills = topLevelSkills(path.join(latest, 'skills'));
    }
    for (const { file, dirName } of skills) {
      add(file, dirName, (n) => {
        const name = `${plugin}:${n}`;
        return { id: `skill:${name}`, name, source: `plugin:${plugin}`, state: on ? 'installed' : 'plugin-disabled', usage: on ? `Skill tool: ${name}` : `qm load ${name}` };
      });
    }
  }

  // Installed skill folders (agents, claude, codex, ... and extraSkillDirs from config)
  const dirs = [...(locations.skillDirs || [])];
  const extra = config && Array.isArray(config.extraSkillDirs) ? config.extraSkillDirs : [];
  for (const d of extra) if (typeof d === 'string' && d) dirs.push({ dir: d, source: 'extra' });
  const projectRoot = cwd ? real(cwd) : null;
  for (const { dir, source } of dirs) {
    // A repository is untrusted: the root is the project itself, never the (linkable) skills dir.
    const dirReal = source === 'project' ? real(dir) : null;
    if (source === 'project' && !(projectRoot && dirReal && checkContained(projectRoot, dir))) continue;
    for (const { file, dirName } of topLevelSkills(dir)) {
      if (source === 'project' && !plainSkillInside(dirReal, path.dirname(file), file)) continue;
      add(file, dirName, (name) => ({ id: `skill:${name}`, name, source, state: 'installed', usage: `Skill tool: ${name}`, ...(source === 'project' ? { trustRoot: dirReal } : {}) }));
    }
  }

  // Library: <dataDir>/library/<collection>/**/SKILL.md
  if (dataDir) {
    const lib = path.join(dataDir, 'library');
    for (const c of listDir(lib)) {
      if ((c.name.startsWith('.') || c.name.startsWith('_')) && c.name !== '_parked') continue; // temp clones, internal folders
      const cDir = path.join(lib, c.name);
      if (!isDir(cDir)) continue;
      const root = libraryRoot(dataDir, c.name); // collections come from untrusted clones
      if (root === null) continue;
      for (const { file, dirName } of deepSkills(cDir, LIBRARY_MAX_DEPTH)) {
        if (!plainSkillInside(root, path.dirname(file), file)) continue;
        add(file, dirName, (name) => ({ id: `skill:${name}`, name, source: `library:${c.name}`, state: 'library', usage: `qm load ${name}`, trustRoot: root }));
      }
    }
  }

  // Same file reached twice -> once; same name -> first by priority wins (stable sort keeps scan order).
  const ordered = found.map((f, i) => ({ ...f, i })).sort((a, b) => priorityOf(a.entry) - priorityOf(b.entry) || a.i - b.i);
  const realSeen = new Set();
  const byName = new Map();
  const dupCount = new Map();
  const out = [];
  for (const { entry, real: r } of ordered) {
    if (realSeen.has(r)) continue;
    realSeen.add(r);
    const kept = byName.get(entry.name);
    if (kept) {
      const base = `${kept.id}@${entry.source}`;
      const n = (dupCount.get(base) || 0) + 1;
      dupCount.set(base, n);
      out.push({ ...entry, id: n === 1 ? base : `${base}#${n}`, duplicateOf: kept.id });
    }
    else { byName.set(entry.name, entry); out.push(entry); }
  }
  return out;
}
