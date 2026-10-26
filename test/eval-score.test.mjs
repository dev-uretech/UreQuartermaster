import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRun, extractChoice, parseDeclaredLine, expandRequests, loadRequests, skillAliases } from '../eval/score.mjs';
import { claudeArgs, INSTRUCTION } from '../eval/run.mjs';
import { benchEnv, benchKeychainCommands } from '../eval/bench.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const j = (...events) => events.map((e) => JSON.stringify(e)).join('\n');
// Claude Code stream-json shapes
const claudeText = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const claudeTool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] } });
// Codex exec --json shapes
const codexMsg = (text) => ({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } });
const codexCmd = (command) => ({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command, exit_code: 0 } });

const names = (c) => c.map((x) => x.name).sort();

test('parseDeclaredLine reads "→ Uso: a + b" and strips MCP/CLI/plugin prefixes', () => {
  assert.deepEqual(parseDeclaredLine('→ Uso: site-speed-audit + MCP pagespeed-data'), ['site-speed-audit', 'pagespeed-data'].map((n, i) => ({ name: n, kind: i ? 'mcp' : 'any' })));
  assert.deepEqual(parseDeclaredLine('-> Usando: sheet-builder + CLI cloudctl + plugin toolkit'), [
    { name: 'sheet-builder', kind: 'any' }, { name: 'cloudctl', kind: 'cli' }, { name: 'toolkit', kind: 'plugin' },
  ]);
  assert.deepEqual(parseDeclaredLine('  → Using: doc-converter'), [{ name: 'doc-converter', kind: 'any' }]);
  assert.equal(parseDeclaredLine('Uso: a + b'), null);
  assert.equal(parseDeclaredLine('see → Uso: a'), null);
});

test('extracts the declared line from Claude text and from Codex agent messages', () => {
  const c = extractChoice([claudeText('Cerco gli strumenti.\n→ Uso: pdf + MCP stripe\nFatto.')]);
  assert.deepEqual(names(c), ['pdf', 'stripe']);
  const x = extractChoice([codexMsg('→ Using: seo-audit')]);
  assert.deepEqual(names(x), ['seo-audit']);
});

test('extracts a Skill tool call, keeping plugin:skill (matched by bare name later) and ignoring urequartermaster itself', () => {
  const c = extractChoice([
    claudeTool('Skill', { skill: 'urequartermaster:urequartermaster' }),
    claudeTool('Skill', { skill: 'pdf' }),
    claudeTool('Skill', { skill: 'toolkit:doc-converter' }),
  ]);
  assert.deepEqual(names(c), ['pdf', 'toolkit:doc-converter']);
});

test('extracts executed qm load from Bash (Claude) and shell commands (Codex), not from text', () => {
  const a = extractChoice([claudeTool('Bash', { command: 'node "/h/.agents/skills/urequartermaster/scripts/qm.mjs" load seo-audit' })]);
  assert.deepEqual(names(a), ['seo-audit']);
  const b = extractChoice([codexCmd('/bin/zsh -lc \'node "/x/qm.mjs" load toolkit:pdf-merge\'')]);
  assert.deepEqual(names(b), ['toolkit:pdf-merge']);
  const none = extractChoice([claudeText('I will run: qm load seo-audit')]);
  assert.deepEqual(none, []);
});

test('extracts MCP tool calls as the server name (Claude and Codex)', () => {
  const a = extractChoice([claudeTool('mcp__google-search-console__list_sites', {})]);
  assert.deepEqual(a.map((x) => [x.name, x.kind]), [['google-search-console', 'mcp']]);
  const b = extractChoice([{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'stripe', tool: 'list_charges' } }]);
  assert.deepEqual(names(b), ['stripe']);
});

