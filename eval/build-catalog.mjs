#!/usr/bin/env node
// Builds the fake home of the acceptance bench: node eval/build-catalog.mjs [--out <dir>]
// Reproducible: collections come from pinned commits (a "HEAD" commit is resolved once and written back).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EVAL_DIR, DEFAULT_BENCH, benchPaths, ensureBenchKeychain, readCatalog, qm, setQm } from './bench.mjs';

const CACHE = path.join(EVAL_DIR, '.cache');
const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' }, timeout: 300_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  return r.stdout.trim();
};

function resolveCommits(catalog) {
  let changed = false;
  for (const c of catalog.collections) {
    if (c.commit && c.commit !== 'HEAD') continue;
    const out = git(['ls-remote', c.url, 'HEAD']);
    const sha = out.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`cannot resolve HEAD of ${c.url}`);
    c.commit = sha;
    changed = true;
    console.log(`pinned ${c.name} -> ${sha}`);
  }
  if (changed) fs.writeFileSync(path.join(EVAL_DIR, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
}

function fetchCollection(c) {
  const dir = path.join(CACHE, `${c.name}@${c.commit}`);
  if (fs.existsSync(path.join(dir, '.qm-complete'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  console.log(`fetching ${c.name}@${c.commit.slice(0, 8)} ...`);
  git(['init', '-q'], dir);
  git(['remote', 'add', 'origin', c.url], dir);
  git(['fetch', '-q', '--depth', '1', 'origin', c.commit], dir);
  git(['checkout', '-q', 'FETCH_HEAD'], dir);
  fs.writeFileSync(path.join(dir, '.qm-complete'), '');
  return dir;
}

/** Direct children of each root that hold a SKILL.md; one `*` path segment allowed. First name wins. */
function collectSkills(dir, roots) {
  const found = new Map();
  const expand = (base, segs) => {
    if (!segs.length) return [base];
    const [s, ...rest] = segs;
    if (s !== '*') return expand(path.join(base, s), rest);
    let names = [];
    try { names = fs.readdirSync(base).sort(); } catch { return []; }
    return names.flatMap((n) => expand(path.join(base, n), rest));
  };
  for (const root of roots) {
    for (const r of expand(dir, root.split('/'))) {
      let names = [];
      try { names = fs.readdirSync(r).sort(); } catch { continue; }
      for (const n of names) {
        const d = path.join(r, n);
        if (fs.existsSync(path.join(d, 'SKILL.md')) && !found.has(n)) found.set(n, d);
      }
    }
  }
  return found;
}

const copyDir = (src, dst) => fs.cpSync(src, dst, { recursive: true, filter: (s) => path.basename(s) !== '.git' });

function writeStubs(bin, clis) {
  fs.rmSync(bin, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const c of clis) {
    fs.writeFileSync(path.join(bin, c.name), '#!/bin/sh\necho stub\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${c.name}.cmd`), '@echo stub\r\n');
  }
}

function writeMcpConfigs(p, catalog) {
  const script = path.join(EVAL_DIR, 'fake-mcp.mjs');
  const servers = {};
  for (const m of catalog.mcp) servers[m.name] = { type: 'stdio', command: 'node', args: [script, m.name], env: {} };

  // Claude keeps its servers in $CLAUDE_CONFIG_DIR/.claude.json, which also holds its own state after a
  // login: merge in memory and touch only `mcpServers`.
  const cj = path.join(p.claudeDir, '.claude.json');
  let doc = {};
  if (fs.existsSync(cj)) {
    try { doc = JSON.parse(fs.readFileSync(cj, 'utf8')); } catch { throw new Error(`${cj} is not valid JSON; remove it and log in again`); }
  }
  doc.mcpServers = servers;
  fs.mkdirSync(p.claudeDir, { recursive: true });
  fs.writeFileSync(cj, `${JSON.stringify(doc, null, 2)}\n`);

  // Codex: keep whatever codex wrote itself, replace only our marked block.
  const START = '# urequartermaster-bench:start';
  const END = '# urequartermaster-bench:end';
  const block = `${START}\n${catalog.mcp.map((m) => `[mcp_servers.${m.name}]\ncommand = "node"\nargs = [${JSON.stringify(script)}, ${JSON.stringify(m.name)}]\n`).join('\n')}${END}\n`;
  const tf = path.join(p.codexDir, 'config.toml');
  fs.mkdirSync(p.codexDir, { recursive: true });
  let cur = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8') : '';
  const i = cur.indexOf(START); const j = cur.indexOf(END);
  if (i >= 0 && j > i) cur = cur.slice(0, i) + cur.slice(j + END.length).replace(/^\r?\n/, '');
  fs.writeFileSync(tf, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${block}`);

  // Claude agent runs get exactly these servers through --strict-mcp-config.
  fs.writeFileSync(path.join(p.bench, 'mcp-claude.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

function main(argv) {
  const oi = argv.indexOf('--out');
  const bench = path.resolve(oi >= 0 ? argv[oi + 1] : DEFAULT_BENCH);
  const catalog = readCatalog();
  resolveCommits(catalog);
  const p = benchPaths(bench);

  // Rebuild everything the bench owns, but keep the agents' login state inside .claude, .codex and Library (macOS keychain).
  for (const d of [p.claudeSkills, p.agentsSkills, p.codexSkills, p.uqm, p.bin, path.join(bench, 'project')]) fs.rmSync(d, { recursive: true, force: true });
  for (const d of [p.claudeSkills, p.agentsSkills, p.codexSkills, path.join(p.uqm, 'library'), path.join(bench, 'project')]) fs.mkdirSync(d, { recursive: true });

  ensureBenchKeychain(bench);

  let installed = 0; let library = 0;
  const owner = new Map();
  for (const c of catalog.collections) {
    const skills = collectSkills(fetchCollection(c), c.roots || ['skills']);
    if (!skills.size) throw new Error(`${c.name}: no skills found under roots ${JSON.stringify(c.roots)}`);
    for (const name of skills.keys()) {
      if (name === 'urequartermaster' || owner.has(name)) throw new Error(`duplicate skill name "${name}" (${owner.get(name) || 'reserved'} and ${c.name}); pick different roots or an installed list`);
      owner.set(name, c.name);
    }
    const want = c.placement === 'installed' ? new Set(c.installed || [...skills.keys()]) : new Set();
    for (const w of want) if (!skills.has(w)) throw new Error(`${c.name}: installed skill "${w}" not found`);
    for (const [name, src] of skills) {
      if (want.has(name)) {
        if ((c.agents || []).includes('claude')) copyDir(src, path.join(p.claudeSkills, name));
        if ((c.agents || []).includes('codex')) copyDir(src, path.join(p.agentsSkills, name));
        installed++;
      } else {
        copyDir(src, path.join(p.uqm, 'library', c.name, name));
        library++;
      }
    }
  }
  console.log(`skills: ${installed} installed, ${library} in the library`);

  writeStubs(p.bin, catalog.clis);
  writeMcpConfigs(p, catalog);
  const mcpDescriptions = Object.fromEntries(catalog.mcp.map((m) => [m.name, m.description]));
  fs.writeFileSync(path.join(p.uqm, 'config.json'), `${JSON.stringify({ autoUpdate: false, maxIndexAgeHours: 8760, clis: catalog.clis, mcpDescriptions }, null, 2)}\n`);

  setQm(bench, true); // installs UreQuartermaster (Codex copy + init block) and builds the index
  const n = (k) => qm(bench, ['list', '--kind', k], { pathOnlyBin: true }).stdout.split('\n').filter(Boolean).length;
  console.log(`index (duplicates hidden): ${n('skill')} skills (incl. urequartermaster), ${n('mcp')} mcp, ${n('cli')} cli`);
  console.log(`bench ready: ${bench}`);
  console.log(`one-time logins (once per bench; the harness never copies credentials):\n  CLAUDE_CONFIG_DIR="${p.claudeDir}" HOME="${p.home}" claude auth login\n  CODEX_HOME="${p.codexDir}" HOME="${p.home}" codex login`);
}

main(process.argv.slice(2));
