import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanMcp } from '../skills/urequartermaster/scripts/lib/scan/mcp.mjs';
import { redactArgs } from '../skills/urequartermaster/scripts/lib/scan/mcp/redact.mjs';
import { parseTomlServers } from '../skills/urequartermaster/scripts/lib/scan/mcp/toml.mjs';
import { agentLocations } from '../skills/urequartermaster/scripts/lib/core/paths.mjs';

const R = '«redacted»';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qm-mcp-'));
const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)); };
const cfg = (mcpDescriptions = {}) => ({ clis: [], mcpDescriptions });
// The output holds file paths under a mkdtemp folder whose random 6-character suffix can contain a
// short probe such as "x7" by chance: mask it so leak checks only look at what scanMcp produced.
const outText = (out) => JSON.stringify(out).replace(/qm-mcp-[A-Za-z0-9]{6}/g, 'qm-mcp-TMPDIR');

// Fake homes only: env is empty so CLAUDE_CONFIG_DIR/CODEX_HOME never point at real folders.
function setup() {
  const root = tmp();
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'progetto città');
  fs.mkdirSync(cwd, { recursive: true });
  const locations = agentLocations({ home, platform: process.platform, env: {}, cwd });
  return { root, home, cwd, locations };
}

// Secret-shaped values are assembled at runtime so the source never holds a literal token.
const j = (...a) => a.join('');
const S = {
  openai: j('sk-', 'proj-', 'Q7vR2mX9kL4pT8wZ1nB6cF3hJ5'),
  github: j('ghp', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'),
  slack: j('xox', 'b-', '1234567890', '-', '0987654321', '-', 'AbCdEfGhIjKlMnOpQrStUvWx'),
  google: j('AIza', 'SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY'),
  jwt: j('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'),
  bearer: j('tok', 'BEARER', '7f3a9c1e5b'),
  urlPass: j('hunter', '2', 'Pa55'),
  envOnly: j('s3c', 'ret-env-', 'value'),
  headerOnly: j('hdr', '-secret-', '42'),
  shortTok: j('abc', '123'),
  apiKeyArg: j('zz', 'z-key-', 'val'),
  queryKey: j('k1', 'query', 'secret'),
  pwdArg: j('pa', 'ss', 'word', '99'),
  kvSecret: j('kv', 'Secret', 'Value', '7'),
  hex: j('9f86d081884c7d659a2feaa0c55ad015', 'a3bf4f1b2b0b822cd15d6c15b0f00a08'),
  slackHook: j('XyZ', 'abc123DEF456ghi789JKL012mno345'),
  oauth: j('oauth', '-client-', 'secret-77'),
};
const ALL = Object.values(S);

function assertNoSecrets(out) {
  const text = outText(out);
  for (const s of ALL) assert.ok(!text.includes(s), `secret leaked: ${s.slice(0, 6)}…`);
  for (const w of ['Bearer', 'environment', 'headers']) assert.ok(!text.includes(w), `leaked word ${w}`);
}

test('never keeps env or headers', () => {
  const s = setup();
  write(path.join(s.home, '.claude.json'), {
    mcpServers: {
      remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
      local: { command: 'npx', args: ['-y', 'local-mcp'], env: { TOKEN: 's3cret' } },
    },
  });
  const out = scanMcp(s.locations, cfg());
  const text = outText(out);
  assert.ok(!text.includes('s3cret'));
  assert.ok(!text.includes('Bearer'));
  assert.deepEqual(out.map((e) => e.id).sort(), ['mcp:local', 'mcp:remote']);
});

test('redacts secrets in args', () => {
  assert.deepEqual(
    redactArgs(['--token=abc123', '--api-key', 'zzz', 'https://h/x?key=k1', 'plain']),
    ['--token=' + R, '--api-key', R, 'https://h/x?key=' + R, 'plain'],
  );
  assert.deepEqual(redactArgs(['Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z']), [R]); // 32 alphanumeric chars
});

test('redactArgs: flag names, KEY=value, userinfo, Bearer, known prefixes', () => {
  const cases = [
    [['--password', 'p'], ['--password', R]],
    [['--PASSWD=x'], ['--PASSWD=' + R]],
    [['-pwd', 'x'], ['-pwd', R]],
    [['--client-secret', 'x'], ['--client-secret', R]],
    [['--auth-header', 'x'], ['--auth-header', R]],
    [['--bearer', 'x'], ['--bearer', R]],
    [['--credentials=x'], ['--credentials=' + R]],
    [['--apikey', 'x'], ['--apikey', R]],
    [['--ACCESS_TOKEN', 'x', 'next'], ['--ACCESS_TOKEN', R, 'next']],
    [['--token', '--verbose'], ['--token', '--verbose']], // a flag is not a value
    [['--monkey', 'stdio', '--author', 'me', '--path', '/x'], ['--monkey', 'stdio', '--author', 'me', '--path', '/x']],
    [['--accessToken', 'x', '--PGPASSWORD=y', '--key-file', 'z'], ['--accessToken', R, '--PGPASSWORD=' + R, '--key-file', R]],
    [['GITHUB_TOKEN=x'], ['GITHUB_TOKEN=' + R]],
    [['DB_PASSWORD=x', 'MODE=fast'], ['DB_PASSWORD=' + R, 'MODE=fast']],
    [['https://user:pw@db.example.com:5432/x'], [`https://${R}@db.example.com:5432/x`]],
    [['https://tok@api.example.com/'], [`https://${R}@api.example.com/`]],
    [['postgres://u:p@h/db?sslmode=require&password=x'], [`postgres://${R}@h/db?sslmode=require&password=${R}`]],
    [['https://h/x?a=1&access_token=x#f'], [`https://h/x?a=1&access_token=${R}#f`]],
    [['Authorization: Bearer abc'], ['Authorization: ' + R]],
    [['Bearer abc'], ['Bearer ' + R]],
    [['x-api-key: abc'], ['x-api-key: ' + R]],
    [['--header', 'Authorization: Basic dXNlcjpwYXNz'], ['--header', 'Authorization: ' + R]],
    [[S.slack], [R]],
    [[S.openai], [R]],
    [[S.google], [R]],
    [[S.jwt], [R]],
    [['--config=' + S.github], ['--config=' + R]],
  ];
  for (const [input, expected] of cases) assert.deepEqual(redactArgs(input), expected, JSON.stringify(input));
});

test('redactArgs: headers inside flag values, very long strings', () => {
  assert.deepEqual(redactArgs(['--header=X-Api-Key:abc', '--header=Authorization: Bearer x', '-H', 'X-API-Key:abc']),
    ['--header=X-Api-Key:' + R, '--header=Authorization: ' + R, '-H', 'X-API-Key:' + R]);
  const t0 = Date.now();
  assert.deepEqual(redactArgs(['a'.repeat(200000), 'x:'.repeat(100000), '?a=b&'.repeat(50000)]), [R, R, R]);
  assert.ok(Date.now() - t0 < 1000);
});

test('redactArgs keeps ordinary paths, package names and words', () => {
  const keep = [
    '-y',
    '@modelcontextprotocol/server-filesystem',
    '@scope/name@1.2.3',
    '@modelcontextprotocol/server-sequential-thinking@2025.7.1',
    'mcp-server-with-a-really-long-package-name',
    '/Users/mario rossi/Library/Application Support/Code/User/globalStorage/some-extension/server.js',
    'C:\\Users\\Mario\\AppData\\Roaming\\npm\\node_modules\\@playwright\\mcp\\cli.js',
    '/opt/tools/node_modules/@acme/mcp-server-with-a-really-long-name/dist/index.js',
    '${CLAUDE_PLUGIN_ROOT}/servers/index.js',
    'https://mcp.example.com/sse',
    '--port=3000',
    '--monkey-patch',
    'stdio',
  ];
  assert.deepEqual(redactArgs(keep), keep);
});

test('redactArgs: high-entropy segments inside URLs and paths, non-strings dropped', () => {
  assert.deepEqual(redactArgs([`https://hooks.example.com/services/T0/B0/${S.slackHook}`]), [`https://hooks.example.com/services/T0/B0/${R}`]);
  assert.deepEqual(redactArgs([S.hex]), [R]);
  assert.deepEqual(redactArgs(['a', 7, null, { x: 1 }, 'b']), ['a', '7', 'b']);
  assert.deepEqual(redactArgs('not-an-array'), []);
});

test('parses codex toml', () => {
  const text = '[mcp_servers.foo]\ncommand = "npx"\nargs = ["-y","foo-mcp"]\n[mcp_servers.foo.env]\nK = "v"';
  assert.deepEqual(parseTomlServers(text), { foo: { command: 'npx', args: ['-y', 'foo-mcp'] } });
});

test('parseTomlServers: quoted names, literal strings, multi-line arrays, comments, other tables', () => {
  const text = [
    '# codex config',
    'model = "gpt-5"',
    '[profiles.x]',
    'command = "not-a-server"',
    '[mcp_servers."my.server"] # dotted name',
    "command = 'C:\\tools\\srv.exe' # literal string",
    'args = [',
    '  "--port", # comment inside',
    '  "3000",',
    ']',
    'startup_timeout_sec = 20',
    'enabled = true',
    '[mcp_servers.remote]',
    'url = "https://mcp.example.com/mcp"',
    'bearer_token_env_var = "MY_TOKEN"',
    '[mcp_servers.remote.http_headers]',
    'X-Key = "hidden-value"',
    '[mcp_servers.esc]',
    'command = "a\\"b\\\\c\\u0041"',
    '[mcp_servers.inline]',
    'env = { API_KEY = "inline-secret", NESTED = { X = "deep-secret" } }',
    'command = "uvx"',
    '[mcp_servers.bad]',
    'this line is broken',
    'args = ["ok"',
    '[mcp_servers.after]',
    'command = "still-parsed"',
  ].join('\n');
  const r = parseTomlServers(text);
  assert.deepEqual(r['my.server'], { command: 'C:\\tools\\srv.exe', args: ['--port', '3000'] });
  assert.deepEqual(r.remote, { url: 'https://mcp.example.com/mcp' });
  assert.deepEqual(r.esc, { command: 'a"b\\cA' });
  assert.deepEqual(r.inline, { command: 'uvx' });
  assert.deepEqual(r.after, { command: 'still-parsed' });
  assert.equal(r.x, undefined);
  const text2 = JSON.stringify(r);
  for (const s of ['hidden-value', 'inline-secret', 'deep-secret', 'MY_TOKEN']) assert.ok(!text2.includes(s), s);
});

test('parseTomlServers: [mcp_servers] with dotted keys and inline tables; never throws', () => {
  const text = '[mcp_servers]\na.command = "x"\na.env.K = "leak1"\nb = { command = "y", args = ["1"], headers = { H = "leak2" } }\n';
  const r = parseTomlServers(text);
  assert.deepEqual(r, { a: { command: 'x' }, b: { command: 'y', args: ['1'] } });
  for (const junk of ['', '[', '[[mcp_servers.z]]\ncommand="q"', '"""', 'a = """\nmulti\n"""', '[mcp_servers.q]\ncommand = """x', '\u0000\uffff', null, undefined, 42]) {
    assert.doesNotThrow(() => parseTomlServers(junk));
  }
  assert.deepEqual(parseTomlServers('[mcp_servers.__proto__]\ncommand = "p"').__proto__, { command: 'p' });
  assert.equal({}.command, undefined);
});

test('MCP entries: fields, description from config or from command, usage', () => {
  const s = setup();
  write(path.join(s.home, '.claude.json'), {
    mcpServers: {
      fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '--token=abc'] },
      notes: { type: 'stdio', command: 'notes-mcp' },
      web: { type: 'sse', url: 'https://user:pw@mcp.example.com/sse?api_key=zzz' },
    },
  });
  const out = scanMcp(s.locations, cfg({ notes: 'Personal notes' }));
  const fsE = out.find((e) => e.id === 'mcp:fs');
  assert.deepEqual(fsE, {
    id: 'mcp:fs', kind: 'mcp', name: 'fs',
    description: 'stdio MCP server: npx @modelcontextprotocol/server-filesystem',
    headings: [], path: path.join(s.home, '.claude.json'), source: 'claude', state: 'installed', usage: 'MCP server fs',
  });
  assert.equal(out.find((e) => e.id === 'mcp:notes').description, 'Personal notes');
  assert.equal(out.find((e) => e.id === 'mcp:web').description, 'sse MCP server: https://mcp.example.com');
});

