import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectUsage, serverOfTool, toolKey } from '../skills/urequartermaster/scripts/lib/mcp/usage.mjs';
import { commitClaudeJson, readClaudeJson, mcpHash } from '../skills/urequartermaster/scripts/lib/mcp/claude-config.mjs';

const QM = fileURLToPath(new URL('../skills/urequartermaster/scripts/qm.mjs', import.meta.url));
const POSIX = process.platform !== 'win32';
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof s === 'string' ? s : JSON.stringify(s, null, 2)); };
const mode = (f) => fs.statSync(f).mode & 0o777;

// Secret-shaped values are assembled at runtime so the source never holds a literal token.
const j = (...a) => a.join('');
const SECRETS = {
  envToken: j('sk-', 'live-', 'Q7vR2mX9kL4pT8wZ1nB6'),
  argToken: j('ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4'),
  urlKey: j('k1', 'query', 'secret', '77'),
  header: j('hdr', '-secret-', '4242'),
  dbPass: j('hunter', '2', 'Pa55word'),
};
const ALL = Object.values(SECRETS);
const assertClean = (text, what) => {
  for (const s of ALL) assert.ok(!text.includes(s), `${what}: secret leaked (${s.slice(0, 5)}…)`);
  assert.ok(!text.includes('Authorization'), `${what}: header name leaked`);
};

const DAY = 86400e3;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const line = (o) => `${JSON.stringify(o)}\n`;
const toolUse = (name, cwd, msAgo = 3600e3) => line({
  type: 'assistant', cwd, timestamp: iso(msAgo),
  message: { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'toolu_x', name, input: { q: SECRETS.dbPass } }] },
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qm-mcpm-'))); // project keys are real paths, like process.cwd()
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const p = (n) => path.join(root, 'work', n);
  const [p1, p2, p3, p4] = ['alpha', 'beta site', 'gamma', 'delta'].map(p);
  for (const d of [home, data, p1, p2, p3, p4]) fs.mkdirSync(d, { recursive: true });
  const claudeJson = path.join(home, '.claude.json');
  const doc = {
    numStartups: 42,
    tipsHistory: { a: 1 },
    mcpServers: {
      crm: { type: 'stdio', command: 'node', args: ['/opt/crm/index.js'], env: { CRM_TOKEN: SECRETS.envToken } },
      mail: { type: 'stdio', command: 'npx', args: ['-y', 'mail-mcp', `--token=${SECRETS.argToken}`], env: {} },
      unused: { type: 'stdio', command: 'uvx', args: ['unused-mcp'], env: { DB_PASSWORD: SECRETS.dbPass } },
      remote: { type: 'http', url: `https://mcp.example.com/mcp?key=${SECRETS.urlKey}`, headers: { Authorization: `Bearer ${SECRETS.header}` } },
    },
    projects: {
      [p1]: { allowedTools: [], mcpServers: { analytics: { type: 'stdio', command: 'npx', args: ['analytics-mcp'], env: { KEY: SECRETS.envToken } } } },
      [p2]: { allowedTools: [] },
    },
  };
  write(claudeJson, doc);
  if (POSIX) fs.chmodSync(claudeJson, 0o600);
  const tr = path.join(home, '.claude', 'projects');
  // crm: used in three projects; mail: in one project (main session + a subagent without cwd); unused: only
  // an old call outside the window; plus a claude.ai connector and a plugin server.
  write(path.join(tr, '-alpha', 's1.jsonl'),
    line({ type: 'user', cwd: p1, timestamp: iso(7200e3), message: { role: 'user', content: 'hi' } })
    + toolUse('mcp__crm__find_contact', p1) + toolUse('mcp__mail__send', p1) + toolUse('mcp__mail__list', p1)
    + toolUse('mcp__unused__x', p1, 40 * DAY) + toolUse('mcp__claude_ai_Gmail__search', p1)
    + toolUse('mcp__plugin_tools_browser__click', p1)
    + 'not json at all "name":"mcp__crm__broken\n');
  write(path.join(tr, '-alpha', 's1', 'subagents', 'agent-a1.jsonl'),
    line({ type: 'assistant', timestamp: iso(3000e3), message: { content: [{ type: 'tool_use', name: 'mcp__mail__read', input: {} }] } }));
  write(path.join(tr, '-beta', 's2.jsonl'), toolUse('mcp__crm__find_contact', p2) + toolUse('mcp__analytics__report', p2));
  write(path.join(tr, '-gamma', 's3.jsonl'), toolUse('mcp__crm__update', p3));
  const env = { HOME: home, USERPROFILE: home, UREQM_HOME: data, PATH: path.join(root, 'nobin'), UREQM_NO_UPDATE: '1' };
  const run = (cwd, ...args) => spawnSync(process.execPath, [QM, ...args], { env, cwd, encoding: 'utf8' });
  return { root, home, data, claudeJson, doc, p1, p2, p3, p4, tr, run };
}

