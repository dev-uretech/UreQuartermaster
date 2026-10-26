// `qm update` (foreground, --check, or the detached --background child) and `qm rollback`.
// Only a manual copy is ever replaced; managed copies are told to use their installer.
import { clean } from '../core/text.mjs';
import { runUpdate, SKILL_DIR } from '../update/update.mjs';
import { rollback } from '../update/install.mjs';
import { installKind, MANAGER_COMMANDS } from '../update/install-kind.mjs';
import { UsageError, parseArgs, guarded } from './common.mjs';

const UPDATE_EXIT = { updated: 0, current: 0, available: 0, managed: 0, checkout: 0, project: 0 };

export async function cmdUpdate(argv, out) {
  const { pos, flags } = parseArgs(argv, { check: 'bool', background: 'bool' });
  if (pos.length) throw new UsageError('qm update takes no arguments');
  if (flags.background) {
    // Detached child started by autoUpdateTick: the outcome is stored in state.json.
    try { await runUpdate({ mode: 'background' }); } catch {}
    return 0;
  }
  const r = await runUpdate({ mode: flags.check ? 'check' : 'foreground' });
  const code = Object.hasOwn(UPDATE_EXIT, r.status) ? UPDATE_EXIT[r.status] : 1;
  if (r.message) {
    if (code) process.stderr.write(`qm update: ${r.message}\n`);
    else out(r.message);
  }
  return code;
}

export const cmdRollback = guarded((argv, out) => {
  parseArgs(argv, {});
  if (argv.length) throw new UsageError('qm rollback takes no arguments');
  const kind = installKind(SKILL_DIR);
  if (kind !== 'manual') throw new Error(`this copy is managed by its installer; change versions with it${MANAGER_COMMANDS[kind] ? ` (${MANAGER_COMMANDS[kind]})` : ''}`);
  const r = rollback(SKILL_DIR);
  out(`Rolled back UreQuartermaster from ${clean(r.from)} to ${clean(r.to)}.`);
  out('Automatic updates will install newer releases again; to stay on this version set "autoUpdate": false in config.json.');
  return 0;
});
