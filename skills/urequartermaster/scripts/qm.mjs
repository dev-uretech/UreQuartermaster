#!/usr/bin/env node
// qm: entry point. Dispatches to lib/cli.mjs; exit codes 0 ok, 2 bad arguments, 1 errors.
import { dispatch, USAGE, UsageError } from './lib/cli.mjs';

// The reader went away (`qm list | head`): stop quietly, as other command-line tools do.
process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') process.exit(0); throw e; });
const out = (s) => process.stdout.write(`${s}\n`);

function fail(e) {
  if (e instanceof UsageError) {
    process.stderr.write(`${e.message}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`qm: ${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  }
}

try {
  const r = dispatch(process.argv.slice(2), out);
  if (r && typeof r.then === 'function') r.then((code) => { process.exitCode = code; }, fail);
  else process.exitCode = r;
} catch (e) {
  fail(e);
}
