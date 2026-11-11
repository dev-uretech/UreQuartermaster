// `qm mcp usage|plan|apply|enable|disable|restore`: MCP servers on demand for Claude Code. Output holds server
// names, scopes, transports, project folders and call counts only: never a definition's command, args, URL, env
// or headers. Every name and path is cleaned before printing.
import { clean } from '../core/text.mjs';
import { buildIndex, saveIndex } from '../index/index.mjs';
import { dataDir } from '../core/paths.mjs';
import { mcpUsage, mcpPlan, mcpApply, mcpEnable, mcpDisable, mcpRestore, DEFAULT_DAYS, DEFAULT_MIN_PROJECTS } from '../mcp/manage.mjs';
import { UsageError, parseArgs, guarded } from './common.mjs';

const NEXT_SESSION = 'Claude Code starts MCP servers when a session starts: this takes effect in the next session there. Running sessions keep the servers they started with.';

function intFlag(flags, key, def, max) {
  if (flags[key] === undefined) return def;
  if (!/^[1-9]\d{0,3}$/.test(flags[key]) || Number(flags[key]) > max) throw new UsageError(`--${key} must be an integer from 1 to ${max}`);
  return Number(flags[key]);
}

function scopeText(scopes) {
  const count = (k) => scopes.filter((s) => s.scope === k).length;
  const parts = [];
  if (count('user')) parts.push('user');
  if (count('local')) parts.push(`local in ${count('local')} project${count('local') === 1 ? '' : 's'}`);
  if (count('project-file')) parts.push(`.mcp.json in ${count('project-file')} project${count('project-file') === 1 ? '' : 's'}`);
  for (const s of scopes.filter((x) => x.scope === 'plugin')) parts.push(`plugin ${clean(s.plugin)}`);
  if (count('parked')) parts.push('parked');
  if (count('disabled')) parts.push(`disabled in ${count('disabled')} project${count('disabled') === 1 ? '' : 's'}`);
  return parts.join(', ') || 'none';
}

function reindex() {
  try { saveIndex(dataDir(process.env), buildIndex({})); } catch { /* search rebuilds it when stale */ }
}

function printUsage(out, rep, json) {
  if (json) {
    out(JSON.stringify({
      days: rep.days,
      transcripts: rep.transcripts,
      servers: rep.rows.map((r) => ({ name: r.name, transport: r.transport, scopes: r.scopes, calls: r.calls, projects: r.projects })),
      unconfigured: rep.unknown,
    }, null, 2));
    return;
  }
  out(`# Claude Code MCP servers: scope, transport and tool calls in the last ${rep.days} days (${rep.transcripts} transcripts read).`);
  out('# stdio = a local process started by every session where the server is in scope; http/sse = remote, no local process.');
  for (const r of rep.rows) {
    out(`${clean(r.name)}  ${clean(r.transport)}  [${scopeText(r.scopes)}]  ${r.calls} call${r.calls === 1 ? '' : 's'}${r.projects.length ? ` in ${r.projects.length} project${r.projects.length === 1 ? '' : 's'}` : ''}`);
    for (const p of r.projects) out(`    ${clean(p.project)}  ${p.calls}`);
  }
  if (rep.unknown.length) {
    out(`Used but not configured here (claude.ai connectors or removed servers): ${rep.unknown.map((u) => `${clean(u.name)} (${u.calls})`).join(', ')}`);
  }
}

function printPlan(out, plan) {
  out(`# User-scope MCP servers of Claude Code, from ${plan.days} days of use: kept when used in at least ${plan.minProjects} projects.`);
  for (const a of plan.actions) {
    const head = `${clean(a.name)} (${clean(a.transport)})`;
    if (a.action === 'keep') out(`keep  ${head}: ${clean(a.reason)}`);
    else if (a.action === 'park') out(`park  ${head} -> parked store (${a.calls ? `${a.calls} calls outside known projects` : 'no calls'})`);
    else out(`move  ${head} -> local scope of ${a.projects.map((p) => `${clean(p.project)} (${p.calls})`).join(', ')}`);
  }
  if (!plan.actions.length) out('No MCP servers at user scope.');
  out(`Local MCP processes started by every new session, from user scope: ${plan.stdioUserBefore} -> ${plan.stdioUserAfter}.`);
}

