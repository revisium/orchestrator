import { createHostFixture, type HostFixture } from './harness.js';
import { createTargetRepo, type TargetRepo } from './git-target-repo.js';
import { givenFeatureRunAtPlanGate, givenInstalledPlaybook } from './scenarios.js';

type TargetFactory = () => TargetRepo;
type ParkAtHumanGate = (host: HostFixture, target: TargetRepo) => Promise<unknown>;

export class TeardownContext {
  #host: HostFixture | undefined;
  #target: TargetRepo | undefined;
  readonly #targetFactory: TargetFactory;
  readonly #parkAtHumanGate: ParkAtHumanGate;

  constructor(
    host: HostFixture,
    targetFactory: TargetFactory = createTargetRepo,
    parkAtHumanGate: ParkAtHumanGate = givenFeatureRunAtPlanGate,
  ) {
    this.#host = host;
    this.#targetFactory = targetFactory;
    this.#parkAtHumanGate = parkAtHumanGate;
  }

  async parkAtHumanGate(): Promise<void> {
    const host = this.#host;
    if (!host) throw new Error('teardown context is already closed');
    if (this.#target) throw new Error('teardown context already has a parked target');
    const target = this.#targetFactory();
    this.#target = target;
    await this.#parkAtHumanGate(host, target);
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
