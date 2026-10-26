// Scores agent transcripts against the expected tools of each request.
// Library: scoreRun(transcripts, requests, {aliases}). CLI: node eval/score.mjs <results-dir> [--requests <file>] [--bench <dir>].
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BENCH, benchPaths } from './bench.mjs';

const SELF = new Set(['urequartermaster']);
const norm = (s) => String(s).trim().toLowerCase().replace(/_/g, '-');
const bare = (s) => norm(s).split(':').pop();

/**
 * "→ Using: a + MCP b" -> [{name, kind}] (kind "any" when no MCP/CLI/plugin prefix is given),
 * [] for "→ Using: none", null when the line is not a declaration. Placeholders like <tool> are dropped.
 */
export function parseDeclaredLine(line) {
  const m = /^\s*(?:→|->)\s*[^:]+:\s*(.+)$/.exec(line);
  if (!m) return null;
  const strip = (x) => x.trim().replace(/^[`*"']+|[`*"'.]+$/g, '').trim();
  const out = [];
  // details in brackets ("ga4 (run-report, list)") are not tool names
  for (let part of m[1].replace(/\s*\([^)]*\)/g, (x) => (/^\s*\((skill|mcp|cli|plugin)\)$/i.test(x) ? ` ${x.trim().slice(1, -1)}` : '')).split(' + ')) {
    part = strip(part);
    let kind = 'any';
    const p = /^(MCP|CLI|plugin)\s+(.+)$/i.exec(part);
    if (p) { kind = p[1].toLowerCase(); part = strip(p[2]); }
    // "shadcn mcp", "shadcn skill": the kind written after the name
    const s2 = /^(.+?)\s+(MCP|CLI|plugin|skill)$/i.exec(part);
    if (kind === 'any' && s2) { kind = s2[2].toLowerCase() === 'skill' ? 'any' : s2[2].toLowerCase(); part = strip(s2[1]); }
    // a full MCP tool name (mcp__server__tool) names its server
    const q = /^mcp__(.+?)(?:__|$)/.exec(part);
    if (q) { kind = 'mcp'; part = q[1]; }
    if (!part || /[<>]/.test(part) || /^(none|nessuno|ninguno|aucun|keine?|nenhum)$/i.test(part)) continue;
    out.push({ name: part, kind });
  }
  return out;
}

export function parseJsonl(text) {
  const events = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try { events.push(JSON.parse(t)); } catch { /* broken line */ }
  }
  return events;
}