const reqs = [
  { id: 'a', lang: 'it', expected: ['skill:pdf', 'mcp:stripe'] },
  { id: 'b', lang: 'it', expected: [] },
  { id: 'c', lang: 'en', expected: ['skill:seo-audit'] },
  { id: 'd', lang: 'en', expected: ['plugin:toolkit'] },
  { id: 'e', lang: 'en', expected: ['cli:gh'] },
];

test('scoreRun: all-expected rule, empty expected, per-language percentages, failures, extras', () => {
  const t = [
    { id: 'a', jsonl: j(claudeText('→ Uso: pdf + MCP stripe + hubspot')) },            // correct, 1 extra
    { id: 'b', jsonl: j(claudeText('Ciao!')) },                                        // correct: nothing chosen
    { id: 'c', jsonl: j(claudeTool('Skill', { skill: 'SEO-Audit' })) },                // correct (case-insensitive)
    { id: 'd', jsonl: j(claudeText('→ Using: toolkit:doc-converter')) },               // plugin matched through its skill
    { id: 'e', jsonl: j(claudeText('→ Using: glab')) },                                // wrong
  ];
  const r = scoreRun(t, reqs);
  assert.deepEqual(r.perLang.it, { correct: 2, total: 2, pct: 100 });
  assert.deepEqual(r.perLang.en, { correct: 2, total: 3, pct: 66.7 });
  assert.deepEqual(r.failures, [{ id: 'e', lang: 'en', expected: ['cli:gh'], chosen: ['glab'] }]);
  assert.deepEqual(r.extras.it, { requests: 1, tools: 1 });
  assert.equal(r.extras.en.tools, 1); // glab on the failed request
});

test('scoreRun: partial choice fails; empty expected with a chosen tool fails; missing transcript fails', () => {
  const t = [
    { id: 'a', jsonl: j(claudeText('→ Uso: pdf')) },
    { id: 'b', jsonl: j(claudeText('→ Uso: pdf')) },
  ];
  const r = scoreRun(t, reqs.slice(0, 3));
  assert.equal(r.perLang.it.correct, 0);
  assert.equal(r.perLang.en.correct, 0);
  assert.deepEqual(r.failures.map((f) => f.id), ['a', 'b', 'c']);
  assert.equal(r.failures[2].error, 'no transcript');
});

test('scoreRun: a run that errored or timed out is a failure even when expected is empty', () => {
  const t = [{ id: 'b', jsonl: j(claudeText('Ciao'), { type: 'qm_meta', ok: false, error: 'timeout' }) }];
  const r = scoreRun(t, [reqs[1]]);
  assert.equal(r.perLang.it.correct, 0);
  assert.equal(r.failures[0].error, 'timeout');
});

test('scoreRun accepts events arrays, ignores broken JSON lines and counts a tool once', () => {
  const t = [{ id: 'c', jsonl: `not json\n${j(claudeText('→ Using: seo-audit'), claudeTool('Skill', { skill: 'seo-audit' }))}` }];
  const r = scoreRun(t, [reqs[2]]);
  assert.equal(r.perLang.en.pct, 100);
  assert.equal(r.extras.en.tools, 0);
  const t2 = [{ id: 'c', events: [claudeText('→ Using: seo-audit')] }];
  assert.equal(scoreRun(t2, [reqs[2]]).perLang.en.correct, 1);
});

test('expected skill name matches a plugin-qualified chosen name and MCP names with underscores', () => {
  const t = [
    { id: 'x', jsonl: j(claudeTool('Skill', { skill: 'toolkit:doc-converter' }), claudeTool('mcp__google_search_console__list_sites', {})) },
  ];
  const r = scoreRun(t, [{ id: 'x', lang: 'de', expected: ['skill:doc-converter', 'mcp:google-search-console'] }]);
  assert.equal(r.perLang.de.pct, 100);
});

const claudeRead = (file_path) => claudeTool('Read', { file_path });

