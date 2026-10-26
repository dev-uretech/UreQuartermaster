# Changelog

All notable changes to UreQuartermaster. Versions follow semantic versioning; each release is tagged `vX.Y.Z`.

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
