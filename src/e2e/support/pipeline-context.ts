import {
  PIPELINE_TARGET,
  type PipelineCase,
  type PipelineTarget,
} from "./pipeline-case.js";
import { createHostFixture, type HostFixture } from "./harness.js";
import { createTargetRepo, type TargetRepo } from "./git-target-repo.js";
import { executeCase } from "./pipeline-case-executor.js";
import { deepFreezeCase } from "./pipeline-case-evidence.js";

export type { PipelineAgentPlan, PipelineTarget } from "./pipeline-case.js";

const targetRepos = new WeakMap<PipelineTarget, TargetRepo>();
const targetHandles = new WeakSet<object>();

function pipelineTarget(repo: TargetRepo): PipelineTarget {
  const target = Object.freeze({ [PIPELINE_TARGET]: true }) as PipelineTarget;
  targetRepos.set(target, repo);
  targetHandles.add(target);
  return target;
}

export class PipelineContext {
  readonly #host: HostFixture;
  readonly #targets: TargetRepo[] = [];

  constructor(host: HostFixture) {
    this.#host = host;
  }

  execute(casePlan: PipelineCase): Promise<string> {
    deepFreezeCase(casePlan, new WeakSet<object>(), targetHandles);
    return executeCase(this.#host, casePlan, targetRepos);
  }

  readAgentOutputEvents(input: Parameters<HostFixture['api']['readAgentOutputEvents']>[0]) {
    return this.#host.api.readAgentOutputEvents(input);
  }

  armAgentOutputFirstWriteBarrier(parties = 2): void {
    this.#host.armAgentOutputFirstWriteBarrier(parties);
  }

  target(): PipelineTarget {
    const repo = createTargetRepo();
    this.#targets.push(repo);
    return pipelineTarget(repo);
  }

  async close(): Promise<void> {
    try {
      await this.#host.close();
    } finally {
      for (const target of this.#targets.splice(0)) target.cleanup();
    }
  }
}

export async function createPipelineContext(): Promise<PipelineContext> {
  const host = await createHostFixture();
  try {
    const { givenInstalledPlaybook } = await import("./scenarios.js");
    await givenInstalledPlaybook(host);
    return new PipelineContext(host);
  } catch (error) {
    await host.close();
    throw error;
  }
}
