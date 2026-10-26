// `qm init`: adds, updates or removes the "search first" block in the agents' instruction files.
import { clean } from '../core/text.mjs';
import { initAgents } from '../agent/init.mjs';
import { UsageError, parseArgs, guarded } from './common.mjs';

export const cmdInit = guarded((argv, out) => {
  const { pos, flags } = parseArgs(argv, { remove: 'bool', 'dry-run': 'bool', agent: 'value' });
  if (pos.length) throw new UsageError('qm init takes no arguments');
  const agents = flags.agent ? [flags.agent] : undefined;
  if (agents && !['claude', 'codex', 'gemini', 'copilot', 'opencode'].includes(flags.agent)) throw new UsageError(`Unknown agent "${clean(flags.agent)}"`);
  const dry = !!flags['dry-run'];
  const res = initAgents({ remove: !!flags.remove, dryRun: dry, agents });
  const verb = { added: 'add the block to', created: 'create', updated: 'update the block in', removed: 'remove the block from' };
  const done = { added: 'Added the block to', created: 'Created', updated: 'Updated the block in', removed: 'Removed the block from' };
  let changed = 0;
  for (const r of res) {
    if (r.warning) process.stderr.write(`Skipped ${clean(r.file)}: ${clean(r.warning)}\n`);
    else if (r.changed) { changed++; out(dry ? `Would ${verb[r.action]} ${clean(r.file)}` : `${done[r.action]} ${clean(r.file)}`); }
  }
  if (!changed) out(flags.remove ? 'Nothing to remove.' : 'Nothing to change (files already up to date, or no agent instruction file found).');
  // Failure only when files were found but every one of them had to be skipped.
  const found = res.filter((r) => r.present);
  return found.length && found.every((r) => r.warning) ? 1 : 0;
});