const QM_LOAD = /\bqm(?:\.mjs)?["']?\s+load\s+["']?([^\s"';|&)]+)/g;
const READER = /(?:^|[\s;|&("'])(?:cat|sed|head|tail|less|more|bat|nl|type|Get-Content|gc)\b/;
const SKILL_FILE = /[\\/]skills[\\/]([^\\/\s"']+)[\\/]SKILL\.md/g;

/**
 * Reads a transcript: the tools it chose and whether it declared them.
 * Choice = tools of the LAST declared line + tool actions (Skill calls, qm load, skill file reads, MCP calls).
 * @returns {{ choice: {name:string, kind:string, via:string}[], declared: boolean }}
 */
export function analyzeTranscript(events) {
  const found = new Map();
  let lastDeclared = null;
  const add = (name, kind, via) => {
    if (!name || /[<>]/.test(name) || SELF.has(bare(name))) return;
    const b = bare(name);
    const anyKey = `${b}|any`;
    if (kind === 'any') { if ([...found.keys()].some((k) => k.startsWith(`${b}|`))) return; }
    else found.delete(anyKey);
    const key = `${b}|${kind}`;
    if (!found.has(key)) found.set(key, { name: norm(name), kind, via });
  };
  const text = (t) => {
    for (const line of String(t || '').split(/\r?\n/)) {
      const d = parseDeclaredLine(line);
      if (d) lastDeclared = d;
    }
  };
  const command = (cmd) => {
    const s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '');
    for (const m of s.matchAll(QM_LOAD)) add(m[1], 'skill', 'qm-load');
    if (READER.test(s)) for (const m of s.matchAll(SKILL_FILE)) add(m[1], 'skill', 'skill-read');
  };
  const toolUse = (name, input) => {
    input = input || {};
    if (name === 'Skill') add(input.skill || input.name, 'skill', 'skill-tool');
    else if (name === 'Bash') command(input.command);
    else if (name === 'Read') { for (const m of String(input.file_path || '').matchAll(SKILL_FILE)) add(m[1], 'skill', 'skill-read'); }
    else if (/^mcp__/.test(name || '')) add(name.split('__')[1], 'mcp', 'mcp-call');
  };
  const item = (it) => {
    if (!it || typeof it !== 'object') return;
    const ty = it.type;
    if (ty === 'agent_message' || ty === 'assistant_message') text(it.text || it.message);
    else if (ty === 'command_execution' || ty === 'local_shell_call') command(it.command || (it.action && it.action.command));
    else if (ty === 'mcp_tool_call') add(it.server, 'mcp', 'mcp-call');
  };
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const b of e.message.content) {
        if (b.type === 'text') text(b.text);
        else if (b.type === 'tool_use') toolUse(b.name, b.input);
      }
    }
    if (e.item) item(e.item);
    if (e.msg && e.msg.type === 'agent_message') text(e.msg.message);
    if (e.msg && e.msg.type === 'exec_command_begin') command(e.msg.command);
  }
  for (const d of lastDeclared || []) add(d.name, d.kind, 'declared');
  return { choice: [...found.values()], declared: lastDeclared !== null };
}

/** Tools chosen by one transcript (see analyzeTranscript). */
export const extractChoice = (events) => analyzeTranscript(events).choice;

function matches(expected, c) {
  const i = expected.indexOf(':');
  const kind = i < 0 ? 'skill' : expected.slice(0, i).toLowerCase();
  const name = norm(i < 0 ? expected : expected.slice(i + 1));
  if (kind === 'plugin') {
    if (c.name.startsWith(`${name}:`)) return c.kind === 'skill' || c.kind === 'any' || c.kind === 'plugin';
    return c.name === name && (c.kind === 'plugin' || c.kind === 'any');
  }
  // a CLI is often called by its project name: "wp-cli" for wp
  const cn = kind === 'cli' ? bare(c.name).replace(/-cli$/, '') : bare(c.name);
  if (cn !== bare(name)) return false;
  return c.kind === kind || c.kind === 'any';
}

/** An expected element may list alternatives joined by "|": satisfied when any one of them was chosen. */
export const alternatives = (x) => String(x).split('|').map((a) => a.trim());

/** Throws on an empty alternative ("a|", "|b") or an empty id/kind around ":". */
export function validateExpectedId(x) {
  for (const part of alternatives(x)) {
    const t = part.trim();
    const i = t.indexOf(':');
    if (!t || (i >= 0 && (!t.slice(0, i).trim() || !t.slice(i + 1).trim()))) throw new Error(`invalid expected tool id "${x}"`);
  }
}

const matchesAny = (x, c) => alternatives(x).some((a) => matches(a, c));

const pct1 = (c, t) => (t ? Math.round((c / t) * 1000) / 10 : 0);

/**
 * @param {{id: string, lang?: string, jsonl?: string, events?: object[]}[]} transcripts  one agent's runs
 * @param {{id: string, lang: string, expected: string[]}[]} requests  expanded requests (one per language)
 */
/**
 * Claude Code names a skill after its folder, Codex after the frontmatter `name`: when they differ
 * (folder "composition-patterns", name "vercel-composition-patterns") both mean the same skill.
 * @returns {Map<string,string>} folder name -> frontmatter name, normalised
 */
export function skillAliases(home) {
  const map = new Map();
  for (const root of [path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills'), path.join(home, '.codex', 'skills')]) {
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      let text;
      try { text = fs.readFileSync(path.join(root, d, 'SKILL.md'), 'utf8'); } catch { continue; }
      const m = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(text);
      if (m && norm(m[1]) !== norm(d)) map.set(norm(d), norm(m[1]));
    }
  }
  return map;
}

export function scoreRun(transcripts, requests, { aliases = new Map() } = {}) {
  const byKey = new Map(transcripts.map((t) => [`${t.lang || ''}/${t.id}`, t]));
  const perLang = {};
  const extras = {};
  const failures = [];
  const incomplete = [];
  for (const r of requests) {
    const L = (perLang[r.lang] ||= { correct: 0, total: 0, pct: 0 });
    const X = (extras[r.lang] ||= { requests: 0, tools: 0 });
    L.total++;
    const tr = byKey.get(`${r.lang}/${r.id}`) || byKey.get(`/${r.id}`);
    if (!tr) { failures.push({ id: r.id, lang: r.lang, expected: r.expected, chosen: [], error: 'no transcript' }); continue; }
    const events = tr.events || parseJsonl(tr.jsonl || '');
    const meta = events.find((e) => e && e.type === 'qm_meta');
    const { choice: raw, declared } = analyzeTranscript(events);
    const chosen = raw.map((c) => (c.kind !== 'mcp' && c.kind !== 'cli' && aliases.has(norm(c.name)) ? { ...c, name: aliases.get(norm(c.name)) } : c));
    const expected = r.expected || [];
    if (meta && meta.ok === false) {
      // A run cut short (max turns, timeout, non-zero exit) that still declared or used tools is scored on that.
      if (!declared && chosen.length === 0) {
        failures.push({ id: r.id, lang: r.lang, expected, chosen: [], error: meta.error || 'run failed' });
        continue;
      }
      incomplete.push({ id: r.id, lang: r.lang, error: meta.error || 'run failed' });
    }
    const extra = chosen.filter((c) => !expected.some((x) => matchesAny(x, c)));
    if (extra.length) { X.requests++; X.tools += extra.length; }
    const ok = expected.length === 0 ? chosen.length === 0 : expected.every((x) => chosen.some((c) => matchesAny(x, c)));
    if (ok) L.correct++;
    else failures.push({ id: r.id, lang: r.lang, expected, chosen: chosen.map((c) => c.name) });
  }
  for (const L of Object.values(perLang)) L.pct = pct1(L.correct, L.total);
  return { perLang, failures, extras, incomplete };
}

const LANG_ORDER = ['it', 'en', 'es', 'fr', 'de', 'pt'];

/** Plan format {id, category, expected, prompts:{lang:text}, group?} -> one entry per language present in prompts. */
export function expandRequests(list) {
  const out = [];
  for (const r of list) {
    const langs = Object.keys(r.prompts || {}).sort((a, b) => LANG_ORDER.indexOf(a) - LANG_ORDER.indexOf(b));
    for (const lang of langs) {
      out.push({ id: r.id, lang, prompt: r.prompts[lang], expected: r.expected || [], category: r.category, group: r.group, ...(r.placeholder ? { placeholder: true } : {}) });
    }
  }
  return out;
}

export function loadRequests(file) {
  const list = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  for (const r of list) for (const x of r.expected || []) validateExpectedId(x);
  return expandRequests(list);
}

function loadTranscripts(dir) {
  const out = {};
  for (const agent of fs.readdirSync(dir)) {
    const ad = path.join(dir, agent);
    if (!fs.statSync(ad).isDirectory()) continue;
    out[agent] = [];
    for (const lang of fs.readdirSync(ad)) {
      const ld = path.join(ad, lang);
      if (!fs.statSync(ld).isDirectory()) continue;
      for (const f of fs.readdirSync(ld)) {
        if (f.endsWith('.jsonl')) out[agent].push({ id: f.slice(0, -6), lang, jsonl: fs.readFileSync(path.join(ld, f), 'utf8') });
      }
    }
  }
  return out;
}

function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('usage: node eval/score.mjs <results-dir> [--requests <file>] [--bench <dir>]'); return 2; }
  const ri = argv.indexOf('--requests');
  let reqFile = ri >= 0 ? argv[ri + 1] : null;
  if (!reqFile) {
    const sum = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    reqFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'requests', `${sum.set}.jsonl`);
  }
  const requests = loadRequests(reqFile);
  const bi = argv.indexOf('--bench');
  const aliases = skillAliases(benchPaths(bi >= 0 ? path.resolve(argv[bi + 1]) : DEFAULT_BENCH).home);
  const all = loadTranscripts(dir);
  let worst = 100;
  const summary = {};
  for (const [agent, transcripts] of Object.entries(all)) {
    // only requests that were actually run for this agent (a partial run must not look like failures)
    const ran = new Set(transcripts.map((t) => `${t.lang}/${t.id}`));
    const rs = requests.filter((r) => ran.has(`${r.lang}/${r.id}`));
    const res = scoreRun(transcripts, rs, { aliases });
    summary[agent] = res;
    console.log(`\n${agent}`);
    console.log('lang   correct/total    pct   extras(req/tools)');
    for (const lang of Object.keys(res.perLang).sort()) {
      const l = res.perLang[lang]; const x = res.extras[lang];
      worst = Math.min(worst, l.pct);
      console.log(`${lang.padEnd(6)} ${`${l.correct}/${l.total}`.padEnd(15)} ${String(l.pct).padStart(5)}%  ${x.requests}/${x.tools}`);
    }
    if (res.incomplete.length) console.log(`incomplete runs (cut short, scored on their choice): ${res.incomplete.length}`);
    if (res.failures.length) {
      console.log('failures:');
      for (const f of res.failures) console.log(`  [${f.lang}] ${f.id}: expected ${JSON.stringify(f.expected)} chosen ${JSON.stringify(f.chosen)}${f.error ? ` (${f.error})` : ''}`);
    }
  }
  try { fs.writeFileSync(path.join(dir, 'scores.json'), JSON.stringify(summary, null, 2)); } catch { /* read-only dir */ }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
