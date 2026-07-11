import { isAlive } from '../../config.js';
import { createIsolatedProfile, type IsolatedProfile, type ProcessResult } from './isolated-profile.js';

export type CliHostState = Readonly<{
  running: boolean;
  pid?: number;
}>;

export class CliContext {
  readonly #profile: IsolatedProfile;

  constructor(profile: IsolatedProfile) {
    this.#profile = profile;
  }

  start(): Promise<ProcessResult> {
    return this.#profile.run(['start']);
  }

  status(): Promise<ProcessResult> {
    return this.#profile.run(['status']);
  }

  restart(): Promise<ProcessResult> {
    return this.#profile.run(['restart']);
  }

  stop(): Promise<ProcessResult> {
    return this.#profile.run(['stop']);
  }

  invoke(args: readonly string[]): Promise<ProcessResult> {
    return this.#profile.run(args);
  }

  hostState(): CliHostState {
    const runtime = this.#profile.runtime();
    return {
      running: runtime !== null && isAlive(runtime.pid),
      ...(runtime ? { pid: runtime.pid } : {}),
    };
  }

  hostProcessAlive(pid: number): boolean {
    return isAlive(pid);
  }

  cleanup(): Promise<void> {
    return this.#profile.cleanup();
  }
}

export async function createCliContext(): Promise<CliContext> {
  return new CliContext(await createIsolatedProfile('cli-surface'));
}