test('"→ Using: none" and placeholders are no choice', () => {
  assert.deepEqual(parseDeclaredLine('→ Using: none'), []);
  assert.deepEqual(parseDeclaredLine('→ Using: <tool> + <tool>'), []);
  assert.deepEqual(extractChoice([claudeText('→ Using: none')]), []);
  const r = scoreRun([{ id: 'b', lang: 'it', jsonl: j(claudeText('→ Using: none')) }], [reqs[1]]);
  assert.equal(r.perLang.it.correct, 1);
});

test('only the LAST declared line counts, tool actions are added', () => {
  const c = extractChoice([claudeText('→ Using: a-tool'), claudeText('→ Using: b-tool'), claudeTool('Skill', { skill: 'c-tool' })]);
  assert.deepEqual(names(c), ['b-tool', 'c-tool']);
});

test('shell reads of a skill SKILL.md count (Codex), not urequartermaster itself', () => {
  const a = extractChoice([codexCmd('/bin/zsh -lc "cat /h/.agents/skills/pdf/SKILL.md"')]);
  assert.deepEqual(a.map((x) => [x.name, x.via]), [['pdf', 'skill-read']]);
  assert.deepEqual(names(extractChoice([codexCmd('sed -n 1,80p /h/.agents/skills/seo-audit/SKILL.md')])), ['seo-audit']);
  assert.deepEqual(names(extractChoice([codexCmd('powershell Get-Content C:\\Users\\x\\.agents\\skills\\docx\\SKILL.md')])), ['docx']);
  assert.deepEqual(extractChoice([codexCmd('cat /h/.agents/skills/urequartermaster/SKILL.md')]), []);
  assert.deepEqual(extractChoice([codexCmd('ls /h/.agents/skills/pdf/SKILL.md')]), []);
  assert.deepEqual(names(extractChoice([claudeRead('/h/.claude/skills/xlsx/SKILL.md')])), ['xlsx']);
});

test('kind is checked: skill:x is not satisfied by MCP x; an unprefixed declared name is', () => {
  const rq = [{ id: 'k', lang: 'en', expected: ['skill:stripe'] }];
  assert.equal(scoreRun([{ id: 'k', lang: 'en', jsonl: j(claudeText('→ Using: MCP stripe')) }], rq).perLang.en.correct, 0);
  assert.equal(scoreRun([{ id: 'k', lang: 'en', jsonl: j(claudeText('→ Using: stripe')) }], rq).perLang.en.correct, 1);
  assert.equal(scoreRun([{ id: 'k', lang: 'en', jsonl: j(claudeTool('mcp__stripe__list_customers', {})) }], rq).perLang.en.correct, 0);
});

test('same tool by several routes is counted once (dedupe by bare name)', () => {
  const c = extractChoice([claudeText('→ Using: pdf'), claudeTool('Skill', { skill: 'pdf' }), claudeTool('Bash', { command: 'qm load pdf' })]);
  assert.equal(c.length, 1);
});

test('a run cut short but with a declared line or choice is scored on it and reported as incomplete', () => {
  const t = [
    { id: 'a', lang: 'it', jsonl: j(claudeText('→ Uso: pdf + stripe'), { type: 'qm_meta', ok: false, error: 'exit 1' }) },
    { id: 'c', lang: 'en', jsonl: j(claudeText('thinking'), { type: 'qm_meta', ok: false, error: 'timeout' }) },
  ];
  const r = scoreRun(t, [reqs[0], reqs[2]]);
  assert.equal(r.perLang.it.correct, 1);
  assert.deepEqual(r.incomplete.map((x) => x.id), ['a']);
  assert.equal(r.failures[0].error, 'timeout');
});

test('the same request id in two languages is scored per language', () => {
  const rq = [{ id: 'z', lang: 'it', expected: ['skill:pdf'] }, { id: 'z', lang: 'en', expected: ['skill:pdf'] }];
  const t = [{ id: 'z', lang: 'it', jsonl: j(claudeText('→ Uso: pdf')) }, { id: 'z', lang: 'en', jsonl: j(claudeText('→ Using: none')) }];
  const r = scoreRun(t, rq);
  assert.equal(r.perLang.it.pct, 100);
  assert.equal(r.perLang.en.pct, 0);
});

