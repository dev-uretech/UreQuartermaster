// qm doctor: read-only diagnosis. Returns {level, message}[]; never changes anything.
import { loadIndex, isStale } from '../index/index.mjs';
import { loadConfig, loadState } from '../core/config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, agentLocations, skillReaders } from '../core/paths.mjs';
import { listClaudePlugins } from '../scan/claude-plugins.mjs';
import { scanSkills } from '../scan/skills.mjs';
import { real, safe } from '../core/files.mjs';
import { clean } from '../core/text.mjs';

// Claude Code's skill listing (code.claude.com/docs/en/skills): every name is listed; past a budget of 1% of the
// context window (8,000 characters when unknown) the descriptions of the least-used skills are dropped, and each
// description is capped at 1,536 characters. There is no documented limit on the number of skills.
const LISTING_BUDGET = 8000;
const LISTING_MAX_DESC = 1536;
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Estimated size of Claude Code's skill listing: name plus description (capped) per skill. */
export function listingSize(skills) {
  return skills.reduce((n, e) => n + String(e.name ?? '').length + Math.min(String(e.description ?? '').length, LISTING_MAX_DESC), 0);
}

const isOwn = (e) => String(e.name).toLowerCase().split(':').pop() === 'urequartermaster';

// Skills one agent loads: its folders (links resolved, the same file once) and, for Claude Code, enabled plugins.
function agentSkills(reader, loc, cwd) {
  const plugins = reader.plugins
    ? { installedPluginsFile: loc.installedPluginsFile, pluginCache: loc.pluginCache, claudeSettingsFile: loc.claudeSettingsFile }
    : { installedPluginsFile: null, pluginCache: null, claudeSettingsFile: null };
  return scanSkills({ skillDirs: reader.dirs, ...plugins }, { cwd }).filter((e) => e.state === 'installed');
}

// Distinct copies of UreQuartermaster an agent would load, by real folder.
function ownCopies(skills) {
  const seen = new Map();
  for (const e of skills.filter(isOwn)) {
    const dir = path.dirname(e.path);
    const key = real(dir) || dir;
    if (!seen.has(key)) seen.set(key, dir);
  }
  return [...seen.values()];
}
const list = (items, max = 5) => {
  const shown = items.slice(0, max).map(clean).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
};

/** @returns {{ level: 'ok'|'info'|'warn'|'error', message: string }[]} */
export function doctor(opts = {}) {
  const out = [];
  const add = (level, message) => out.push({ level, message });
  const dir = opts.dataDir || dataDir(opts.env || process.env);

  const nodeVersion = opts.nodeVersion || process.versions.node;
  const major = Number.parseInt(String(nodeVersion).split('.')[0], 10);
  if (!(major >= 18)) add('error', `Node ${clean(nodeVersion)} is too old: UreQuartermaster needs Node 18 or newer.`);
  else add('ok', `Node ${clean(nodeVersion)}`);

  const idx = loadIndex(dir);
  if (!idx) add('warn', 'The index is missing: run `qm index` (it also builds itself on the next `qm search`).');
  else if (isStale(idx, opts)) add('warn', 'The index is stale (skills, MCP servers or plugins changed, or it is old): run `qm index`.');
  else add('ok', `Index up to date (${idx.entries.length} entries)`);

  // The hook ships only with the Claude Code plugin; skills CLI and manual copies have none.
  const env = opts.env || process.env;
  let plugin = false;
  try {
    plugin = listClaudePlugins(agentLocations({ home: opts.home, env, cwd: opts.cwd }))
      .some((p) => p.plugin === 'urequartermaster' && p.enabled);
  } catch { plugin = false; }
  if (loadConfig(dir).hook === false) add('warn', 'The prompt hook is turned off in config.json ("hook": false): agents get no reminder.');
  else if (plugin) add('ok', 'Prompt hook enabled (Claude Code plugin)');
  else add('ok', 'Prompt hook not active: it comes with the Claude Code plugin, which is not installed or not enabled.');

  if (idx) {
    const dups = idx.entries.filter((e) => e.duplicateOf);
    if (dups.length) add('warn', `${dups.length} duplicate entr${dups.length === 1 ? 'y' : 'ies'} shadowed by another with the same name: ${list(dups.map((e) => e.name))}.`);
    else add('ok', 'No duplicates');
  }

  // What each agent in use (its own folder exists) actually loads.
  let readers;
  try {
    const where = { home: opts.home, env, cwd: opts.cwd, platform: opts.platform };
    const loc = agentLocations(where);
    const cwd = opts.cwd || process.cwd();
    readers = skillReaders(where).map((r) => ({ ...r, used: safe(() => fs.statSync(r.home).isDirectory(), false), skills: agentSkills(r, loc, cwd) }));
  } catch { readers = []; }

  const claude = readers.find((r) => r.agent === 'claude');
  if (claude && claude.used) {
    const listed = claude.skills.filter((e) => !e.duplicateOf);
    const size = listingSize(listed);
    const what = `~${fmt(size)} characters for ${listed.length} skill${listed.length === 1 ? '' : 's'}`;
    if (size > LISTING_BUDGET) add('warn', `Claude Code skill listing: ${what}. It may exceed Claude Code's skill listing budget (1% of the context window; 8,000 characters when unknown): descriptions of the least-used skills are dropped. Check /context, or park skills you rarely use with qm park.`);
    else add('info', `Claude Code skill listing: ${what}`);
  }

  // Several copies are a problem only when the same agent loads them: one per agent is the intended setup.
  const users = readers.filter((r) => r.used).map((r) => ({ label: r.label, copies: ownCopies(r.skills) }));
  const crowded = users.filter((u) => u.copies.length > 1);
  for (const u of crowded) add('warn', `${u.label} would load ${u.copies.length} copies of UreQuartermaster: ${u.copies.map(clean).join('; ')}. Keep one.`);
  const single = users.filter((u) => u.copies.length === 1);
  if (!crowded.length && single.length) add('ok', `One UreQuartermaster copy per agent: ${single.map((u) => `${u.label} uses ${clean(u.copies[0])}`).join('; ')}`);

  for (const r of loadState(dir).parked) {
    if (!r.pending && !r.interrupted) continue;
    const name = clean(r.name);
    add('warn', `Parked skill "${name}" was interrupted (${clean(r.interrupted || 'pending')}): finish it with \`qm unpark ${name}\`, or drop the record with \`qm unpark ${name} --forget\`.`);
  }
  return out;
}
