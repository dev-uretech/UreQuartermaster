# Architecture

UreQuartermaster is an Agent Skill (`skills/urequartermaster/SKILL.md`) plus a dependency-free Node.js CLI, `qm`.
`qm` indexes the skills, MCP servers, plugins and command-line tools installed on the machine; the skill tells the
agent to search that index before each non-trivial request and to use what it finds. Why it is built this way is
in [DESIGN.md](DESIGN.md).

## Repository layout

```
skills/urequartermaster/      the skill that gets installed (the only shipped folder)
  SKILL.md                    procedure the agent follows
  scripts/qm.mjs              CLI entry point (path is fixed: SKILL.md, hooks and installed copies call it)
  scripts/lib/                the CLI's modules (map below)
    cli.mjs                   command table and dispatch
    commands/                 one module per command family: parse arguments, print results
    core/                     paths, config and state, text cleaning, file helpers, PATH lookup
    scan/                     finds skills, MCP servers, plugins and CLIs (scan/mcp/: redaction, parsers)
    index/                    builds, refreshes and searches the index
    library/                  add, sync, park, unpark
    update/                   signed self-update and rollback
    agent/                    what touches the agents: init block, prompt hook, doctor
    version.mjs, pubkey.mjs   release contract: bundles and release tools read them at these paths
.claude-plugin/               Claude Code plugin and marketplace manifests
hooks/hooks.json              Claude Code UserPromptSubmit hook: runs `qm hook`
scripts/                      maintainer tools, not shipped: keygen, release, resign
test/                         node --test suites and fixtures
eval/                         acceptance bench: catalogue, requests, runner, scorer
docs/                         this file and DESIGN.md
```

## Module map

All under `skills/urequartermaster/scripts/lib/`. Imports point one way: `commands/` and `cli.mjs` use everything;
`library/`, `update/` and `agent/` use `index/`, `scan/` and `core/`; `index/` uses `scan/` and `core/`; `scan/` uses
`core/`; `core/` uses nothing else. Each module starts with a short comment saying what it does and what it must
never do.

| Module | Responsibility |
|---|---|
| `cli.mjs` | Usage text, the command table and `dispatch` (with the background update tick) |
| `commands/common.mjs` | Argument parsing, `UsageError`, third-party notices, error cleaning |
| `commands/search.mjs`, `load.mjs`, `list.mjs` | `qm search`, `qm load`, `qm list` and `qm index` |
| `commands/library.mjs` | `qm add`, `sync`, `park`, `unpark` |
| `commands/init.mjs`, `doctor.mjs`, `update.mjs` | `qm init`, `qm doctor`, `qm update` and `qm rollback` |
| `core/paths.mjs` | Data folder and every agent's file locations, per platform |
| `core/config.mjs` | `config.json` and `state.json`: tolerant load, atomic save |
| `core/text.mjs` | `clean()` / `cleanBody()`: strip control characters from third-party text |
| `core/files.mjs` | Never-throwing file reads, `readJsonObject`, atomic `writeFileAtomic` |
| `core/options.mjs` | The environment of a command (home, platform, env, cwd, data folder, clock), overridable in tests |
| `core/which.mjs` | PATH resolution of executables, without running them or using a shell |
| `version.mjs` | The version, set only here (read by the release tools and inside bundles) |
| `pubkey.mjs` | The Ed25519 public key releases must be signed with |
| `scan/frontmatter.mjs` | SKILL.md reader: a small YAML subset, headings, first paragraph |
| `scan/skills.mjs` | Skills from agent folders, Claude Code plugins and the library; duplicates |
| `scan/trust.mjs` | Safe-name rules and containment checks for project and library skills (scan and load time) |
| `scan/claude-plugins.mjs` | Installed Claude Code plugins, their folders and enabled flags |
| `scan/mcp.mjs` | MCP servers from every agent's config and from enabled plugins; content fingerprint |
| `scan/mcp/redact.mjs` | Redaction of secrets in command lines, URLs, headers and JSON fragments |
| `scan/mcp/describe.mjs` | Allowlist description of a server (command, packages, images, scripts, URL origin) |
| `scan/mcp/toml.mjs` | TOML subset for Codex's `config.toml`: keeps only the server fields |
| `scan/mcp/jsonc.mjs` | Size-capped JSON reading with comments and trailing commas |
| `scan/plugins.mjs` | One entry per Claude Code plugin, from its manifest |
| `scan/cli-tools.mjs` | Curated CLIs and `config.clis` found on `PATH` |
| `index/index.mjs` | Build, store, load and refresh `index.json`; add project entries on read |
| `index/locations.mjs` | Split the agents' locations into global (indexed) and project-scoped (live) |
| `index/fingerprint.mjs` | What the index was built from: folder mtimes plus the MCP servers by content |
| `index/project.mjs` | Live scan of the current project's skills and approved MCP servers |
| `index/search.mjs` | Tokenizer and multi-query BM25 |
| `library/collections.mjs` | `qm add` and `qm sync`: git collections in the library |
| `library/park.mjs` | `qm park`: move an installed skill into `library/_parked/`, with a record first |
| `library/unpark.mjs` | `qm unpark` and `--forget`: restore, resume an interrupted move, or drop the record |
| `library/plugin.mjs` | `qm park --plugin`: build or run `claude plugin disable` |
| `library/names.mjs` | Accepted sources, collection names and folder names (allowlists) |
| `library/git.mjs` | Running git safely (PATH-resolved, no shell, hooks and symlinks off) |
| `library/move.mjs` | Folder moves: rename, or copy + verify + delete across devices; folder links |
| `library/skills-lock.mjs` | Format-preserving read and write of the skills CLI lock file |
| `library/store.mjs` | Library and parked folders on disk; index rebuild after a change |
| `update/bundle.mjs` | Release bundle format, path checks, signature verification |
| `update/update.mjs` | One update run (`qm update`, background child) and the daily background tick |
| `update/release.mjs` | Latest-release check (once a day), release document validation, asset download |
| `update/net.mjs` | HTTPS GET restricted to GitHub hosts, with redirects, deadline and byte cap |
| `update/install.mjs` | Verify and install a bundle by renames, with backups; `qm rollback` |
| `update/install-kind.mjs` | Plugin, skills CLI, manual, project or git checkout: who may update this copy |
| `update/lock.mjs` | The exclusive update lock, with race-free takeover of a stale one |
| `agent/init.mjs` | The marked block in the agents' instruction files |
| `agent/hook.mjs` | The `UserPromptSubmit` hook |
| `agent/doctor.mjs` | Read-only diagnosis |

