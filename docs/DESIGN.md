# Design

Why UreQuartermaster exists, what it tries to do and not do, and the reasons behind its main decisions. For how
the code is organised, see [ARCHITECTURE.md](ARCHITECTURE.md).

## The problem

People who use coding agents (Claude Code, Codex, Gemini CLI, Cursor, Copilot CLI, OpenCode…) keep installing
skills, MCP servers, plugins and command-line tools. Past a certain number, the agent stops using them. The host
gives the model a list of the available skills with a limited character budget; once it is full, descriptions are
cut, and with a couple of hundred skills more than half reach the model as a bare name. The model cannot tell
what they do, so it does the work by hand instead of using the tool that was installed for exactly that job. The
only workaround is for the user to keep saying "use the X skill", "use the Y MCP server".

UreQuartermaster (the quartermaster knows the whole store) keeps a local index of everything installed and makes
the agent search it before each non-trivial request. It succeeds when the user no longer has to name the tool.

## Goals

1. **Search on every non-trivial request.** Before working, the agent looks for a local tool that does the job
   better. It rewrites the request several ways, in English and in the user's language (requests are often not in
   English; descriptions almost always are), queries the index and reads the full descriptions of the candidates.
2. **Use what it finds, at once.** No confirmation unless two different approaches are equally plausible and the
   choice changes the result. Several tools can be combined (a skill for the method, an MCP server for the data, a
   CLI to deploy). When nothing fits, the agent works normally and wastes no time.
3. **One line of transparency.** The agent says what it chose, e.g. `→ Using: seo-audit + MCP search-console`.
4. **A library.** Rarely used skills and large collections live outside the folders the host lists: they cost
   nothing from the budget and remain searchable with their full descriptions.
5. **Inventory of everything local:** skills, MCP servers, plugins and CLIs.
6. **For everyone.** Any agent that supports Agent Skills, on Windows, macOS and Linux; installable like any other
   skill; free, MIT licensed.
7. **Keeps itself up to date** with each official release.

## Non-goals

- Not an online catalogue or an installer. It searches only what is already on the computer; the network is used
  only by `qm add`, `qm sync` and the update check.
- No embeddings, local models or external services for search. The intelligence (rewriting the request, choosing)
  comes from the agent's own model; the index only does fast text search.
- Not a replacement for the host's own tool search (for example Claude Code's search for deferred MCP tools): it
  points the agent at the right server and lets the host find the tool.
- No change to an agent's configuration without an explicit command from the user.

## Failure even if it "works"

- Slowing down every request or filling the conversation with text. A search must be cheap and its output
  compact: candidates with descriptions, not whole files.
- Asking for confirmation all the time.
- Becoming an attack vector. Third-party skill text is data, never an instruction beyond the chosen task; no
  credential (MCP `env`, headers, tokens) ever reaches the index or the output.
- Installing runtimes or changing the system behind the user's back.

## Main decisions

**An Agent Skill plus a small CLI.** The repository is one skill in the Agent Skills format
(`skills/urequartermaster/SKILL.md` and `scripts/`), plus a Claude Code plugin and marketplace manifest. It installs
with the skills CLI (`npx skills add`, which covers dozens of agents), as a Claude Code plugin, or by copying the
folder from any git host. The `SKILL.md` carries the procedure; `qm` does the indexing and searching.

**Node.js, no dependencies.** `qm` is plain ES modules on Node 18+, using only the standard library. People who
install with `npx` already have Node, and nothing has to be downloaded at install time. Paths are resolved per
operating system (`os.homedir()`, `%APPDATA%`, XDG); no shell commands specific to one system are used.

**A fallback without Node.** If `node` is missing, `SKILL.md` tells the agent to search the known skill folders
with its own file tools, then to propose the system's command to install Node, and to run it only with the user's
consent. Nothing is installed silently.

**BM25, not embeddings.** Plain BM25 over name, description and headings, with several queries per call, is fast
(well under 300 ms with thousands of entries), deterministic, local and dependency-free. The model supplies the
semantics by writing the queries, including English ones for non-English requests.

**MCP servers are not started.** Reading their tool lists would mean launching them, and most need credentials to
start; reading those would break the rule that no secret is ever read. The index records the server (name, type,
command) with a description built from an allowlist; the agent's host already knows the tool names. The user can
write a better description in `config.json`.

**A reminder, not a classifier, to make it trigger.** The skill's own description is subject to the same budget
cut, so it is short and starts with when to use it. In Claude Code the plugin adds a light `UserPromptSubmit` hook:
on longer prompts it always adds a one-line reminder, plus up to five candidates when the index already has strong
matches for the raw prompt. The reminder is the reliable part; candidates are a hint (raw non-English text against
English descriptions matches poorly, and the real search is the model's rewritten queries). The hook never
rebuilds the index or touches the network, and gives up on candidates if loading takes over 150 ms. For other
agents, `qm init` (run by the user, never automatically) adds a three-line block between markers to the global
instruction files, removable with `qm init --remove`.

**A library outside the listed folders.** `qm add` clones a git collection into `~/.urequartermaster/library/`;
`qm park` moves an installed skill there, with a record so `qm unpark` can put it back exactly (including the
skills CLI lock entry, so `npx skills update` does not reinstall it). Skills from a plugin are not moved, since the
plugin manager would restore them: `qm park --plugin` disables the plugin with the host's own command, and its
skills stay searchable and loadable from the plugin cache.

**Signed self-updates for manual copies.** Copies installed by a manager (plugin marketplace, skills CLI) are
updated by that manager; `qm` only says that a release is out. A manual copy checks the latest GitHub release at
most once a day, downloads the bundle of that tag, verifies an Ed25519 signature against the public key built into
the code, and swaps the folder atomically, keeping a backup for `qm rollback`. The private key never lives on
GitHub or in CI, so a compromised account cannot ship code to those copies. Key rotation ships the new public key
inside a release signed with the old one ([RELEASING.md](../RELEASING.md)). Automatic updates are on by default
and can be turned off.

**One copy at a time.** Every extra installed copy consumes the same budget the tool is meant to free, so
`qm doctor` reports duplicates.

**An acceptance test that cannot be tuned to.** About 50 realistic requests covering many kinds of work (code,
documents, data, SEO and ads, video, sales, cloud, security, design, e-commerce, support), plus small talk that
needs no tool, written naturally in six languages and run non-interactively on Claude Code and Codex against a
fixed, reproducible catalogue of public skill collections, MCP servers and CLIs (`eval/`). Requests are split into
a development set, used to tune `SKILL.md` and the search, and a held-out set that is never looked at while
tuning. The target is at least 98% correct per language and per agent on the held-out set.

## Known limitations

- MCP tool lists are not indexed (see above): the agent finds the server, then the tool through its host.
- Cursor's and Copilot's own skill folders are not scanned: their paths could not be verified against current
  documentation.
- HTTP proxies are not supported by the update check, which then fails silently.
- `qm sync` resets each collection to its upstream: local edits inside a library collection are discarded.
- After an interrupted park, a file deliberately deleted from the source folder comes back on unpark.
- On Windows, when only `claude.cmd` is on `PATH`, `qm park --plugin` prints the command instead of running it
  (a `.cmd` cannot be started without a shell, and `qm` never uses one).
- Skills that are symbolic links inside a project or the library are ignored.
- Plugin and skills CLI installs are not covered by the release signature: they trust GitHub and their manager.
