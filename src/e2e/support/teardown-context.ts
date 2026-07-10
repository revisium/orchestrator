import { createHostFixture, type HostFixture } from './harness.js';
import { createTargetRepo, type TargetRepo } from './git-target-repo.js';
import { givenFeatureRunAtPlanGate, givenInstalledPlaybook } from './scenarios.js';

export class TeardownContext {
  #host: HostFixture | undefined;
  #target: TargetRepo | undefined;

  constructor(host: HostFixture) {
    this.#host = host;
  }

  async parkAtHumanGate(): Promise<void> {
    const host = this.#host;
    if (!host) throw new Error('teardown context is already closed');
    this.#target = createTargetRepo();
    await givenFeatureRunAtPlanGate(host, this.#target);
  }

  async closeParkedHost(): Promise<number> {
    const host = this.#host;
    if (!host) throw new Error('teardown context is already closed');
    const started = Date.now();
    try {
      await host.close({ keepWorkflowsParked: true });
      return Date.now() - started;
    } finally {
      this.#host = undefined;
      this.#target?.cleanup();
      this.#target = undefined;
    }
  }

  async cleanup(): Promise<void> {
    try {
      await this.#host?.close({ keepWorkflowsParked: true });
    } finally {
      this.#host = undefined;
      this.#target?.cleanup();
      this.#target = undefined;
    }
  }
}

export async function createTeardownContext(): Promise<TeardownContext> {
  const host = await createHostFixture();
  try {
    await givenInstalledPlaybook(host);
    return new TeardownContext(host);
  } catch (error) {
    await host.close();
    throw error;
  }
}