test('all agents: codex toml, project scope (incl. forward-slash key), vscode jsonc, opencode, duplicates', () => {
  const s = setup();
  const claudeJson = path.join(s.home, '.claude.json');
  write(claudeJson, {
    mcpServers: { shared: { command: 'a' } },
    projects: {
      [s.cwd]: { mcpServers: { proj: { command: 'p' } } },
      '/somewhere/else': { mcpServers: { other: { command: 'o' } } },
    },
  });
  write(path.join(s.cwd, '.mcp.json'), { mcpServers: { shared: { command: 'b' } } });
  write(path.join(s.home, '.codex', 'config.toml'), '[mcp_servers.cx]\ncommand = "codex-mcp"\n[mcp_servers.shared]\ncommand = "c"\n');
  write(path.join(s.home, '.gemini', 'settings.json'), { mcpServers: { gem: { httpUrl: 'https://g.example.com/mcp' } } });
  const vs = s.locations.mcpConfigs.find((c) => c.agent === 'vscode').file;
  write(vs, '// user mcp\n{\n  "servers": {\n    /* block */ "vsc": { "type": "stdio", "command": "vs-mcp", "args": ["--x"], },\n  },\n}\n');
  write(path.join(s.home, '.config', 'opencode', 'opencode.json'), {
    mcp: {
      oc: { type: 'local', command: ['npx', '-y', 'oc-mcp', '--api-key', 'zzz'], environment: { K: 'v' } },
      ocr: { type: 'remote', url: 'https://r.example.com/mcp', headers: { Authorization: 'x' } },
    },
  });
  const out = scanMcp(s.locations, cfg());
  const ids = out.map((e) => e.id);
  assert.deepEqual(ids.filter((i) => i.startsWith('mcp:shared')), ['mcp:shared', 'mcp:shared@claude', 'mcp:shared@codex']);
  assert.equal(out.find((e) => e.id === 'mcp:shared').description, 'stdio MCP server: a');
  assert.equal(out.find((e) => e.id === 'mcp:shared@codex').duplicateOf, 'mcp:shared');
  assert.ok(ids.includes('mcp:proj'));
  assert.ok(!ids.includes('mcp:other'));
  assert.equal(out.find((e) => e.id === 'mcp:cx').source, 'codex');
  assert.equal(out.find((e) => e.id === 'mcp:gem').description, 'http MCP server: https://g.example.com');
  assert.equal(out.find((e) => e.id === 'mcp:vsc').source, 'vscode');
  assert.equal(out.find((e) => e.id === 'mcp:oc').description, 'local MCP server: npx oc-mcp');
  assert.equal(out.find((e) => e.id === 'mcp:ocr').description, 'remote MCP server: https://r.example.com');
  assert.equal(new Set(ids).size, ids.length);
});