test('serverOfTool picks the longest configured key and reports unknown servers', () => {
  const keys = new Map([['crm', 'crm'], ['crm_pro', 'crm pro'], ['plugin_tools_browser', 'plugin:tools:browser']]);
  assert.deepEqual(serverOfTool('mcp__crm__find', keys), { name: 'crm', known: true });
  assert.deepEqual(serverOfTool('mcp__crm_pro__find', keys), { name: 'crm pro', known: true });
  assert.deepEqual(serverOfTool('mcp__plugin_tools_browser__click', keys), { name: 'plugin:tools:browser', known: true });
  assert.deepEqual(serverOfTool('mcp__claude_ai_Gmail__search', keys), { name: 'claude_ai_Gmail', known: false });
  assert.equal(toolKey('claude.ai Slack'), 'claude_ai_Slack');
});

test('collectUsage counts calls per server and project, skips old calls, follows subagents', () => {
  const s = setup();
  const keys = new Map(['crm', 'mail', 'unused', 'remote', 'analytics'].map((n) => [n, n]));
  const u = collectUsage({ projectsDir: s.tr, since: Date.now() - 14 * DAY, keys });
  const get = (n) => Object.fromEntries(u.usage.get(n) || []);
  assert.deepEqual(get('crm'), { [s.p1]: 1, [s.p2]: 1, [s.p3]: 1 });
  assert.deepEqual(get('mail'), { [s.p1]: 3 }); // two in the session, one in its subagent (no cwd of its own)
  assert.deepEqual(get('analytics'), { [s.p2]: 1 });
  assert.equal(u.usage.has('unused'), false); // 40 days old
  assert.deepEqual([...u.unknown.keys()].sort(), ['claude_ai_Gmail', 'plugin_tools_browser']);
  assert.equal(u.files, 4);
});

test('qm mcp usage: scopes, transports and counts, never a secret', () => {
  const s = setup();
  for (const args of [['mcp', 'usage'], ['mcp', 'usage', '--json'], ['mcp', 'usage', '--days', '60']]) {
    const r = s.run(s.p1, ...args);
    assert.equal(r.status, 0, r.stderr);
    assertClean(r.stdout + r.stderr, args.join(' '));
  }
  const rep = JSON.parse(s.run(s.p1, 'mcp', 'usage', '--json').stdout);
  const row = (n) => rep.servers.find((x) => x.name === n);
  assert.equal(row('crm').transport, 'stdio');
  assert.equal(row('crm').calls, 3);
  assert.deepEqual(row('crm').scopes, [{ scope: 'user' }]);
  assert.equal(row('remote').transport, 'http');
  assert.deepEqual(row('analytics').scopes, [{ scope: 'local', project: s.p1 }]);
  assert.equal(row('unused').calls, 0);
  assert.ok(rep.unconfigured.some((x) => x.name === 'claude_ai_Gmail'));
  assert.ok(!('definition' in row('crm')) && !JSON.stringify(rep).includes('command'));
  const old = JSON.parse(s.run(s.p1, 'mcp', 'usage', '--json', '--days', '60').stdout);
  assert.equal(old.servers.find((x) => x.name === 'unused').calls, 1);
  assert.equal(s.run(s.p1, 'mcp', 'usage', '--days', '0').status, 2);
  assert.equal(s.run(s.p1, 'mcp', 'bogus').status, 2);
});

test('qm mcp plan proposes keep, move and park and changes nothing', () => {
  const s = setup();
  const before = fs.readFileSync(s.claudeJson, 'utf8');
  const r = s.run(s.p1, 'mcp', 'plan');
  assert.equal(r.status, 0, r.stderr);
  assertClean(r.stdout, 'plan');
  assert.match(r.stdout, /^keep {2}crm \(stdio\): used in 3 projects$/m);
  assert.match(r.stdout, /^keep {2}remote \(http\): remote: no local process$/m);
  assert.match(r.stdout, new RegExp(`^move  mail \\(stdio\\) -> local scope of ${s.p1.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} \\(3\\)$`, 'm'));
  assert.match(r.stdout, /^park {2}unused \(stdio\) -> parked store \(no calls\)$/m);
  assert.match(r.stdout, /from user scope: 3 -> 1\./);
  assert.equal(fs.readFileSync(s.claudeJson, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(s.data, 'parked-mcp.json')), false);
  const json = JSON.parse(s.run(s.p1, 'mcp', 'plan', '--json', '--min-projects', '1').stdout);
  assert.deepEqual(json.actions.map((a) => `${a.action}:${a.name}`).sort(), ['keep:crm', 'keep:mail', 'keep:remote', 'park:unused']);
});