const cmdUsage = (argv, out) => {
  const { flags } = parseArgs(argv, { days: 'value', json: 'bool' });
  printUsage(out, mcpUsage({ days: intFlag(flags, 'days', DEFAULT_DAYS, 3650) }), flags.json);
  return 0;
};

const planOpts = (argv) => {
  const { pos, flags } = parseArgs(argv, { days: 'value', 'min-projects': 'value', json: 'bool' });
  if (pos.length) throw new UsageError('plan and apply take options only');
  return { flags, opts: { days: intFlag(flags, 'days', DEFAULT_DAYS, 3650), minProjects: intFlag(flags, 'min-projects', DEFAULT_MIN_PROJECTS, 999) } };
};

const cmdPlan = (argv, out) => {
  const { opts, flags } = planOpts(argv);
  const plan = mcpPlan(opts);
  if (flags.json) { out(JSON.stringify({ days: plan.days, minProjects: plan.minProjects, actions: plan.actions, stdioUserBefore: plan.stdioUserBefore, stdioUserAfter: plan.stdioUserAfter }, null, 2)); return 0; }
  printPlan(out, plan);
  if (plan.actions.some((a) => a.action !== 'keep')) out('Nothing was changed. Apply it with: qm mcp apply (same options; ~/.claude.json is backed up first).');
  return 0;
};

const cmdApply = (argv, out) => {
  const { opts } = planOpts(argv);
  const res = mcpApply(opts);
  printPlan(out, res);
  if (!res.backup && !res.store) { out('Nothing to change.'); return 0; }
  if (res.backup) out(`Backup of ~/.claude.json: ${clean(res.backup)}`);
  out(`Removed definitions are kept in: ${clean(res.store)} (restore one with: qm mcp restore <name>)`);
  out('New Claude Code sessions start only the servers left in scope. Running sessions keep theirs until they end.');
  reindex();
  return 0;
};

const toggleArgs = (argv, verb) => {
  const { pos, flags } = parseArgs(argv, { project: 'value' });
  if (pos.length !== 1) throw new UsageError(`${verb} needs exactly one server name`);
  return { name: pos[0], project: flags.project };
};

const cmdEnable = (argv, out) => {
  const { name, project } = toggleArgs(argv, 'enable');
  const r = mcpEnable(name, { project });
  out(`${clean(r.name)} for ${clean(r.project)}: ${clean(r.how)}.`);
  if (r.changed) {
    out(NEXT_SESSION);
    if (r.backup) out(`Backup of ~/.claude.json: ${clean(r.backup)}`);
    out(`Switch it off again with: qm mcp disable ${clean(r.name)}${project !== undefined ? ` --project ${clean(r.project)}` : ''}`);
    reindex();
  }
  return 0;
};

const cmdDisable = (argv, out) => {
  const { name, project } = toggleArgs(argv, 'disable');
  const r = mcpDisable(name, { project });
  out(`${clean(r.name)} for ${clean(r.project)}: ${clean(r.how)}.`);
  if (r.changed) {
    out(`${NEXT_SESSION} In a running session you can also switch it off at once in /mcp.`);
    if (r.backup) out(`Backup of ~/.claude.json: ${clean(r.backup)}`);
    reindex();
  }
  return 0;
};

const cmdRestore = (argv, out) => {
  const { pos, flags } = parseArgs(argv, { project: 'value', user: 'bool' });
  if (pos.length !== 1) throw new UsageError('restore needs exactly one server name');
  if (flags.user && flags.project !== undefined) throw new UsageError('use --user or --project, not both');
  const r = mcpRestore(pos[0], { user: flags.user === true, project: flags.project });
  out(`Restored ${clean(r.name)} to ${r.target.scope === 'user' ? 'user scope' : `the local scope of ${clean(r.target.project)}`}.`);
  out(NEXT_SESSION);
  if (r.backup) out(`Backup of ~/.claude.json: ${clean(r.backup)}`);
  reindex();
  return 0;
};

const SUB = { usage: cmdUsage, plan: cmdPlan, apply: cmdApply, enable: cmdEnable, disable: cmdDisable, restore: cmdRestore };

export const cmdMcp = guarded((argv, out) => {
  const [sub, ...rest] = argv;
  if (!sub || !Object.hasOwn(SUB, sub)) throw new UsageError(sub ? `Unknown mcp subcommand "${sub}"` : 'mcp needs a subcommand');
  return SUB[sub](rest, out);
});
