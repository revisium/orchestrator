import type { RunAgent, AttemptResult } from './runner.js';
import type { Step } from '../control-plane/steps.js';

export type ScriptModule = {
  run(input: unknown, step: Step): Promise<AttemptResult>;
};

export type ScriptRunnerDeps = {
  scripts: Record<string, ScriptModule>;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;

/** Wraps registered script modules as a RunAgent with a configurable JS-level timeout. */
export function createScriptRunner(deps: ScriptRunnerDeps): RunAgent {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async ({ role, step }) => {
    const module = deps.scripts[role.name];
    if (!module) {
      throw new Error(`SCRIPT_NOT_FOUND: no script registered for role "${role.name}"`);
    }

    const parsedInput: unknown =
      typeof step.input === 'string'
        ? JSON.parse(step.input || '{}')
        : (step.input ?? {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`script runner exceeded ${timeoutMs}ms for role "${role.name}"`)),
        timeoutMs,
      );
    });

    try {
      // For sync script bodies (execFileSync in defaultExecGh) the OS-level exec timeout is the real guard; this timer covers async bodies.
      return await Promise.race([module.run(parsedInput, step), timeout]);
    } finally {
      // Clear the timer on every exit (success OR failure); an uncleared setTimeout keeps the
      // event loop alive ~120s and hangs `--once` / tests.
      clearTimeout(timer);
    }
  };
}