test('qm mcp apply backs up, moves, parks, keeps the rest of the file and mode 0600', () => {
  const s = setup();
  const before = fs.readFileSync(s.claudeJson, 'utf8');
  const r = s.run(s.p2, 'mcp', 'apply');
  assert.equal(r.status, 0, r.stderr);
  assertClean(r.stdout + r.stderr, 'apply');
  const doc = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.deepEqual(Object.keys(doc.mcpServers).sort(), ['crm', 'remote']);
  assert.deepEqual(doc.projects[s.p1].mcpServers.mail, s.doc.mcpServers.mail);
  assert.deepEqual(doc.projects[s.p1].mcpServers.analytics, s.doc.projects[s.p1].mcpServers.analytics);
  assert.equal(doc.numStartups, 42);
  assert.deepEqual(doc.tipsHistory, { a: 1 });
  assert.deepEqual(doc.projects[s.p2], { allowedTools: [] });
  const store = JSON.parse(fs.readFileSync(path.join(s.data, 'parked-mcp.json'), 'utf8'));
  assert.deepEqual(store.servers.unused.definition, s.doc.mcpServers.unused);
  assert.deepEqual(store.servers.mail.definition, s.doc.mcpServers.mail);
  const backups = fs.readdirSync(path.join(s.data, 'backups'));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^claude\.json-\d{8}-\d{6}\.bak$/);
  assert.equal(fs.readFileSync(path.join(s.data, 'backups', backups[0]), 'utf8'), before);
  if (POSIX) {
    assert.equal(mode(s.claudeJson), 0o600);
    assert.equal(mode(path.join(s.data, 'parked-mcp.json')), 0o600);
    assert.equal(mode(path.join(s.data, 'backups', backups[0])), 0o600);
    assert.equal(mode(path.join(s.data, 'backups')), 0o700);
  }
  // Applying again finds nothing to do and writes nothing.
  const again = s.run(s.p2, 'mcp', 'apply');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Nothing to change/);
  assert.equal(fs.readdirSync(path.join(s.data, 'backups')).length, 1);
});

test('commitClaudeJson refuses when the MCP part changed, and keeps a concurrent non-MCP save', () => {
  const s = setup();
  const { doc } = readClaudeJson(s.claudeJson);
  const hash = mcpHash(doc);
  // Another session adds a server after the plan was made: refused, file untouched.
  const changed = { ...doc, mcpServers: { ...doc.mcpServers, extra: { command: 'x' } } };
  write(s.claudeJson, changed);
  const snapshot = fs.readFileSync(s.claudeJson, 'utf8');
  assert.throws(() => commitClaudeJson(s.claudeJson, { dataDir: s.data, expectedHash: hash, mutate: (d) => { delete d.mcpServers.crm; } }), /changed since it was read/);
  assert.equal(fs.readFileSync(s.claudeJson, 'utf8'), snapshot);
  // Claude Code saves other keys between the re-read and the rename: retried, both changes kept.
  const h2 = mcpHash(readClaudeJson(s.claudeJson).doc);
  let once = false;
  commitClaudeJson(s.claudeJson, {
    dataDir: s.data,
    expectedHash: h2,
    mutate: (d) => { delete d.mcpServers.extra; },
    _deps: { beforeRename: () => {
      if (once) return;
      once = true;
      const cur = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
      write(s.claudeJson, { ...cur, numStartups: 43, padding: 'x'.repeat(10) });
    } },
  });
  const after = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.equal(after.numStartups, 43);
  assert.equal('extra' in after.mcpServers, false);
  // A second qm holding the lock makes the write fail cleanly.
  fs.writeFileSync(path.join(s.data, 'mcp.lock'), 'other');
  assert.throws(() => commitClaudeJson(s.claudeJson, { dataDir: s.data, mutate: () => {} }), /in progress/);
});