test('requests use the plan format and expand to one entry per language present in prompts', () => {
  const list = [{ id: 'r1', category: 'docs', expected: ['skill:pdf'], group: 'g', prompts: { en: 'E', it: 'I' } }];
  assert.deepEqual(expandRequests(list), [
    { id: 'r1', lang: 'it', prompt: 'I', expected: ['skill:pdf'], category: 'docs', group: 'g' },
    { id: 'r1', lang: 'en', prompt: 'E', expected: ['skill:pdf'], category: 'docs', group: 'g' },
  ]);
  const dev = loadRequests(fileURLToPath(new URL('../eval/requests/dev.jsonl', import.meta.url)));
  assert.equal(dev.length, 180); // 30 requests x 6 languages
  assert.deepEqual([...new Set(dev.map((r) => r.lang))].sort(), ['de', 'en', 'es', 'fr', 'it', 'pt']);
});

test('the instruction is neutral: no skill-only wording, declares "→ Using:" and allows none', () => {
  assert.match(INSTRUCTION, /skills, MCP servers, plugins, command-line programs/);
  assert.match(INSTRUCTION, /→ Using: <tool> \+ <tool>/);
  assert.match(INSTRUCTION, /→ Using: none/);
});

test('Claude runs with least privilege: default mode, explicit allowlist, denied write/web, strict MCP', () => {
  const a = claudeArgs({ bench: '/b', withQm: true, servers: ['stripe', 'ga4'], cwd: '/tmp/run-1' });
  const at = (f) => a.slice(a.indexOf(f) + 1);
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'default');
  assert.ok(!a.includes('bypassPermissions'));
  assert.ok(!a.includes('--max-budget-usd'));
  assert.ok(a.includes('--strict-mcp-config'));
  assert.equal(a[a.indexOf('--mcp-config') + 1], path.join('/b', 'mcp-claude.json'));
  const allowed = at('--allowedTools').slice(0, at('--allowedTools').indexOf('--disallowedTools'));
  assert.ok(allowed.includes('mcp__stripe') && allowed.includes('mcp__ga4') && allowed.includes('Skill'));
  const bashAllowed = allowed.filter((r) => r.startsWith('Bash('));
  assert.ok(bashAllowed.length && bashAllowed.every((r) => /^Bash\(node "?[^ ]*qm\.mjs"? (search|load|list):\*\)$/.test(r)));
  for (const c of ['search', 'load', 'list']) assert.ok(bashAllowed.some((r) => r.includes(` ${c}:`)));
  const bashDenied = at('--disallowedTools').filter((r) => r.startsWith('Bash('));
  for (const c of ['add', 'sync', 'init', 'park', 'unpark', 'update', 'rollback', 'index', 'doctor']) {
    assert.ok(bashDenied.some((r) => r.includes(`qm.mjs ${c}:`)) && bashDenied.some((r) => r.includes(`qm.mjs" ${c}:`)), c);
  }
  assert.ok(!allowed.some((x) => x === 'Bash' || x === 'Write' || x === 'Edit'));
  const denied = at('--disallowedTools');
  for (const t of ['Write', 'Edit', 'WebFetch', 'WebSearch']) assert.ok(denied.includes(t));
  assert.ok(a.includes('--plugin-dir'));
  // Read is path-scoped; Glob/Grep (not scopable) are denied, never allowed
  const reads = allowed.filter((r) => /^(Read|Glob|Grep)\b/.test(r));
  assert.ok(reads.length >= 2 && reads.every((r) => /^Read\(\/\/.+\/\*\*\)$/.test(r)));
  assert.ok(reads.some((r) => r.includes('//b/**')) && reads.some((r) => r.includes('//tmp/run-1/**')));
  assert.ok(!allowed.some((r) => r === 'Read' || r === 'Glob' || r === 'Grep'));
  assert.ok(denied.includes('Glob') && denied.includes('Grep'));
  assert.ok(denied.some((r) => /^Read\(\/\/b\/home\/\.claude\/\.credentials\.json\)$/.test(r)));
  assert.ok(!claudeArgs({ bench: '/b', withQm: false, servers: [], cwd: '/tmp/run-1' }).includes('--plugin-dir'));
  assert.ok(!claudeArgs({ bench: '/b', withQm: false, servers: [], cwd: '/tmp/run-1' }).some((x) => /qm\.mjs/.test(x)));
});

