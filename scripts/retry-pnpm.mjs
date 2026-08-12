#!/usr/bin/env node
import { parseArgs, runPnpm } from './_lib.mjs';

const separator = process.argv.indexOf('--', 2);
if (separator === -1) throw new Error('Separate retry options from the pnpm command with --');
const args = parseArgs(process.argv.slice(2, separator));
const command = process.argv.slice(separator + 1);
const attempts = Number.parseInt(String(args.attempts ?? '3'), 10);
const delayMs = Number.parseInt(String(args['delay-ms'] ?? '5000'), 10);

if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) {
  throw new Error('--attempts must be an integer between 1 and 5');
}
if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
  throw new Error('--delay-ms must be an integer between 0 and 60000');
}
if (args._.length !== 0) throw new Error('Unexpected positional retry option');
if (command.length === 0) throw new Error('A pnpm command is required after --');

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const result = await runPnpm(command, { allowFailure: true, capture: false });
  if (result.code === 0 && !result.timedOut) process.exit(0);
  if (attempt === attempts) {
    throw new Error(`pnpm ${command.join(' ')} failed after ${attempts} attempts`);
  }
  console.warn(
    `pnpm ${command.join(' ')} failed on attempt ${attempt}/${attempts}; retrying in ${delayMs}ms`,
  );
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