test('enable and disable on demand: parked copy, disabled list, search hints', () => {
  const s = setup();
  assert.equal(s.run(s.p2, 'mcp', 'apply').status, 0);
  // A parked server is found by search with the command that enables it.
  const found = s.run(s.p2, 'search', 'unused mcp');
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /\[mcp\] unused \(parked\)/);
  assert.match(found.stdout, /use: qm mcp enable unused/);
  assertClean(found.stdout, 'search');
  // A server only configured in another project is 'off' here.
  assert.match(s.run(s.p2, 'list', '--kind', 'mcp').stdout, /\[mcp\] analytics \(off\)/);
  assert.doesNotMatch(s.run(s.p1, 'list', '--kind', 'mcp').stdout, /analytics \(off\)/);

  const en = s.run(s.p2, 'mcp', 'enable', 'unused');
  assert.equal(en.status, 0, en.stderr);
  assert.match(en.stdout, /next session/);
  assertClean(en.stdout, 'enable');
  let doc = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.deepEqual(doc.projects[s.p2].mcpServers.unused, s.doc.mcpServers.unused);
  let store = JSON.parse(fs.readFileSync(path.join(s.data, 'parked-mcp.json'), 'utf8'));
  assert.deepEqual(store.enabled.unused, [s.p2]);
  assert.match(s.run(s.p2, 'mcp', 'enable', 'unused').stdout, /already enabled/);

  const dis = s.run(s.p2, 'mcp', 'disable', 'unused');
  assert.equal(dis.status, 0, dis.stderr);
  assert.match(dis.stdout, /on-demand copy/);
  doc = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.equal(Object.hasOwn(doc.projects[s.p2].mcpServers, 'unused'), false);
  store = JSON.parse(fs.readFileSync(path.join(s.data, 'parked-mcp.json'), 'utf8'));
  assert.ok(store.servers.unused, 'definition stays parked');
  assert.equal(store.enabled.unused, undefined);

  // A user-scope server is switched off per project with the list the /mcp toggle writes.
  assert.equal(s.run(s.p2, 'mcp', 'disable', 'crm').status, 0);
  doc = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.deepEqual(doc.projects[s.p2].disabledMcpServers, ['crm']);
  assert.ok(doc.mcpServers.crm, 'definition untouched');
  assert.match(s.run(s.p2, 'list', '--kind', 'mcp').stdout, /\[mcp\] crm \(disabled\)/);
  assert.equal(s.run(s.p4, 'mcp', 'enable', 'crm', '--project', s.p2).status, 0);
  doc = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.deepEqual(doc.projects[s.p2].disabledMcpServers, []);

  // Copy from another project's local scope; unknown names and bad names fail.
  assert.equal(s.run(s.p3, 'mcp', 'enable', 'analytics').status, 0);
  doc = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.deepEqual(doc.projects[s.p3].mcpServers.analytics, s.doc.projects[s.p1].mcpServers.analytics);
  assert.equal(s.run(s.p3, 'mcp', 'enable', 'nope').status, 1);
  assert.equal(s.run(s.p3, 'mcp', 'enable', '--project').status, 2);
  const bad = s.run(s.p3, 'mcp', 'enable', '-x;rm');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a valid MCP server name/);
  for (const f of fs.readdirSync(path.join(s.data, 'backups'))) assertClean(f, 'backup name');
});

test('restore puts a parked definition back where it came from or where asked', () => {
  const s = setup();
  assert.equal(s.run(s.p2, 'mcp', 'apply').status, 0);
  const r1 = s.run(s.p2, 'mcp', 'restore', 'unused');
  assert.equal(r1.status, 0, r1.stderr);
  assertClean(r1.stdout, 'restore');
  let doc = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.deepEqual(doc.mcpServers.unused, s.doc.mcpServers.unused);
  let store = JSON.parse(fs.readFileSync(path.join(s.data, 'parked-mcp.json'), 'utf8'));
  assert.equal(store.servers.unused, undefined);
  const r2 = s.run(s.p2, 'mcp', 'restore', 'mail', '--project', s.p4);
  assert.equal(r2.status, 0, r2.stderr);
  doc = JSON.parse(fs.readFileSync(s.claudeJson, 'utf8'));
  assert.deepEqual(doc.projects[s.p4].mcpServers.mail, s.doc.mcpServers.mail);
  store = JSON.parse(fs.readFileSync(path.join(s.data, 'parked-mcp.json'), 'utf8'));
  assert.deepEqual(store.servers, {});
  assert.equal(s.run(s.p2, 'mcp', 'restore', 'mail').status, 1); // no longer parked
  assert.equal(s.run(s.p2, 'mcp', 'restore', 'x', '--user', '--project', '.').status, 2);
  if (POSIX) assert.equal(mode(s.claudeJson), 0o600);
});
