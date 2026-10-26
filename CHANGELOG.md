# Changelog

All notable changes to UreQuartermaster. Versions follow semantic versioning; each release is tagged `vX.Y.Z`.

## 1.0.2

- `qm remove <collection>` removes a git collection added with `qm add` from the library and rebuilds the index.
  It refuses unknown names, the `_parked` folder (parked skills come back with `qm unpark`), names with path
  separators or `..`, links, and folders that are not git clones.
- `qm doctor` no longer warns about several copies of UreQuartermaster when each agent has its own (for example the
  Claude Code plugin plus a skills CLI copy for Codex in `~/.agents/skills`, which Claude Code does not read). It
  warns only when one agent would load two copies, and otherwise prints which agent uses which copy.
- `qm doctor` no longer warns past 60 installed skills: Claude Code has no documented skill-count limit. It now
  estimates the size of Claude Code's skill listing (names plus descriptions of the skills Claude Code reads, each
  description capped at 1,536 characters) and warns only above 8,000 characters, the budget Claude Code uses when
  the context window is unknown.

## 1.0.1

- When a skill refers to another skill that is not installed (for example a sub-skill moved to the library
  with `qm park`), the agent now loads it with `qm load` instead of giving up. Same hint in the `qm init` block.

## 1.0.0

First public release.

- `SKILL.md` that makes the agent search its local tools before every non-trivial request: 3 to 6 queries in
  English and the user's language, one search, a one-line "Using" declaration, then the chosen tools.
- `qm` CLI (Node.js 18+, no dependencies, Windows, macOS, Linux): `search`, `load`, `list`, `index`, `doctor`.
- Index of skills (agent folders, Claude Code plugins, project, library), MCP servers (name, type and command only;
  secrets never read, arguments redacted), plugins and well-known CLIs; rebuilds itself when stale.
- BM25 multi-query search under 300 ms with thousands of entries; third-party text marked as data.
- Library: `qm add` and `qm sync` for git collections, `qm park` / `qm unpark` for installed skills,
  `qm park --plugin` to disable a Claude Code plugin while keeping its skills loadable.
- Claude Code plugin and marketplace, with a `UserPromptSubmit` hook (reminder plus candidates; candidates are
  skipped when loading the index takes more than 150 ms).
- `qm init` to add a "search first" block to the global instruction files of Claude Code, Codex, Gemini CLI,
  Copilot and OpenCode, removable with `qm init --remove`.
- Automatic updates for manual copies, accepted only with a valid Ed25519 signature, with `qm rollback`.
