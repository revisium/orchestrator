import test from 'node:test';
import assert from 'node:assert/strict';
import { workCommand } from './work.js';

test('workCommand: exits with code 1 and logs an error when --roles produces an empty list', async () => {
  const errors: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    // ',,,' filters to empty after trim+filter — no role names remain.
    await workCommand({ roles: ',,,', once: true });
  } finally {
    console.error = origConsoleError;
  }

  try {
    assert.equal(process.exitCode, 1, 'exit code must be 1 when roles list is empty');
    assert.ok(
      errors.some((e) => e.toLowerCase().includes('roles')),
      'error message must mention roles',
    );
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});
