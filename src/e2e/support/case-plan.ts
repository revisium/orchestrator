import { taskBranchPrefix } from '../../runners/integrator-branch-naming.js';
import type { AgentSpec } from './agents.js';
import type { IntegratorOutcome } from './fake-integrator.js';
import type { GhScenario } from './gh-emulator.js';

export type ControlledCasePlan = Readonly<{
  title: string;
  agent?: AgentSpec;
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  developerWrite?: string;
  cleanup?: Readonly<{
    releaseWorktreeFails?: boolean;
    dirtyWorktreeBeforeRelease?: boolean;
  }>;
}>;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export class CasePlanRegistry {
  readonly #plans = new Map<string, ControlledCasePlan>();
  readonly #advisoryThreadsVisible = new Set<string>();
  #nextPlan: Readonly<{ plan: ControlledCasePlan }> | undefined;

  register(taskId: string, plan: ControlledCasePlan): void {
    if (this.#plans.has(taskId)) throw new Error(`case plan already registered for task ${taskId}`);
    const frozen = deepFreeze(structuredClone(plan)) as ControlledCasePlan;
    this.#plans.set(taskId, frozen);
  }

  get(taskId: string): ControlledCasePlan | undefined {
    const registered = this.#plans.get(taskId);
    if (registered) return registered;
    if (!this.#nextPlan) return undefined;
    const claimed = this.#nextPlan.plan;
    this.#nextPlan = undefined;
    this.#plans.set(taskId, claimed);
    return claimed;
  }

  reserveNext(plan: ControlledCasePlan): () => void {
    if (this.#nextPlan) throw new Error('a next-task case plan is already reserved');
    const reservation = { plan: deepFreeze(structuredClone(plan)) as ControlledCasePlan };
    this.#nextPlan = reservation;
    return () => {
      if (this.#nextPlan === reservation) this.#nextPlan = undefined;
    };
  }

  taskIdForArgs(args: readonly string[]): string | undefined {
    for (const taskId of this.#plans.keys()) {
      const prefix = taskBranchPrefix(taskId);
      if (args.some((arg) => arg.includes(prefix))) return taskId;
    }
    return undefined;
  }

  showAdvisoryThread(taskId: string): void {
    if (!this.#plans.has(taskId)) throw new Error(`cannot control unregistered task ${taskId}`);
    this.#advisoryThreadsVisible.add(taskId);
  }

  advisoryThreadVisible(taskId: string): boolean {
    return this.#advisoryThreadsVisible.has(taskId);
  }

}
