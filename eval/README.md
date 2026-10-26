# Test bench

`node eval/build-catalog.mjs` builds the fake home in `eval/.cache/bench/home` (git-ignored); `node eval/run.mjs` runs the agents; `node eval/score.mjs <results-folder>` scores the results.

## Expected answers

In `eval/requests/*.jsonl` each item of `expected` is a tool id (`skill:seo-audit`, `mcp:github`, `cli:gh`). An item can list alternatives separated by `|` (`mcp:github|cli:gh`): it is satisfied when the agent picks at least one of them; picking two does not count as an extra tool.

## Keychain on macOS

On macOS Claude Code keeps its login in the default keychain, which it finds through `$HOME`. With the fake home the login would fail, so `build-catalog.mjs` creates `home/Library/Keychains/bench.keychain-db` (empty password) with the `security` command, always with `HOME` set to the fake home: the user's real keychain is not touched. The file lives in `eval/.cache`, so outside git. Delete it when the runs are over (`rm -rf eval/.cache/bench`). Claude finds its login entry through `$USER`, which is why `USER` and `LOGNAME` are in the list of allowed variables.