test('project key stored with forward slashes (Windows) is found', () => {
  const s = setup();
  const winCwd = 'C:\\Users\\Mario\\progetto';
  const locations = agentLocations({ home: s.home, platform: 'win32', env: {}, cwd: winCwd });
  // Only the claude.json project pick matters here; point it at the fake home on this OS.
  const claudeJson = path.join(s.home, '.claude.json');
  write(claudeJson, { projects: { 'C:/Users/Mario/progetto': { mcpServers: { winproj: { command: 'w' } } } } });
  const only = { ...locations, mcpConfigs: locations.mcpConfigs.filter((c) => c.pick.startsWith('projects[')).map((c) => ({ ...c, file: claudeJson })) };
  assert.deepEqual(scanMcp(only, cfg()).map((e) => e.id), ['mcp:winproj']);
});

test('plugin MCP servers: only enabled plugins, name plugin:<p>:<server>', () => {
  const s = setup();
  const pl = s.locations;
  const on = path.join(pl.pluginCache, 'mk', 'gh', '1.0.0');
  const off = path.join(pl.pluginCache, 'mk', 'offp', '1.0.0');
  write(path.join(on, '.mcp.json'), { mcpServers: { github: { type: 'http', url: 'https://api.example.com/mcp/', headers: { Authorization: `Bearer ${S.github}` } } } });
  write(path.join(off, '.mcp.json'), { mcpServers: { hidden: { command: 'h' } } });
  write(pl.installedPluginsFile, { plugins: { 'gh@mk': [{ installPath: on }], 'offp@mk': [{ installPath: off }] } });
  write(pl.claudeSettingsFile, { env: { ANTHROPIC_API_KEY: S.openai }, enabledPlugins: { 'gh@mk': true, 'offp@mk': false } });
  const out = scanMcp(pl, cfg());
  assert.deepEqual(out.map((e) => [e.id, e.name, e.source, e.path]), [
    ['mcp:plugin:gh:github', 'plugin:gh:github', 'plugin:gh', path.join(on, '.mcp.json')],
  ]);
  // Claude Code names these tools mcp__plugin_<plugin>_<server>__<tool>.
  assert.equal(out[0].usage, 'MCP server plugin:gh:github (Claude Code tools: mcp__plugin_gh_github__…)');
  assertNoSecrets(out);
});

