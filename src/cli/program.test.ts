import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CommanderError } from 'commander';
import { buildProgram, readPackageVersion } from './program.js';

function expectedVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

test('readPackageVersion: returns the version from package.json (not a hardcoded literal)', () => {
  assert.equal(readPackageVersion(), expectedVersion());
});

test('buildProgram: registers lifecycle commands (start/stop/status)', () => {
  const program = buildProgram();
  for (const name of ['start', 'stop', 'status']) {
    assert.ok(program.commands.some((cmd) => cmd.name() === name), `${name} command must be registered`);
  }
});

test('buildProgram: registers mcp command', () => {
  const program = buildProgram();
  assert.ok(program.commands.some((cmd) => cmd.name() === 'mcp'), 'mcp command must be registered');
});

for (const flag of ['--version', '-v']) {
  test(`buildProgram: ${flag} prints the package.json version and exits via commander`, () => {
    const program = buildProgram().exitOverride();
    let out = '';
    program.configureOutput({ writeOut: (s) => { out += s; }, writeErr: () => {} });
    assert.throws(
      () => program.parse(['node', 'revo', flag]),
      (err: unknown) => err instanceof CommanderError && err.code === 'commander.version',
      `${flag} should trigger commander's version exit`,
    );
    assert.equal(out.trim(), expectedVersion(), `${flag} must print the package.json version`);
  });
}
