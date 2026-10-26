// `qm add`, `qm sync`, `qm park` (skills and --plugin) and `qm unpark`. Their errors can carry git
// output or third-party names, so every handler runs through guarded() and prints cleaned text only.
import { buildIndex, saveIndex } from '../index/index.mjs';
import { dataDir } from '../core/paths.mjs';
import { clean } from '../core/text.mjs';
import { addCollection, syncCollections } from '../library/collections.mjs';
import { park } from '../library/park.mjs';
import { unpark, forget } from '../library/unpark.mjs';
import { parkPlugin } from '../library/plugin.mjs';
import { UsageError, parseArgs, oneLine, guarded } from './common.mjs';

export const cmdAdd = guarded((argv, out) => {
  const { pos, flags } = parseArgs(argv, { name: 'value' });
  if (pos.length !== 1) throw new UsageError('add needs exactly one git URL or local folder');
  const r = addCollection(pos[0], flags.name !== undefined ? { name: flags.name } : {});
  out(`Added "${clean(r.name)}": ${r.skills} skill${r.skills === 1 ? '' : 's'} in ${clean(r.path)}`);
  out('# Collection content is third-party: skills are listed as state "library"; read one with qm load before trusting it.');
  return 0;
});

export const cmdSync = guarded((argv, out) => {
  parseArgs(argv, {});
  const res = syncCollections();
  if (!res.length) out('No git collections in the library.');
  let failed = 0;
  for (const r of res) {
    if (r.error) { failed++; out(`${clean(r.name)}: failed (${oneLine(r.error)})`); }
    else out(`${clean(r.name)}: ${r.updated ? 'updated' : 'up to date'}`);
  }
  return failed ? 1 : 0;
});

export const cmdPark = guarded((argv, out) => {
  const { pos, flags } = parseArgs(argv, { plugin: 'value', yes: 'bool' });
  if (flags.plugin !== undefined) {
    if (pos.length) throw new UsageError('park --plugin takes the plugin name only');
    const r = parkPlugin(flags.plugin, { yes: flags.yes === true });
    const where = r.cwd ? ` (run it from ${clean(r.cwd)})` : '';
    if (!r.ran) {
      if (r.error) {
        out(`Run this yourself: ${clean(r.command)}${where}`);
        out(`(not run: ${oneLine(r.error)})`);
        return 1;
      }
      out(`Run this command to park the plugin (it changes the Claude Code configuration)${where}:\n  ${clean(r.command)}\nOr let qm run it: qm park --plugin ${clean(flags.plugin)} --yes`);
      return 0;
    }
    out(`${r.ok ? 'Ran' : 'Failed'}: ${clean(r.command)}${r.error ? ` (${oneLine(r.error)})` : ''}`);
    if (r.ok) saveIndex(dataDir(process.env), buildIndex({}));
    return r.ok ? 0 : 1;
  }
  if (flags.yes) throw new UsageError('--yes only goes with --plugin');
  if (pos.length !== 1) throw new UsageError('park needs exactly one skill name, or --plugin <plugin>');
  const r = park(pos[0]);
  out(`Parked "${clean(pos[0])}": ${clean(r.from)} -> ${clean(r.to)}`);
  out(`It stays searchable (state "library"). Bring it back with: qm unpark ${clean(pos[0])}`);
  return 0;
});

export const cmdUnpark = guarded((argv, out) => {
  const { pos, flags } = parseArgs(argv, { forget: 'bool' });
  if (pos.length !== 1) throw new UsageError('unpark needs exactly one skill name');
  if (flags.forget) {
    const f = forget(pos[0]);
    out(`Dropped the record of "${clean(f.name)}". No file was touched.`);
    out(`original location: ${clean(f.from)} (${f.fromExists ? 'exists' : 'missing'})`);
    out(`parked copy: ${clean(f.parked)} (${f.parkedExists ? 'exists' : 'missing'})`);
    return 0;
  }
  const r = unpark(pos[0]);
  out(`Restored "${clean(pos[0])}": ${clean(r.to)}`);
  for (const w of r.warnings || []) out(`warning: ${oneLine(w)}`);
  return 0;
});
