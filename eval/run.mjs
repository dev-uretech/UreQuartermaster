#!/usr/bin/env node
// Runs real agents (Claude Code, Codex) non-interactively against the bench and stores their transcripts.
//   node eval/run.mjs --agent claude|codex|all --lang it|en|es|fr|de|pt|all --set dev|holdout
//        [--concurrency 4] [--with-qm|--without-qm] [--limit N] [--bench <dir>] [--timeout 180]
//
// LEAST PRIVILEGE: the bench runs third-party skills from public collections, so the agents never get full
// permissions. Claude Code runs in the default permission mode with an explicit allowlist (Skill, Read scoped to the
// bench and the run's temp dir, the bench's qm script and the fake MCP servers) and Write/Edit/Glob/Grep/WebFetch/WebSearch denied, with
// --strict-mcp-config; Codex runs with -s read-only. Their environment is an allowlist (see bench.mjs).
// Authentication is never copied: log in once inside the bench (the command is printed when missing).
// Notes: the library and the index stay present in --without-qm runs (only qm itself is removed); all
// concurrent Claude runs share <bench>/home/.claude/.claude.json, which Claude Code rewrites, so keep the
// concurrency modest if runs fail with config errors.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { EVAL_DIR, REPO, QM, DEFAULT_BENCH, benchPaths, benchEnv, setQm, readCatalog } from './bench.mjs';
import { loadRequests, analyzeTranscript, parseJsonl } from './score.mjs';

export const INSTRUCTION = 'Evaluation run: find which of the available tools (skills, MCP servers, plugins, command-line programs) fit this request. You may look tools up and read their instructions, but do not carry out the request itself. Then write exactly one line `→ Using: <tool> + <tool>` (or `→ Using: none`) and stop.';
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt'];

function parseArgs(argv) {
  const a = { agent: 'all', lang: 'all', set: 'dev', concurrency: 4, withQm: true, timeout: 180, bench: DEFAULT_BENCH, limit: 0, results: null, pass: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--agent') a.agent = v();
    else if (k === '--lang') a.lang = v();
    else if (k === '--set') a.set = v();
    else if (k === '--concurrency') a.concurrency = Math.max(1, Number(v()) || 4);
    else if (k === '--with-qm') a.withQm = true;
    else if (k === '--without-qm') a.withQm = false;
    else if (k === '--limit') a.limit = Number(v()) || 0;
    else if (k === '--timeout') a.timeout = Number(v()) || 180;
    else if (k === '--bench') a.bench = path.resolve(v());
    else if (k === '--results') a.results = path.resolve(v());
    else if (k === '--pass-env') a.pass.push(v());
    else throw new Error(`unknown option ${k}`);
  }
  a.agents = a.agent === 'all' ? ['claude', 'codex'] : a.agent.split(',');
  for (const g of a.agents) if (!['claude', 'codex'].includes(g)) throw new Error(`unknown agent ${g}`);
  a.langs = a.lang === 'all' ? LANGS : a.lang.split(',');
  return a;
}