test('benchEnv is an allowlist: secrets are dropped unless explicitly passed', () => {
  process.env.GITHUB_TOKEN = 'x'; process.env.AWS_SECRET_ACCESS_KEY = 'x'; process.env.ANTHROPIC_API_KEY = 'x'; process.env.LC_ALL = 'C';
  try {
    const e = benchEnv(path.join(os.tmpdir(), 'bench-x'));
    for (const k of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY']) assert.equal(e[k], undefined);
    assert.equal(e.LC_ALL, 'C');
    assert.ok(e.UREQM_HOME && e.CLAUDE_CONFIG_DIR && e.CODEX_HOME && e.UREQM_NO_UPDATE === '1');
    assert.equal(benchEnv(os.tmpdir(), { pass: ['ANTHROPIC_API_KEY'] }).ANTHROPIC_API_KEY, 'x');
    assert.ok(Object.keys(e).every((k) => /^(PATH|HOME|USER|LOGNAME|USERPROFILE|TMPDIR|TEMP|TMP|LANG|LC_.*|TERM|SystemRoot|ComSpec|PATHEXT|UREQM_HOME|UREQM_NO_UPDATE|CLAUDE_CONFIG_DIR|CODEX_HOME|DISABLE_AUTOUPDATER)$/.test(k)));
  } finally { delete process.env.GITHUB_TOKEN; delete process.env.AWS_SECRET_ACCESS_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.LC_ALL; }
});

const altT = (...tools) => [{ id: 'a', lang: 'en', jsonl: j(claudeText(`→ Using: ${tools.join(' + ')}`)) }];
const altR = (...expected) => [{ id: 'a', lang: 'en', expected }];

test('alternatives: either side satisfies the element', () => {
  for (const t of ['MCP github', 'CLI gh']) {
    const r = scoreRun(altT(t), altR('mcp:github|cli:gh'));
    assert.equal(r.perLang.en.correct, 1, t);
    assert.deepEqual(r.extras.en, { requests: 0, tools: 0 });
  }
});

test('alternatives: both sides chosen is correct and not an extra', () => {
  const r = scoreRun(altT('MCP github', 'CLI gh'), altR('mcp:github|cli:gh'));
  assert.equal(r.perLang.en.correct, 1);
  assert.deepEqual(r.extras.en, { requests: 0, tools: 0 });
});

test('alternatives: neither side is wrong; an unrelated tool is an extra', () => {
  const r = scoreRun(altT('CLI glab'), altR('mcp:github|cli:gh'));
  assert.equal(r.perLang.en.correct, 0);
  assert.deepEqual(r.extras.en, { requests: 1, tools: 1 });
});

test('alternatives: mixed with a plain element', () => {
  assert.equal(scoreRun(altT('pdf', 'CLI gh'), altR('skill:pdf', 'mcp:github|cli:gh')).perLang.en.correct, 1);
  assert.equal(scoreRun(altT('CLI gh'), altR('skill:pdf', 'mcp:github|cli:gh')).perLang.en.correct, 0);
});

test('loadRequests accepts "|"-joined ids and rejects empty parts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-req-'));
  const write = (expected) => { const f = path.join(dir, 'r.jsonl'); fs.writeFileSync(f, `${JSON.stringify({ id: 'x', expected, prompts: { en: 'p' } })}\n`); return f; };
  assert.deepEqual(loadRequests(write(['mcp:github|cli:gh']))[0].expected, ['mcp:github|cli:gh']);
  for (const bad of ['a|', '|b', 'mcp:a|', 'a||b']) assert.throws(() => loadRequests(write([bad])), /invalid expected tool id/, bad);
});