test('realistic secret shapes in env, headers, args and url never reach the output', () => {
  const s = setup();
  const servers = {
    a: {
      command: 'npx',
      args: ['-y', 'srv', '--token', S.shortTok, '--api-key', S.apiKeyArg, `--password=${S.pwdArg}`, `CLIENT_SECRET=${S.kvSecret}`,
        S.openai, S.github, S.slack, S.google, S.jwt, S.hex, '--header', `Authorization: Bearer ${S.bearer}`, `--oauth=${S.oauth}`],
      env: { OPENAI_API_KEY: S.envOnly, GITHUB_TOKEN: S.github, SLACK: S.slack },
      headers: { Authorization: `Bearer ${S.headerOnly}` },
      auth: { token: S.headerOnly }, oauth: { clientSecret: S.oauth }, token: S.envOnly,
    },
    b: { type: 'http', url: `https://admin:${S.urlPass}@mcp.example.com/v1/${S.slackHook}?key=${S.queryKey}&api_key=${S.google}&mode=x`, headers: { 'X-API-Key': S.headerOnly } },
    c: { type: 'sse', url: `https://mcp.example.com/sse?access_token=${S.jwt}` },
  };
  write(path.join(s.home, '.claude.json'), { mcpServers: servers, projects: { [s.cwd]: { mcpServers: { d: { command: `API_TOKEN=${S.shortTok} node`, env: { X: S.envOnly } } } } } });
  write(path.join(s.home, '.cursor', 'mcp.json'), { mcpServers: { e: { url: `https://u:${S.urlPass}@c.example.com`, headers: { Authorization: `Bearer ${S.bearer}` } } } });
  write(path.join(s.home, '.codex', 'config.toml'), [
    '[mcp_servers.f]', 'command = "npx"', `args = ["--api-key", "${S.apiKeyArg}", "${S.github}"]`,
    '[mcp_servers.f.env]', `OPENAI_API_KEY = "${S.envOnly}"`,
    '[mcp_servers.g]', `url = "https://x.example.com/mcp?token=${S.shortTok}"`, 'bearer_token_env_var = "TOKEN_VAR"',
    '[mcp_servers.g.http_headers]', `Authorization = "Bearer ${S.headerOnly}"`,
    '[mcp_servers.g.env_http_headers]', 'X = "Y"',
  ].join('\n'));
  write(path.join(s.home, '.config', 'opencode', 'opencode.json'), {
    mcp: { h: { type: 'local', command: ['npx', S.slack, '--secret', S.oauth], environment: { K: S.envOnly } }, i: { type: 'remote', url: `https://${S.urlPass}@o.example.com/mcp`, headers: { Authorization: `Bearer ${S.headerOnly}` } } },
  });
  const out = scanMcp(s.locations, cfg());
  assert.deepEqual(out.map((e) => e.name).sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assertNoSecrets(out);
  for (const e of out) assert.deepEqual(Object.keys(e).sort(), ['description', 'headings', 'id', 'kind', 'name', 'path', 'source', 'state', 'usage']);
});

test('corrupt or unreadable configs: skipped silently, no content in errors', () => {
  const s = setup();
  const secretLine = `{"mcpServers": {"x": {"env": {"K": "${S.envOnly}"}} ,,,`;
  write(path.join(s.home, '.claude.json'), secretLine);
  write(path.join(s.home, '.gemini', 'settings.json'), '[1,2,3]');
  write(path.join(s.home, '.cursor', 'mcp.json'), { mcpServers: { ok: { command: 'fine' }, bad: 'string', nul: null, arr: [1] } });
  write(path.join(s.home, '.codex', 'config.toml'), Buffer.from([0xff, 0xfe, 0x00, 0x5b]));
  fs.mkdirSync(path.join(s.cwd, '.mcp.json'), { recursive: true }); // a folder where a file is expected
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => logs.push(a.join(' '));
  let out;
  try { out = scanMcp(s.locations, cfg()); } finally { Object.assign(console, orig); }
  assert.deepEqual(out.map((e) => e.id), ['mcp:ok']);
  assert.ok(!logs.join('\n').includes(S.envOnly));
  assertNoSecrets(out);
});

test('nothing configured -> empty list; missing config object tolerated', () => {
  const s = setup();
  assert.deepEqual(scanMcp(s.locations, cfg()), []);
  assert.deepEqual(scanMcp(s.locations), []);
});

// --- Secrets inside strings, JSON, URLs; TOML robustness; disabled servers ---

test('--flag value pairs inside one string (sh -c, cmd /c, command string), end to end', () => {
  assert.deepEqual(redactArgs(['-c', 'npx foo --token abc123 --api-key hunter2']), ['-c', `npx foo --token ${R} --api-key ${R}`]);
  assert.deepEqual(redactArgs(['/c', 'npx foo --password hunter2']), ['/c', `npx foo --password ${R}`]);
  assert.deepEqual(redactArgs(['-c', 'curl -H "X-Api-Key: k9" -u admin:pw7 https://h']), ['-c', `curl -H "X-Api-Key: ${R}" -u admin:${R} https://h`]);
  const s = setup();
  write(path.join(s.home, '.claude.json'), { mcpServers: {
    shc: { command: 'sh', args: ['-c', 'npx srv --token tokSHORT1 --password pwSHORT2'] },
    cmd: { command: 'cmd', args: ['/c', 'npx srv --api-key akSHORT3'] },
    one: { command: 'npx srv --api-key akSHORT4 --secret=scSHORT5' },
  } });
  write(path.join(s.home, '.codex', 'config.toml'), '[mcp_servers.cx]\ncommand = "npx srv --password pwSHORT6"\n');
  const text = outText(scanMcp(s.locations, cfg()));
  for (const leak of ['tokSHORT1', 'pwSHORT2', 'akSHORT3', 'akSHORT4', 'scSHORT5', 'pwSHORT6']) assert.ok(!text.includes(leak), leak);
  assert.ok(text.includes('stdio MCP server: sh"'));
});

test('JSON passed as an argument has its secret fields redacted', () => {
  assert.deepEqual(redactArgs(['--config', '{"password":"jsonPWLEAK","port":8080}']), ['--config', `{"password":"${R}","port":8080}`]);
  assert.deepEqual(redactArgs(['{"apiKey":"abc", "name": "x"}']), [`{"apiKey":"${R}", "name": "x"}`]);
  assert.deepEqual(redactArgs(["{'client_secret': 'q\\'z', 'mode': 'a'}"]), [`{'client_secret': '${R}', 'mode': 'a'}`]);
});

test('mixed-case secrets of 20+ chars in URL paths; slugs survive', () => {
  assert.deepEqual(redactArgs(['https://hooks.example.com/services/T0ABCDEFG/B0ABCDEFG/Ab3dEf6hIj9kLm2nOp5qRs8t']),
    [`https://hooks.example.com/services/T0ABCDEFG/B0ABCDEFG/${R}`]);
  const keep = ['https://example.com/my-project-name-2026/releases', 'https://github.com/AnthropicLabs/claude-code-plugins/tree/main'];
  assert.deepEqual(redactArgs(keep), keep);
});

test('new secret words, DB client -p, user:password', () => {
  assert.deepEqual(redactArgs(['--pass', 'a', '--pw', 'b', '--passcode=c', '--privkey', 'd', '--session', 'e']),
    ['--pass', R, '--pw', R, '--passcode=' + R, '--privkey', R, '--session', R]);
  assert.deepEqual(redactArgs(['mysql', '-u', 'root', '-p', 'dbPW1']), ['mysql', '-u', 'root', '-p', R]);
  assert.deepEqual(redactArgs(['-c', 'psql -h db -pdbPW2 app']), ['-c', `psql -h db -p${R} app`]);
  assert.deepEqual(redactArgs(['/usr/bin/redis-cli', '-p', '6379x']), ['/usr/bin/redis-cli', '-p', R]);
  assert.deepEqual(redactArgs(['docker', 'run', '-p', '8080', 'img']), ['docker', 'run', '-p', '8080', 'img']);
  assert.deepEqual(redactArgs(['-u', 'user:pw1', '--user=admin:pw2', '-u', 'plain']), ['-u', `user:${R}`, `--user=admin:${R}`, '-u', 'plain']);
  const s = setup();
  write(path.join(s.home, '.claude.json'), { mcpServers: { db: { command: 'mariadb', args: ['-pDBLEAK9'] } } });
  assert.ok(!outText(scanMcp(s.locations, cfg())).includes('DBLEAK9'));
});

test('userinfo containing @ is hidden up to the last @ before the path', () => {
  assert.deepEqual(redactArgs(['https://user:p@ss@host/x']), [`https://${R}@host/x`]);
  assert.deepEqual(redactArgs(['https://host/a@b']), ['https://host/a@b']);
});

test('secrets in URL fragments', () => {
  assert.deepEqual(redactArgs(['https://h/cb#access_token=frag1&state=ok']), [`https://h/cb#access_token=${R}&state=ok`]);
});

test('TOML with many unterminated quotes parses in linear time', () => {
  for (const line of ["a = 'xxxxxxxxxx\n", 'a = "xxxxxxxxxx\n', "a = '''xxxxxxx\n", 'a = """xxxxxxx\n']) {
    const text = line.repeat(Math.ceil(200 * 1024 / line.length)) + '[mcp_servers.ok]\ncommand = "fine"\n';
    const t0 = Date.now();
    const r = parseTomlServers(text);
    // quadratic parsing of 200 KB takes minutes; 1 s leaves room for slow, loaded CI machines
    assert.ok(Date.now() - t0 < 1000, JSON.stringify(line));
    if (!line.includes("'''") && !line.includes('"""')) assert.deepEqual(r, { ok: { command: 'fine' } });
  }
});

test('only Codex and OpenCode disabled servers are skipped', () => {
  const s = setup();
  write(path.join(s.home, '.claude.json'), { mcpServers: { on: { command: 'a' }, off1: { command: 'b', disabled: true }, off2: { command: 'c', enabled: false } } });
  write(path.join(s.home, '.cursor', 'mcp.json'), { mcpServers: { cur: { command: 'e', disabled: true } } });
  write(path.join(s.home, '.codex', 'config.toml'), '[mcp_servers.cxoff]\ncommand = "x"\nenabled = false\n[mcp_servers.cxon]\ncommand = "y"\nenabled = true\n');
  write(path.join(s.home, '.config', 'opencode', 'opencode.json'), { mcp: { ocoff: { type: 'local', command: ['z'], enabled: false }, ocon: { type: 'local', command: ['w'], disabled: true } } });
  assert.deepEqual(scanMcp(s.locations, cfg()).map((e) => e.id).sort(), ['mcp:cur', 'mcp:cxon', 'mcp:ocon', 'mcp:off1', 'mcp:off2', 'mcp:on']);
  assert.deepEqual(parseTomlServers('[mcp_servers.q]\ncommand = "x"\nenabled = false\n'), {});
});

// --- Quoting, PowerShell, docker-style --env, large configs ---

function leaksEndToEnd(servers, leaks) {
  const s = setup();
  write(path.join(s.home, '.claude.json'), { mcpServers: servers });
  const text = outText(scanMcp(s.locations, cfg()));
  for (const l of leaks) assert.ok(!text.includes(l), `leaked ${l}`);
  return text;
}

test('quoted values with spaces are hidden whole', () => {
  assert.deepEqual(redactArgs(['-c', 'npx foo --api-key "x1 y1"']), ['-c', `npx foo --api-key "${R}"`]);
  assert.deepEqual(redactArgs(['-c', "npx foo --password 'correct horse53 battery53' --verbose"]), ['-c', `npx foo --password '${R}' --verbose`]);
  assert.deepEqual(redactArgs(['-c', 'export API_KEY="x7 y7"; npx srv']), ['-c', `export API_KEY=${R}; npx srv`]);
  assert.deepEqual(redactArgs(['-c', 'npx srv --token="x8 y8" --port 1']), ['-c', `npx srv --token=${R} --port 1`]);
  assert.deepEqual(redactArgs(['-c', "it's npx --token tk9"]), ['-c', `it's npx --token ${R}`]); // unbalanced quote: plain words
  leaksEndToEnd({
    a: { command: 'sh', args: ['-c', 'npx foo --api-key "x1 y1"'] },
    b: { command: "sh -c 'npx srv --password \"corr60 horse60\"'" },
    c: { command: 'bash', args: ['-c', "npx --password 'correct horse53 battery53'"] },
    d: { command: 'sh', args: ['-c', 'export API_KEY="x7 y7" && npx --token="x8 y8"'] },
    e: { command: 'sh', args: ['-c', 'npx --token "unclosed11 rest11'] },
  }, ['y1', 'x1', 'horse60', 'corr60', 'horse53', 'battery53', 'x7', 'y7', 'x8', 'y8', 'unclosed11', 'rest11']);
});

test('PowerShell $env: assignments', () => {
  assert.deepEqual(redactArgs(['-Command', "$env:API_KEY='psk61'; npx srv"]), ['-Command', `$env:API_KEY=${R}; npx srv`]);
  assert.deepEqual(redactArgs(['-Command', '$env:API_KEY = "x13"; npx srv']), ['-Command', `$env:API_KEY = "${R}"; npx srv`]);
  assert.deepEqual(redactArgs(['-c', 'MODE = fast']), ['-c', 'MODE = fast']);
  leaksEndToEnd({
    ps: { command: 'powershell', args: ['-Command', "$env:API_KEY='psk61'; npx srv"] },
    ps2: { command: 'powershell -Command "$ENV:GITHUB_TOKEN = \"x13\"; npx srv"' },
  }, ['psk61', 'x13']);
});

test('--env=KEY=value and --env KEY value', () => {
  assert.deepEqual(redactArgs(['--env=API_KEY=secret33', '--env=MODE=fast']), [`--env=API_KEY=${R}`, '--env=MODE=fast']);
  assert.deepEqual(redactArgs(['--env', 'API_KEY', 'x42', '-e', 'MODE', 'fast']), ['--env', 'API_KEY', R, '-e', 'MODE', 'fast']);
  assert.deepEqual(redactArgs(['-c', 'docker run -e GITHUB_TOKEN x43 img']), ['-c', `docker run -e GITHUB_TOKEN ${R} img`]);
  leaksEndToEnd({ d: { command: 'docker', args: ['run', '--env=API_KEY=secret33', '--env', 'API_KEY', 'x42', 'img'] } }, ['secret33', 'x42']);
});

test('spaces after =, numeric/boolean JSON values, dash-leading values', () => {
  assert.deepEqual(redactArgs(['--token=   x15']), [`--token=${R}`]);
  assert.deepEqual(redactArgs(['-c', 'npx --token=   x16 --port 1']), ['-c', `npx --token=   ${R} --port 1`]);
  assert.deepEqual(redactArgs(['{"password":12345678,"port":80,"auth":true}']), [`{"password":${R},"port":80,"auth":${R}}`]);
  assert.deepEqual(redactArgs(['--password', '-dashpw29', '--token', '--verbose', '--key', '-v']), ['--password', R, '--token', '--verbose', '--key', '-v']);
  assert.deepEqual(redactArgs(['-c', 'npx --password -dashpw30 --x']), ['-c', `npx --password ${R} --x`]);
  leaksEndToEnd({ n: { command: 'npx', args: ['--token=   x15', '--config', '{"password":12345678}', '--password', '-dashpw29'] } }, ['x15', '12345678', 'dashpw29']);
});

test('JSON configs up to 64 MB are read', () => {
  const s = setup();
  const pad = 'x'.repeat(9 * 1024 * 1024);
  write(path.join(s.home, '.claude.json'), { history: pad, mcpServers: { big: { command: 'b' } } });
  assert.deepEqual(scanMcp(s.locations, cfg()).map((e) => e.id), ['mcp:big']);
});

// --- Descriptions built from an allowlist ---

const descOf = (servers) => {
  const s = setup();
  write(path.join(s.home, '.claude.json'), { mcpServers: servers });
  return Object.fromEntries(scanMcp(s.locations, cfg()).map((e) => [e.name, e.description]));
};

test('allowlist descriptions keep only command basename, packages, script basenames and URL host', () => {
  const d = descOf({
    gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    git: { command: 'uvx', args: ['mcp-server-git'] },
    remote: { type: 'http', url: 'https://mcp.example.com/v1/sse?key=abc' },
    script: { command: 'node', args: ['/Users/x/secret-dir/dist/index.js'] },
    win: { command: 'C:\\Users\\Mario\\tools\\node.exe', args: ['C:\\Users\\Mario\\mcp\\server.py'] },
    ver: { command: 'npx', args: ['-y', '@scope/name@1.2.3', 'foo-mcp@latest', '--port', '3000'] },
    img: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server:v1.2', 'org/img'] },
    py: { command: 'python', args: ['-m', 'mcp_server_time', '--local-timezone=Europe/Rome'] },
    port: { type: 'sse', url: 'http://user:pw@localhost:8080/sse#t=1' },
    badurl: { type: 'http', url: 'not a url' },
  });
  assert.equal(d.gh, 'stdio MCP server: npx @modelcontextprotocol/server-github');
  assert.equal(d.git, 'stdio MCP server: uvx mcp-server-git');
  assert.equal(d.remote, 'http MCP server: https://mcp.example.com');
  assert.equal(d.script, 'stdio MCP server: node index.js');
  assert.equal(d.win, 'stdio MCP server: node.exe server.py');
  assert.equal(d.ver, 'stdio MCP server: npx @scope/name@1.2.3 foo-mcp@latest');
  // r4: `-e GITHUB_TOKEN` makes the redaction hide the next token, so the image is not byte-identical.
  assert.equal(d.img, 'stdio MCP server: docker org/img');
  // r4: `-m` takes a value, and flag values are never candidates.
  assert.equal(d.py, 'stdio MCP server: python');
  assert.equal(d.port, 'sse MCP server: http://localhost:8080');
  assert.equal(d.badurl, 'http MCP server');
});

test('every secret shape above, bare short secrets and secret path segments stay out of descriptions', () => {
  const probes = [
    ['-c', 'npx foo --token abc123 --api-key hunter2'], ['/c', 'npx foo --password hunter2'],
    ['-c', 'curl -H "X-Api-Key: k9" -u admin:pw7 https://h'], ['--config', '{"password":"jsonPWLEAK"}'], ['{"apiKey":"abc"}'],
    ['https://hooks.example.com/services/T0ABCDEFG/B0ABCDEFG/Ab3dEf6hIj9kLm2nOp5qRs8t'], ['mysql', '-p', 'dbPW1'], ['-pdbPW2'],
    ['-u', 'user:pw1'], ['https://user:p@ss@host/x'], ['https://h/cb#access_token=frag1'],
    ['-c', 'npx foo --api-key "x1 y1"'], ['-c', "npx --password 'correct horse53 battery53'"], ['-c', 'export API_KEY="x7 y7"'],
    ['-Command', "$env:API_KEY='psk61'; npx srv"], ['-Command', '$env:API_KEY = "x13"'], ['--env=API_KEY=secret33'], ['--env', 'API_KEY', 'x42'],
    ['--token=   x15'], ['{"password":12345678}'], ['--password', '-dashpw29'],
    ['srv', 's3cr3t'], ['plainsecret'], ['/srv/abc123secretseg/run.sh'], ['deploy@myhost'], ['tok42/value99'],
  ];
  const servers = {};
  probes.forEach((args, i) => { servers[`p${i}`] = { command: 'npx', args }; });
  servers.cmdstr = { command: "sh -c 'npx srv --password \"corr60 horse60\"' s3cr3t" };
  servers.url = { type: 'http', url: 'https://admin:pwURL@mcp.example.com/abc123secretseg/x?key=k1#token=t1' };
  const text = JSON.stringify(descOf(servers));
  for (const leak of ['abc123', 'hunter2', 'k9', 'pw7', 'jsonPWLEAK', 'Ab3dEf6hIj9kLm2nOp5qRs8t', 'dbPW1', 'dbPW2', 'pw1', 'p@ss', 'frag1',
    'x1 y1', 'y1', 'horse53', 'x7', 'psk61', 'x13', 'secret33', 'x42', 'x15', '12345678', 'dashpw29', 's3cr3t', 'plainsecret',
    'abc123secretseg', 'myhost', 'tok42', 'value99', 'corr60', 'horse60', 'pwURL', 'k1', 't1', 'admin', 'secret-dir']) {
    assert.ok(!text.includes(leak), `leaked ${leak}`);
  }
});

// --- Positional allowlist: flag values never kept ---

test('values after secret or unknown flags never become description tokens', () => {
  const pw = j('hunter', '2');
  const servers = {
    k1: { command: 'npx', args: ['--api-key', `mcp-${pw}-correcthorse`] },
    k2: { command: 'node', args: ['--password', `${pw}secret.js`] },
    k3: { command: 'npx', args: ['--token', `@me/${pw}pass`] },
    k4: { command: 'npx', args: ['--key', `pkg@1${pw}`] },
    k5: { command: 'docker', args: ['run', '-i', '--rm', '--env', 'PASSWORD', 'myp4ss/word', 'mcp/img'] },
    k6: { command: 'python', args: ['-c', 'x', 'p4ssw0rd-secret.py'] },
    k7: { command: 'npx', args: ['--label', `x-mcp-${pw}3`] }, // non-secret flag: still a value
    k8: { command: 'npx --api-key mcp-cmdstr-leak9' }, // same probe inside the command string
    k9: { command: 'cmd', args: ['/x', `mcp-${pw}-win`] }, // Windows-style flag
    k10: { command: 'node', args: ['-e', 'x', 'evalleak-mcp.js'] },
    k11: { command: 'pwsh', args: ['-Command', 'x', 'psleak.ps1.js'] },
  };
  const s = setup();
  write(path.join(s.home, '.claude.json'), { mcpServers: servers });
  const text = outText(scanMcp(s.locations, cfg()));
  for (const leak of [pw, 'myp4ss', 'p4ssw0rd', 'cmdstr-leak9', 'evalleak', 'psleak']) assert.ok(!text.includes(leak), `leaked ${leak}`);
  const d = descOf(servers);
  assert.equal(d.k5, 'stdio MCP server: docker mcp/img');
  assert.equal(d.k1, 'stdio MCP server: npx');
});

test('known boolean flags do not take a value; standard examples unchanged', () => {
  const d = descOf({
    gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    git: { command: 'uvx', args: ['mcp-server-git'] },
    remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
    script: { command: 'node', args: ['index.js'] },
    yes: { command: 'npx', args: ['--yes', '--prefer-offline', '@scope/pkg'] },
    q: { command: 'npx', args: ['-q', 'foo-mcp@latest'] },
    dk: { command: 'docker', args: ['run', '-it', '--rm', '-d', 'org/img'] },
    win: { command: 'cmd', args: ['/c', 'npx', '-y', '@scope/pkg'] },
    port: { command: 'npx', args: ['--port', 'foo-mcp@latest'] },
    dke: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'MODE=fast', 'mcp/img'] },
  });
  assert.equal(d.dke, 'stdio MCP server: docker mcp/img'); // docker -e is --env, not code
  assert.equal(d.gh, 'stdio MCP server: npx @modelcontextprotocol/server-github');
  assert.equal(d.git, 'stdio MCP server: uvx mcp-server-git');
  assert.equal(d.remote, 'http MCP server: https://mcp.example.com');
  assert.equal(d.script, 'stdio MCP server: node index.js');
  assert.equal(d.yes, 'stdio MCP server: npx @scope/pkg');
  assert.equal(d.q, 'stdio MCP server: npx foo-mcp@latest');
  assert.equal(d.dk, 'stdio MCP server: docker org/img');
  assert.equal(d.win, 'stdio MCP server: cmd @scope/pkg');
  assert.equal(d.port, 'stdio MCP server: npx'); // --port is not boolean: its value is dropped
});