/** Cheap login probe: asks the CLI itself, never reads its credential files. */
export function authProbe(agent, bench, pass = []) {
  const env = benchEnv(bench, { pass });
  if (agent === 'claude') {
    const r = spawnSync('claude', ['auth', 'status'], { env, encoding: 'utf8', timeout: 30_000 });
    try { return JSON.parse(r.stdout).loggedIn === true; } catch { return r.status === 0 && !/not logged/i.test(r.stdout + r.stderr); }
  }
  const r = spawnSync('codex', ['login', 'status'], { env, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 && !/not logged/i.test(`${r.stdout}${r.stderr}`);
}

export function loginCommand(agent, bench) {
  const p = benchPaths(bench);
  return agent === 'claude'
    ? `CLAUDE_CONFIG_DIR="${p.claudeDir}" HOME="${p.home}" claude auth login`
    : `CODEX_HOME="${p.codexDir}" HOME="${p.home}" codex login`;
}

// Only read-only qm subcommands: `add` reaches the network, the others change state.
const QM_ALLOWED = ['search', 'load', 'list'];
const QM_DENIED = ['add', 'sync', 'init', 'park', 'unpark', 'update', 'rollback', 'index', 'doctor'];
const absRule = (p) => `//${p.replace(/\\/g, '/').replace(/^\/+/, '')}`;
const realOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

/**
 * Claude Code arguments with the least-privilege allowlist (exported for tests).
 * Read is scoped to the bench, the run's project dir (and the qm skill folder of the plugin). Glob and Grep
 * cannot be scoped to a path, so they are not allowed at all: the agent searches through qm.
 */
export function claudeArgs({ bench, withQm, servers, cwd }) {
  const p = benchPaths(bench);
  const qmPaths = withQm ? [QM, path.join(p.agentsSkills, 'urequartermaster', 'scripts', 'qm.mjs')] : [];
  const roots = [bench, cwd, withQm ? path.join(REPO, 'skills', 'urequartermaster') : null].filter(Boolean);
  const readRoots = [...new Set(roots.flatMap((r) => [r, realOr(r)]))];
  const allowed = ['Skill',
    ...readRoots.map((r) => `Read(${absRule(r)}/**)`),
    ...qmPaths.flatMap((q) => QM_ALLOWED.flatMap((c) => [`Bash(node ${q} ${c}:*)`, `Bash(node "${q}" ${c}:*)`])),
    ...servers.map((s) => `mcp__${s}`)];
  const denied = ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Glob', 'Grep',
    ...qmPaths.flatMap((q) => QM_DENIED.flatMap((c) => [`Bash(node ${q} ${c}:*)`, `Bash(node "${q}" ${c}:*)`])),
    `Read(${absRule(path.join(p.claudeDir, '.credentials.json'))})`, `Read(${absRule(path.join(p.codexDir, 'auth.json'))})`];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default',
    '--max-turns', '8', '--append-system-prompt', INSTRUCTION,
    '--strict-mcp-config', '--mcp-config', path.join(bench, 'mcp-claude.json'),
    '--allowedTools', ...allowed, '--disallowedTools', ...denied];
  if (withQm) args.push('--plugin-dir', REPO);
  return args;
}

function agentCommand(agent, { withQm, cwd, bench }) {
  if (agent === 'claude') {
    const servers = readCatalog().mcp.map((m) => m.name);
    return { cmd: 'claude', args: claudeArgs({ bench, withQm, servers, cwd }), stdin: (prompt) => prompt };
  }
  const args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', cwd, '-'];
  return { cmd: 'codex', args, stdin: (prompt) => `Evaluation note (not part of the user's request): ${INSTRUCTION}\n\n---\nUser request:\n${prompt}\n` };
}

function runOne(agent, req, opts) {
  return new Promise((resolve) => {
    // One fixed, empty project dir for every run: the prompt prefix stays identical, so the agents reuse their cache.
    const cwd = path.join(opts.bench, 'run-project');
    fs.mkdirSync(cwd, { recursive: true });
    const { cmd, args, stdin } = agentCommand(agent, { withQm: opts.withQm, cwd, bench: opts.bench });
    const started = Date.now();
    const lines = [];
    let stderr = ''; let timedOut = false; let spawnError = null; let buf = '';
    const child = spawn(cmd, args, { cwd, env: benchEnv(opts.bench, { pass: opts.pass }), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const killTree = (sig) => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; killTree('SIGTERM'); setTimeout(() => killTree('SIGKILL'), 3000).unref(); }, opts.timeout * 1000);
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d.toString('utf8'); });
    child.on('error', (e) => { spawnError = e.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin(req.prompt));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) lines.push(buf);
      const ok = !timedOut && !spawnError && code === 0;
      const meta = { type: 'qm_meta', ok, exitCode: code, durationMs: Date.now() - started };
      if (timedOut) meta.error = 'timeout';
      else if (spawnError) meta.error = `spawn: ${spawnError}`;
      else if (code !== 0) { meta.error = `exit ${code}`; meta.stderr = stderr.trim().slice(-500); }
      resolve({ lines, meta });
    });
  });
}

