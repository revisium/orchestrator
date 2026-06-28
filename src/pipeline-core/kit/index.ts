/**
 * pipeline-core/kit — the readability test kit (mirrors src/e2e/kit).
 *
 * builders   — fluent `template()` / `node.*` / condition + branch shorthands.
 * fixtures   — the two real pipelines + targeted valid/invalid fixtures.
 * drive      — run `step()` to a terminal feeding scripted verdicts, recording the path.
 * assertions — `assertValid` / `assertDiagnostics` / `assertReachesTerminal` / `assertPath` / …
 */

export * from './builders.js';
export * from './fixtures.js';
export * from './drive.js';
export * from './assertions.js';
