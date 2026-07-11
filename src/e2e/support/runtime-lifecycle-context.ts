import assert from 'node:assert/strict';
import { isAlive } from '../../config.js';
import { isGraphqlHealthy } from '../../host/ensure-host.js';
import { createIsolatedProfile, type IsolatedProfile } from './isolated-profile.js';

export type RuntimeHostObservation = Readonly<{
  pid: number;
  graphqlPort: number;
  startedAt: string;
}>;

export class RuntimeLifecycleContext {
  readonly #profile: IsolatedProfile;

  constructor(profile: IsolatedProfile) {
    this.#profile = profile;
  }

  async startHost(): Promise<RuntimeHostObservation> {
    const result = await this.#profile.run(['start']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return this.#runningObservation();
  }

  async stopHost(): Promise<void> {
    const before = this.#profile.runtime();
    const result = await this.#profile.run(['stop']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(this.#profile.running(), false, `host ${before?.pid ?? 'unknown'} remains alive after stop`);
    if (before) assert.equal(isAlive(before.pid), false, `host process ${before.pid} remains alive after stop`);
  }

  async restartHost(): Promise<RuntimeHostObservation> {
    const before = this.#profile.running() ? await this.#runningObservation() : undefined;
    const result = await this.#profile.run(['restart']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const after = await this.#runningObservation();
    if (before) assert.notEqual(after.pid, before.pid, 'restart must replace the host daemon process');
    return after;
  }

  isStopped(): boolean {
    return !this.#profile.running();
  }

  cleanup(): Promise<void> {
    return this.#profile.cleanup();
  }

  async #runningObservation(): Promise<RuntimeHostObservation> {
    const runtime = this.#profile.runtime();
    assert.ok(runtime && this.#profile.running(), 'isolated host must be running');
    assert.equal(await isGraphqlHealthy(runtime.graphqlPort), true, 'isolated host GraphQL must be ready');
    return {
      pid: runtime.pid,
      graphqlPort: runtime.graphqlPort,
      startedAt: runtime.startedAt,
    };
  }
}

export async function createRuntimeLifecycleContext(): Promise<RuntimeLifecycleContext> {
  return new RuntimeLifecycleContext(await createIsolatedProfile('runtime-lifecycle'));
}