test('benchKeychainCommands: full setup when missing, unlock and reselect when present; all inside the bench home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-kc-'));
  const k = path.join(home, 'Library', 'Keychains', 'bench.keychain-db');
  const cmds = benchKeychainCommands(home);
  assert.deepEqual(cmds.map((c) => c[0]), ['create-keychain', 'set-keychain-settings', 'unlock-keychain', 'list-keychains', 'default-keychain']);
  assert.ok(cmds.every((c) => c.includes(k)));
  fs.mkdirSync(path.dirname(k), { recursive: true });
  fs.writeFileSync(k, '');
  assert.deepEqual(benchKeychainCommands(home).map((c) => c[0]), ['unlock-keychain', 'list-keychains', 'default-keychain']);
});

test('alternatives are trimmed', () => {
  assert.equal(scoreRun(altT('CLI gh'), altR('mcp:github | cli:gh')).perLang.en.correct, 1);
});

test('parseDeclaredLine maps a full MCP tool name (mcp__server__tool) to its server', () => {
  assert.deepEqual(parseDeclaredLine('→ Using: mcp__hubspot__list_deals + mcp__google-search-console__query'),
    [{ name: 'hubspot', kind: 'mcp' }, { name: 'google-search-console', kind: 'mcp' }]);
});

test('an MCP server named as mcp__server and a CLI named <bin>-cli are recognised', () => {
  assert.deepEqual(parseDeclaredLine('→ Using: mcp__hubspot'), [{ name: 'hubspot', kind: 'mcp' }]);
  const reqs = [{ id: 'x', lang: 'it', prompt: 'p', expected: ['cli:wp'] }];
  const tr = [{ id: 'x', lang: 'it', agent: 'claude', events: [{ type: 'assistant', message: { content: [{ type: 'text', text: '→ Using: wp-cli' }] } }] }];
  assert.equal(scoreRun(tr, reqs).perLang.it.correct, 1);
});

test('skillAliases: a skill chosen by folder name counts as its frontmatter name', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-alias-'));
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'composition-patterns'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'composition-patterns', 'SKILL.md'), '---\nname: vercel-composition-patterns\ndescription: x\n---\n');
  const aliases = skillAliases(home);
  assert.equal(aliases.get('composition-patterns'), 'vercel-composition-patterns');
  const reqs = [{ id: 'x', lang: 'en', prompt: 'p', expected: ['skill:vercel-composition-patterns'] }];
  const tr = [{ id: 'x', lang: 'en', events: [{ type: 'assistant', message: { content: [{ type: 'text', text: '→ Using: composition-patterns' }] } }] }];
  assert.equal(scoreRun(tr, reqs).perLang.en.correct, 0);
  assert.equal(scoreRun(tr, reqs, { aliases }).perLang.en.correct, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('parseDeclaredLine ignores details in brackets and reads a kind written after the name', () => {
  assert.deepEqual(parseDeclaredLine('→ Using: google-analytics-official (get_account_summaries, run_report)'), [{ name: 'google-analytics-official', kind: 'any' }]);
  assert.deepEqual(parseDeclaredLine('→ Using: meta-ads mcp (list_campaigns, pause_campaign)'), [{ name: 'meta-ads', kind: 'mcp' }]);
  assert.deepEqual(parseDeclaredLine('→ Using: shadcn (skill) + shadcn mcp'), [{ name: 'shadcn', kind: 'any' }, { name: 'shadcn', kind: 'mcp' }]);
});
