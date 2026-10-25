#!/usr/bin/env node
/** dshx executable entry. All logic lives in src/main.js. */
import { redact } from '../src/errors.js';
import { main } from '../src/main.js';

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(1);
});
process.stderr.on('error', () => {
  // A closed diagnostic pipe must not turn a successful task into a crash.
});

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`dshx: INTERNAL_ERROR: ${redact(error?.message ?? String(error))}\n`);
  if (process.env.DSHX_DEBUG) process.stderr.write(`${redact(error?.stack ?? '')}\n`);
  process.exitCode = 1;
}
