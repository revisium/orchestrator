import type { RunAgent } from './runner.js';

// The single RunAgent the loop injects. All runner choice hides here, dispatched on role.runner —
// the loop never learns about runner kinds. A not-implemented runner throws (routing through
// failStep to a clear lesson); it never silently no-ops.
export function createRunAgent(deps: { claudeCode: RunAgent; codex?: RunAgent; script?: RunAgent }): RunAgent {
  return async (args) => {
    switch (args.role.runner) {
      case 'claude-code':
        return deps.claudeCode(args);
      case 'codex':
        if (!deps.codex) throw new Error('RUNNER_NOT_IMPLEMENTED: codex runner not wired');
        return deps.codex(args);
      case 'script':
      case 'stub-agent':
        if (!deps.script) throw new Error('RUNNER_NOT_IMPLEMENTED: script runner not wired');
        return deps.script(args);
      default:
        throw new Error(`RUNNER_NOT_IMPLEMENTED: unknown runner "${String(args.role.runner)}"`);
    }
  };
}