## Data flow

**Scan → index.** `buildIndex` runs four scanners over the locations returned by `agentLocations()` (one pure
function that knows where every agent keeps its skills, MCP configs and instruction files, for any platform):
skills (agent folders, Claude Code plugins, the library), MCP servers (each agent's config file), Claude Code
plugins (manifests) and CLIs (a curated list plus `config.clis`, found on `PATH`). The result, with a fingerprint
of what was scanned, is saved as `index.json`. Only global (personal) locations are saved; the current project's
skills and approved MCP servers are scanned live on each call and added as untrusted entries that can never shadow
a global one.

**Freshness.** `ensureIndex` rebuilds when the index is missing, older than `maxIndexAgeHours`, or its fingerprint
changed. The fingerprint has two parts: the mtimes of the watched skill folders, plugin files and library, and a
hash of the MCP servers *as they would be indexed* (content, not mtime, because Claude Code rewrites
`~/.claude.json` on almost every tool call).

**Search → agent.** `qm search` runs BM25 over name, description and headings for several queries at once and
prints, per hit, the kind, name, state, full description and a `use:` line. The agent picks tools, prints its
`→ Using:` line and loads them: installed skills the host's own way, library and disabled-plugin skills with
`qm load` (which re-checks the skill's files before printing them).

**Hook.** In Claude Code, `hooks/hooks.json` runs `qm hook` on every prompt. It reads the stored index only (no
rebuild, no project scan, no network, no update check), adds a one-line reminder to non-trivial prompts and up to
five strong candidates, and skips the candidates if loading took more than 150 ms. Any error yields empty output.

**Library.** `qm add` validates the source, clones it with git into `library/<name>`, then rebuilds the index.
`qm sync` fetches and resets each git collection. `qm park` moves an installed skill into `library/_parked/` and
records where it came from, its links and its skills CLI lock entry; `qm unpark` reverses it, and both resume
safely after a crash. `qm park --plugin` builds (and, with `--yes`, runs) `claude plugin disable`.

**Update and signing.** Commands that use the index (`search`, `load`, `list`, `index`, never the hook) call
`autoUpdateTick`: it prints a stored update message once and, at most once a day, starts `qm update --background`
as a detached child. The update asks the GitHub API for the latest release, decides what kind of install this is
(plugin, skills CLI, manual, inside a project, or a git checkout of this repository: only manual copies are
replaced), downloads the two release assets, verifies the signature and the bundle, and swaps the folder.
`release.mjs` builds and signs the bundle on the maintainer's machine.

## On-disk formats

Data folder: `UREQM_HOME` when it is an absolute path, else `~/.urequartermaster` (`%USERPROFILE%` on Windows).

| Path | Content |
|---|---|
| `index.json` | `{ version: 2, builtAt, fingerprint, entries[] }`. Each entry: `id` (`<kind>:<name>`, `@<source>` and `#n` suffixes for duplicates), `kind` (`skill`, `mcp`, `plugin`, `cli`), `name`, `description`, `headings`, `path`, `source`, `state` (`installed`, `library`, `plugin-disabled`, `available`), `usage`, optional `duplicateOf` and `trustRoot`. Another `version` is ignored and rebuilt. |
| `config.json` | User settings: `extraSkillDirs`, `clis`, `autoUpdate`, `hook`, `maxIndexAgeHours`, `mcpDescriptions`, `trustProjectMcp`. Missing, corrupt or wrong-typed fields fall back to defaults. |
| `state.json` | Bookkeeping: `lastUpdateCheck`, `installedVersion`, `lastUpdateMessage`, `parked[]` (`name`, `from`, `to`, `links`, `lockKey`/`lockIndex`/`lockEntry`, and `pending` or `interrupted` while a move is unfinished). |
| `library/<collection>/` | A git collection added with `qm add`. `.tmp-*` folders are interrupted clones, removed after an hour. |
| `library/_parked/<skill>/` | A parked skill. |
| `backup/<version>-<timestamp>[-n]/` | Previous versions kept by updates and rollbacks (three at most). |
| `update.lock` | Exclusive lock of an update or rollback (`wx` create; taken over when older than 10 minutes). |

JSON files are written atomically (temporary file, then rename). The skills CLI's `~/.agents/.skill-lock.json` is
rewritten by park and unpark with its original indentation, line endings, BOM and key order.

A release is `urequartermaster-X.Y.Z.bundle.gz` (gzip of `{ files: { "<relative path>": "<base64>" }, notes?,
version }` with sorted keys), `….bundle.gz.sig` (base64 Ed25519 signature of the gzip bytes) and `SHA256SUMS`.
The version a bundle carries is read from `scripts/lib/version.mjs` inside it; that path is part of the format.

## Security model

- **Third-party text is data.** Skill names, descriptions and bodies, MCP names and git messages are passed through
  `clean()` (no control characters, terminal escapes or bidi overrides) before they are printed. Search and load
  output is headed by a notice that it is third-party content, and project entries are flagged as untrusted.
- **Names are validated.** A skill name is the one third-party field the agent puts on a command line
  (`qm load <name>`), so it must be letters, digits, marks, `.`, `_`, `-`, start with a letter or digit, and be at
  most 128 characters; unsafe names are replaced by a sanitised folder name or dropped. Collection names, plugin
  keys and parked folder names have their own allowlists, including Windows reserved names.
- **Containment.** Project and library skills are indexed and loaded only when the folder and `SKILL.md` are plain
  (not links) and their real paths stay inside the project or the collection; `qm load` re-checks this. The
  library folder and each collection must not be symbolic links. Bundle paths are checked segment by segment
  before anything is written, and installed only inside the staging folder.
- **No secrets.** From MCP configs only `type`, `command`, `args`, `url` (and `enabled`) are read; `env`,
  `headers` and auth fields are never copied. Descriptions are built from an allowlist of tokens (command
  basename, package or image name, script basename, URL origin), and a flag's value is never used. The TOML reader
  builds strings only for the fields it keeps. From Claude's `settings.json` only `enabledPlugins` is read.
  Unreadable or malformed files are skipped silently so that no error message carries file content. The release
  scripts read the private key into memory only, and never print it.
- **Signed updates.** Nothing is installed unless the bundle verifies against the Ed25519 key in `pubkey.mjs`,
  declares exactly the release tag's version, is newer than the installed one, and passes `readBundle()`. Requests
  go only to allowlisted GitHub hosts over https, with byte caps, a deadline and at most three redirects. The swap
  uses renames under a lock, with a backup, so an interrupted update leaves a working copy.
- **PATH resolution.** `git` and `claude` are resolved to an absolute path from `PATH` only (relative entries are
  ignored, and on Windows only `.exe` is accepted), are run with an argument array and never through a shell, and
  `git` runs from the temp folder with hooks, symlinks and the `ext` protocol disabled. A program planted in the
  current project is never the one that runs.
- **No silent changes.** Agent configurations are changed only by `qm init` and `qm park --plugin`, both run by
  the user. `qm init` preserves the rest of each file byte for byte and refuses links outside the home folder,
  hard links and UTF-16 files.

## Platform notes

- `agentLocations()` takes the platform as an argument and uses `path.win32` or `path.posix` accordingly, so
  Windows paths are tested on every OS. VS Code's user folder is `%APPDATA%\Code\User` on Windows,
  `~/Library/Application Support/Code/User` on macOS and `$XDG_CONFIG_HOME/Code/User` on Linux.
- On Windows, executables are matched with `PATHEXT`; for git and claude only `.exe` counts. Unpark recreates
  folder links as junctions, which need no Developer Mode.
- Moving folders across devices (`EXDEV`) falls back to copy, verify and delete.
- Claude Code may store Windows project paths with forward slashes in `~/.claude.json`; both forms are looked up.

## Tests and evaluation

```bash
npm test                         # node --test: every suite under test/, no network
node eval/build-catalog.mjs      # build the fake home of the acceptance bench (clones pinned collections)
node eval/run.mjs --agent claude --lang en --set dev   # run real agents against it
node eval/score.mjs <results-folder>                   # score the transcripts
```

The bench requests are split into `dev` (for tuning) and `holdout` (for the final measurement only). See
[eval/README.md](../eval/README.md).
