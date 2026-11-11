# UreQuartermaster

**You're set: every skill, MCP and tool you already have, found and used for you.**

UreQuartermaster is an [Agent Skill](https://agentskills.io) for coding agents. It keeps a local index of the
skills, MCP servers, plugins and command-line tools you have installed, and makes the agent search it before
each non-trivial request, so the right tools get used without you having to name them.

Supported agents:

- **Skills** are read from the folders of Claude Code (including its plugins), Codex, Gemini CLI and OpenCode, and
  from the shared `~/.agents/skills`, which covers any other agent that supports Agent Skills.
- **MCP servers** are read from the configurations of Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, OpenCode,
  Cursor and VS Code.
- **`qm init`** writes to the instruction files of Claude Code, Codex, Gemini CLI, Copilot CLI and OpenCode.
- Cursor's and Copilot's own skill folders are not scanned.

It runs on Windows, macOS and Linux, needs only Node.js 18 or newer, and has no dependencies.

## Why

Agents are told which skills exist through a list with a limited size. Once you have installed a few dozen
skills, the host starts cutting their descriptions short, and many arrive at the model as a bare name. The model
cannot tell what they do, so it does the work by hand instead of using the tool you installed for exactly that
job. The usual workaround is to remind it every time: "use the X skill", "use the Y MCP server".

UreQuartermaster removes the need for that reminder. The agent reads one short instruction ("search first"),
and the full descriptions live in an index it can query.

## How it works

1. **Index.** `qm` finds skills in every agent's folders, skills inside Claude Code plugins, your library of
   collections, MCP servers declared in the agents' configurations (name, type and command only, never secrets),
   installed plugins and well-known CLIs on your `PATH`. The index rebuilds itself when it gets old or the
   folders change.
2. **Reformulated search.** For each non-trivial request the agent writes 3 to 6 short queries, in English and
   in your language, and runs them in one `qm search` call. Ranking is plain BM25 text search: fast (under
   300 ms with thousands of entries), local, no embeddings, no external service.
3. **Use.** The agent reads the full descriptions, picks one or more tools (a skill, an MCP server, a CLI),
   says so in one line, for example `→ Using: pdf + CLI gh`, loads them and does the work.
   For greetings and simple questions it does nothing.

In Claude Code, the plugin also adds a light `UserPromptSubmit` hook: a one-line reminder on non-trivial
prompts, plus up to five likely candidates when the index already has strong matches. It never rebuilds the
index and never uses the network. If loading the index takes more than 150 ms, or the index is stale, it adds only
the reminder; a run normally takes a few tens of milliseconds.

## Install

Any of these works; use only one, since every extra copy takes room in the same list this tool is freeing up.

**Any agent, with the [skills CLI](https://skills.sh):**

```bash
npx skills add dev-uretech/UreQuartermaster        # this project only
npx skills add dev-uretech/UreQuartermaster -g     # every project (global)
```

Update later with `npx skills update urequartermaster`.

**Claude Code plugin** (adds the hook):

```
/plugin marketplace add dev-uretech/UreQuartermaster
/plugin install urequartermaster@urequartermaster
```

In Claude Code the skill then appears as `urequartermaster:urequartermaster` (plugin name, then skill name).

To receive new versions automatically, turn on auto-update for this marketplace: run `/plugin`, open
**Marketplaces**, select `urequartermaster` and choose **Enable auto-update** (third-party marketplaces start with
it off). Without it, update with `claude plugin update urequartermaster@urequartermaster`.

**Manual copy.** Copy the `skills/urequartermaster` folder into your agent's skills folder, for example
`~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/` or `~/.gemini/skills/`. A manual copy in one of these
global folders updates itself (see [Updates](#updates)); a copy inside a project is never changed by `qm`.

**Other git hosts.** The repository is a plain git repository: mirror it on GitLab, Codeberg or your own server
and install from that URL with the skills CLI (`npx skills add <git-url>`) or with a manual clone and copy.

### Running `qm` yourself

The agent runs the tool on its own. When you want to run it, `qm` below stands for:

```bash
node "<skill folder>/scripts/qm.mjs"
```

where `<skill folder>` is the installed `urequartermaster` folder (for example
`~/.agents/skills/urequartermaster`, or for the plugin
`~/.claude/plugins/cache/urequartermaster/urequartermaster/<version>/skills/urequartermaster`). A shell alias
helps: `alias qm='node "$HOME/.agents/skills/urequartermaster/scripts/qm.mjs"'`.

## Quick start

```bash
qm init                                   # tell every agent, in its global instructions file, to search first
qm doctor                                 # duplicates, listing size, copies, Node, hook: what to fix
qm add https://github.com/google/skills   # put a large collection in the library, searchable but off the list
qm park <skill>                           # move a rarely used installed skill into the library
```

`qm init` adds a three-line block, between markers, to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`,
`~/.gemini/GEMINI.md`, `~/.copilot/copilot-instructions.md` and `~/.config/opencode/AGENTS.md` (only for agents
that are present). `qm init --dry-run` shows the changes, `qm init --remove` takes the block out.

The **library** (`~/.urequartermaster/library/`) is where skills go when you want them findable but not listed by
the host: whole collections added with `qm add`, and skills you park. Library skills are loaded on demand with
`qm load <name>`, which prints the skill and its base folder.

## Commands

| Command | What it does |
|---|---|
| `qm search <query>... [--limit N] [--kind skill\|mcp\|plugin\|cli] [--json]` | Search the index with one or more queries; shows each hit's full description and how to use it |
| `qm load <name\|id>` | Print a skill's `SKILL.md` and base folder (any skill, including library and disabled-plugin skills) |
| `qm list [--kind …] [--state installed\|library\|plugin-disabled\|available\|parked\|off\|disabled] [--all]` | List what is indexed (`--all` includes duplicates) |
| `qm index [--json]` | Rebuild the index now |
| `qm add <url> [--name <collection>]` | Clone a git collection of skills into the library (any git host) |
| `qm sync` | Pull every library collection and rebuild the index |
| `qm remove <collection>` | Delete a collection added with `qm add` from the library and rebuild the index |
| `qm park <skill>` | Move an installed skill from a user folder into the library |
| `qm park --plugin <plugin> [--yes]` | Disable a Claude Code plugin; its skills stay searchable and loadable |
| `qm unpark <skill> [--forget]` | Put a parked skill back; `--forget` drops the record of a park that cannot be undone |
| `qm mcp usage [--days N] [--json]` | Which Claude Code MCP servers each project really used, with their scopes and transports (read-only) |
| `qm mcp plan [--days N] [--min-projects N] [--json]` | Propose moving rarely used local MCP servers from user scope to the projects that use them |
| `qm mcp apply [--days N] [--min-projects N]` | Carry out that plan, after a backup of `~/.claude.json` |
| `qm mcp enable <server> [--project PATH]` | Switch a server on for one project (from the next session) |
| `qm mcp disable <server> [--project PATH]` | Switch it off again for that project |
| `qm mcp restore <server> [--project PATH \| --user]` | Put a parked server definition back in Claude Code's configuration |
| `qm init [--remove] [--dry-run] [--agent claude\|codex\|gemini\|copilot\|opencode]` | Add or remove the "search first" block in the agents' instruction files |
| `qm doctor` | Check duplicates, the estimated size of Claude Code's skill listing, one UreQuartermaster copy per agent, Node and the hook |
| `qm update [--check]` | Check for and install a signed release now |
| `qm rollback` | Go back to the version before the last update |
| `qm hook` | Used by the Claude Code hook (reads the prompt as JSON on stdin) |
| `qm --version`, `qm help` | Version and usage |

## MCP servers on demand (Claude Code)

Claude Code starts every stdio MCP server in scope when a session starts. A server configured at **user scope**
therefore runs as a local process in every session of every project, used or not: with twenty such servers and a
dozen open sessions, that is a few hundred processes and many gigabytes of memory. `qm mcp` keeps only the servers
that a project actually uses running there.

```bash
qm mcp usage                 # what each project really used in the last 14 days, scope and transport per server
qm mcp plan                  # what would move: nothing is changed
qm mcp apply                 # do it (backup of ~/.claude.json first)
qm mcp enable <server>       # need a server here? switch it on for this project, from the next session
qm mcp disable <server>      # and off again
qm mcp restore <server>      # put a parked definition back where it came from (or --user / --project PATH)
```

- **Usage** is counted from the MCP tool calls recorded in Claude Code's session transcripts
  (`~/.claude/projects/`, subagents included), per project folder. Only tool names, dates and folders are read.
- **The plan** keeps remote servers (http/sse: no local process) and stdio servers used in at least
  `--min-projects` projects (default 3). A stdio server used in fewer projects is copied into the local scope of
  each of them and removed from user scope; one not used at all is parked.
- **Nothing is deleted.** Every definition taken off user scope is kept whole in
  `~/.urequartermaster/parked-mcp.json` (mode 0600, as it can hold credentials) until you restore it.
- **Enable and disable** work per project. `disable` adds the server to the project's `disabledMcpServers` in
  `~/.claude.json`, the list Claude Code's own `/mcp` toggle writes, so the definition stays untouched; a copy that
  `enable` added from the parked store is removed instead. `enable` undoes either.
- **When it takes effect.** Claude Code reads MCP servers when a session starts: a change applies to the next
  session in that folder. In a running session you can switch a server that is already configured on or off at
  once with `/mcp`; a server that was not configured when the session started needs a new session.
- `qm search` lists servers that do not run here as `parked`, `off` (configured only in other projects) or
  `disabled`, with the command that enables them, so the agent can turn one on when a task needs it.
- **Safe writes.** `~/.claude.json` is written through a 0600 temporary file and a rename, after a timestamped
  0600 backup in `~/.urequartermaster/backups/` (the newest 20 are kept). The file is read again right before
  writing: if the MCP part changed since it was read (another session or command), nothing is written; if only
  other keys changed (Claude Code saves the file often), the change is applied to the fresh copy.
- `qm mcp` edits the JSON itself instead of calling `claude mcp add-json` / `claude mcp remove`: those would put a
  server's `env` (often its credentials) on a command line, visible to other processes, and `remove` drops the
  definition. Only Claude Code's configuration is managed; other agents' MCP files are not changed.

## Configuration

`~/.urequartermaster/config.json` (on Windows `%USERPROFILE%\.urequartermaster\config.json`). Every field is
optional; a missing or broken file means defaults. Set `UREQM_HOME` to an absolute path to move the whole data folder (a relative one is ignored).

```json
{
  "extraSkillDirs": ["/path/to/more/skills"],
  "clis": [{ "name": "mytool", "description": "Deploys our internal services" }],
  "autoUpdate": true,
  "hook": true,
  "maxIndexAgeHours": 24,
  "mcpDescriptions": { "crm": "Customer records, deals and notes in our CRM" },
  "trustProjectMcp": false
}
```

| Field | Default | Meaning |
|---|---|---|
| `extraSkillDirs` | `[]` | More folders of skills to index |
| `clis` | `[]` | Your own command-line tools, with a description the search can match |
| `autoUpdate` | `true` | Install signed releases automatically (manual copies only) |
| `hook` | `true` | Claude Code hook on or off |
| `maxIndexAgeHours` | `24` | Rebuild the index when it is older than this |
| `mcpDescriptions` | `{}` | Descriptions for your MCP servers, by server name; without one, a short description is derived from the server's command |
| `trustProjectMcp` | `false` | Also index MCP servers from a project's `.cursor/mcp.json` (Cursor keeps no approval record to check) |

## Updates

- Plugin and skills CLI installs are updated by their manager; `qm` tells you the command when a release is out.
  So are copies inside a project (for example `<repo>/.agents/skills`): `qm` never changes files in your
  repositories, it only says that a new version exists.
- A manual copy checks GitHub at most once a day (3-second timeout, silent when offline), downloads the release
  of that tag, **verifies its Ed25519 signature** against the public key built into the code, and swaps the
  folder atomically, keeping the previous version for `qm rollback`.
- Turn it off with `"autoUpdate": false` or the environment variable `UREQM_NO_UPDATE=1`.
- HTTP proxies (`HTTPS_PROXY`) are not supported: behind a proxy that blocks direct connections the check fails
  silently. Update with `qm update` from a network without one, or install the new release by hand.

## Security and privacy

- **Signed releases, for manual copies.** A manually installed copy updates itself only with a release whose
  Ed25519 signature verifies with the public key in the code. The private key never lives on GitHub or in CI, so
  a compromised GitHub account alone cannot push code to those copies. See [RELEASING.md](RELEASING.md).
- **Plugin and skills CLI installs are not covered by the signature.** Claude Code's marketplace and the skills
  CLI fetch the repository from GitHub themselves: they trust GitHub and the manager, and `qm` does not verify what
  they install. If that matters to you, use a **manual install** (copy the skill folder from a release you
  checked) and let it update itself with signed releases.
- **No telemetry.** The network is used only by `qm add`, `qm sync` and the update check (one fixed URL,
  `https://api.github.com/repos/dev-uretech/UreQuartermaster/releases/latest`).
- **Never read by the index:** the `env`, `headers` and authentication fields of MCP configurations. Secrets inside a server's
  arguments (`--token=…`, `--api-key …`, `?key=` in URLs) are redacted. Nothing secret is stored in the index or
  printed.
- **`qm mcp` moves definitions whole.** To move or park a Claude Code server it copies the server's complete
  definition (including `env` and `headers`) between `~/.claude.json` and the parked store, both mode 0600. It never
  prints, logs or indexes any of it: the output shows server names, scopes, transports, folders and counts only.
- **MCP descriptions** are built from an allowlist (command name, package or image name, script name, URL host);
  a flag's value is never used. The server **name you chose** in your configuration is shown as it is.
- **Third-party text is data.** Search results and loaded skills are marked as third-party content, and the skill
  tells the agent not to follow requests in them to install, download or send data.
- **Project entries** (skills in the current repository's `.claude/skills` and `.agents/skills`, and its MCP
  servers) are flagged as untrusted. Project MCP servers count only once approved in Claude Code (Cursor's only
  with `trustProjectMcp`). Project and library skills are loaded only if their files stay inside their own folder.
- **No silent changes.** Agent configurations are changed only by `qm init`, `qm park --plugin` and the `qm mcp`
  commands that change something (`apply`, `enable`, `disable`, `restore`), which you run; the skill lets the agent
  run `qm mcp enable` for the current project when a task needs a server, and tell you.
  `qm park` and `qm unpark` also move skill folders out of and back into your agents' skill folders, and update the
  skills CLI's `~/.agents/.skill-lock.json` for the skills they move. Node.js is never installed without your
  consent.

## Limitations and notes

- `qm sync` resets each collection to its upstream: local edits inside a collection in the library are discarded.
- After an interrupted park, a file you deliberately deleted from the source folder comes back on unpark.
- `qm unpark --forget` gets you out of a park or unpark that is stuck (for example, the folder was moved by hand).
- On Windows, when only `claude.cmd` is on the `PATH`, `qm park --plugin` prints the `claude plugin disable`
  command for you to run by hand.
- Skills that are symbolic links inside a project or the library are ignored.
- If an update is killed between its two renames, the previous version is in `~/.urequartermaster/backup/`:
  copy it back to the skill folder.
- `qm mcp usage` reads every transcript changed in the period (several GB for heavy users take some seconds).
  Sessions started in a subfolder count as their own project, as they do for Claude Code.
- In v1 MCP servers are not started to read their tool lists (most need credentials to start). The index points
  to the server; the agent's own tool search finds the tool.

## Acceptance results

Measured in October 2026 with Claude Code 2.1.302 and Codex CLI 0.164.0, against a fixed bench: 59 installed skills,
232 skills in the library (including google/skills), 10 MCP servers and 10 command-line programs (`eval/`). Each
request is run once, non-interactively; the agent may look tools up but must not carry out the request, and ends
with one line naming the tools it would use. A request is correct when every expected tool is named (some
requests accept equivalent alternatives) and nothing is named when no tool is needed.

The 50 held-out requests (business tasks of many kinds, plus small talk that needs no tool) were written by a
separate author and never used while tuning. Target: at least 98% (49/50) per language and per agent.

| Agent | it | en | es | fr | de | pt |
|---|---|---|---|---|---|---|
| Claude Code | 49/50 | 49/50 | 10/10\* | 10/10\* | 10/10\* | 10/10\* |
| Codex | 50/50 | 49/50 | – | – | – | – |

\* Sample of the first 10 held-out requests, to keep the cost of the test down. Spanish, French, German and
Portuguese on Codex were not measured.

- The one error left is the same request in all three cases: a Stripe task where the agent named the `stripe`
  command-line program, which is not installed, instead of the Stripe MCP server that is.
- On a real Mac, with the author's own skills and MCP servers and 20 requests in Italian, Claude Code chose
  correctly 18 times. One miss picked a general video skill instead of a more specific one from the same plugin;
  the other run was stopped because Claude Code ran a read-only `ls` on its own, before naming a tool.
- On a machine where most tools are already installed, Claude Code often finds them with its own tool search and
  skill list; `qm` matters most for the skills kept in the library.

## Project layout

```
skills/urequartermaster/   the skill: SKILL.md, plus the CLI in scripts/ (entry point and lib/ modules)
.claude-plugin/, hooks/    Claude Code plugin, marketplace and prompt hook
scripts/                   maintainer tools: signing key, release, re-signing
test/                      node --test suites
eval/                      acceptance bench (catalogue, requests, runner, scorer)
docs/                      ARCHITECTURE.md and DESIGN.md
```

## Contributing

Issues and pull requests are welcome at
[github.com/dev-uretech/UreQuartermaster](https://github.com/dev-uretech/UreQuartermaster). Keep it dependency-free
and cross-platform; run `npm test` (Node's built-in test runner) before sending changes.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps the code, its data flow and its security rules;
[docs/DESIGN.md](docs/DESIGN.md) explains the goals and the main decisions behind them.

## License

MIT © UreTech. See [LICENSE](LICENSE).
