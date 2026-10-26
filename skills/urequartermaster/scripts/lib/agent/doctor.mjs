// qm doctor: read-only diagnosis. Returns {level, message}[]; never changes anything.
import { loadIndex, isStale } from '../index/index.mjs';
import { loadConfig, loadState } from '../core/config.mjs';
import { dataDir, agentLocations } from '../core/paths.mjs';
import { listClaudePlugins } from '../scan/claude-plugins.mjs';
import { clean } from '../core/text.mjs';

const MAX_SKILLS = 60;
const list = (items, max = 5) => {
  const shown = items.slice(0, max).map(clean).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
};

/** @returns {{ level: 'ok'|'warn'|'error', message: string }[]} */
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
    const entries = idx.entries;
    const dups = entries.filter((e) => e.duplicateOf);
    if (dups.length) add('warn', `${dups.length} duplicate entr${dups.length === 1 ? 'y' : 'ies'} shadowed by another with the same name: ${list(dups.map((e) => e.name))}.`);
    else add('ok', 'No duplicates');

    const skills = entries.filter((e) => e.kind === 'skill' && e.state === 'installed' && !e.duplicateOf);
    if (skills.length > MAX_SKILLS) add('warn', `${skills.length} skills are installed (more than ${MAX_SKILLS}): the host may truncate descriptions; consider \`qm park\`.`);
    else add('ok', `${skills.length} installed skills`);

    const own = entries.filter((e) => e.kind === 'skill' && String(e.name).toLowerCase().split(':').pop() === 'urequartermaster' && e.path);
    if (own.length > 1) {
      const dirs = [...new Set(own.map((e) => String(e.path).replace(/[\\/]SKILL\.md$/i, '')))];
      if (dirs.length > 1) add('warn', `Several copies of UreQuartermaster are installed: ${dirs.map(clean).join('; ')}. Keep one.`);
    }
  }

  for (const r of loadState(dir).parked) {
    if (!r.pending && !r.interrupted) continue;
    const name = clean(r.name);
    add('warn', `Parked skill "${name}" was interrupted (${clean(r.interrupted || 'pending')}): finish it with \`qm unpark ${name}\`, or drop the record with \`qm unpark ${name} --forget\`.`);
  }
  return out;
}
