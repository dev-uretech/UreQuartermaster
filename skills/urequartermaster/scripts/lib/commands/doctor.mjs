// `qm doctor`: prints the read-only diagnosis; exit 1 when any check is an error.
import { doctor } from '../agent/doctor.mjs';
import { UsageError, parseArgs, guarded } from './common.mjs';

export const cmdDoctor = guarded((argv, out) => {
  parseArgs(argv, {});
  if (argv.length) throw new UsageError('qm doctor takes no arguments');
  const res = doctor({});
  for (const r of res) out(`[${r.level}] ${r.message}`);
  return res.some((r) => r.level === 'error') ? 1 : 0;
});