/** Cost and token totals from a transcript (Claude: result event; Codex: turn.completed usage). */
function usageOf(lines) {
  const u = { costUsd: 0, inputTokens: 0, outputTokens: 0 };
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'result') {
      u.costUsd += Number(e.total_cost_usd) || 0;
      if (e.usage) { u.inputTokens += (e.usage.input_tokens || 0) + (e.usage.cache_read_input_tokens || 0) + (e.usage.cache_creation_input_tokens || 0); u.outputTokens += e.usage.output_tokens || 0; }
    } else if (e.type === 'turn.completed' && e.usage) {
      u.inputTokens += e.usage.input_tokens || 0; u.outputTokens += e.usage.output_tokens || 0;
    }
  }
  return u;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

const stamp = () => { const d = new Date(); const z = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };
const version = (cmd) => { try { return spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15_000 }).stdout.trim(); } catch { return null; } };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(opts.bench, 'home', '.urequartermaster', 'index.json'))) {
    console.error(`No bench at ${opts.bench}. Build it first: node eval/build-catalog.mjs`);
    return 2;
  }
  const reqFile = path.join(EVAL_DIR, 'requests', `${opts.set}.jsonl`);
  if (!fs.existsSync(reqFile)) { console.error(`Missing ${reqFile}`); return 2; }
  let requests = loadRequests(reqFile).filter((r) => opts.langs.includes(r.lang));
  if (opts.limit) { const keep = new Set([...new Set(requests.map((r) => r.id))].slice(0, opts.limit)); requests = requests.filter((r) => keep.has(r.id)); }
  if (!requests.length) { console.error('No requests match.'); return 2; }

  const missing = opts.agents.filter((a) => !authProbe(a, opts.bench, opts.pass));
  if (missing.length) {
    console.error('Not logged in inside the bench. Run once, interactively, then repeat this command:');
    for (const a of missing) console.error(`  ${loginCommand(a, opts.bench)}`);
    return 3;
  }

  setQm(opts.bench, opts.withQm);
  const dir = opts.results || path.join(EVAL_DIR, 'results', `${stamp()}-${opts.withQm ? 'with' : 'without'}-qm`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) { console.error(`Refusing to write into the non-empty ${dir}`); return 2; }
  const summary = { started: new Date().toISOString(), set: opts.set, withQm: opts.withQm, concurrency: opts.concurrency, timeoutSeconds: opts.timeout,
    versions: { claude: version('claude'), codex: version('codex') }, agents: {} };
  for (const agent of opts.agents) {
    const S = { runs: 0, ok: 0, failed: 0, incomplete: 0, timedOut: 0, wallMs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    const t0 = Date.now();
    await pool(requests, opts.concurrency, async (req) => {
      const { lines, meta } = await runOne(agent, req, opts);
      const out = path.join(dir, agent, req.lang, `${req.id}.jsonl`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${lines.join('\n')}\n${JSON.stringify(meta)}\n`);
      const u = usageOf(lines);
      S.runs++;
      if (meta.ok) S.ok++;
      else {
        const a = analyzeTranscript(parseJsonl(lines.join('\n')));
        if (a.declared || a.choice.length) S.incomplete++; else S.failed++;
      } if (meta.error === 'timeout') S.timedOut++;
      S.costUsd += u.costUsd; S.inputTokens += u.inputTokens; S.outputTokens += u.outputTokens;
      console.log(`${agent} ${req.lang}/${req.id}: ${meta.ok ? 'ok' : meta.error} (${Math.round(meta.durationMs / 1000)}s)`);
    });
    S.wallMs = Date.now() - t0; S.costUsd = Math.round(S.costUsd * 1000) / 1000;
    summary.agents[agent] = S;
  }
  summary.finished = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`results: ${dir}`);
  spawnSync(process.execPath, [path.join(EVAL_DIR, 'score.mjs'), dir], { stdio: 'inherit' });
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(1); });
}
