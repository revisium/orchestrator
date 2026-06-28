

































import { Injectable } from '@nestjs/common';
import { DBOS, WorkflowQueue, type WorkflowHandle } from '@dbos-inc/dbos-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';




export const GATE_DEADLINE_EPOCH_MS = 4102444800000;






export const SHUTDOWN_DRAIN_TIMEOUT_MS = 8_000;







export function resolveShutdownDrainTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const value = env['REVO_SHUTDOWN_DRAIN_TIMEOUT_MS']?.trim();
  if (!value) return SHUTDOWN_DRAIN_TIMEOUT_MS;
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? raw : SHUTDOWN_DRAIN_TIMEOUT_MS;
}


export type PingResult = {
  workflowID: string;
  markerCount: number;
};

export type DbosConfigOptions = {
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
};


type PingWorkflowFn = (workflowID: string, sleepMs: number, markerFile: string) => Promise<PingResult>;
type MarkStepFn = (workflowID: string, markerFile: string) => Promise<number>;
type SleepStepFn = (ms: number) => Promise<void>;
type QueueOptions = { concurrency?: number; workerConcurrency?: number };

@Injectable()
export class DbosService {
  private static launched = false;
  private static launchPromise: Promise<void> | null = null;
  private static configured: { systemDatabaseUrl: string; logLevel?: DbosConfigOptions['logLevel'] } | null = null;


  private static readonly queues = new Map<string, WorkflowQueue>();
  private static readonly queueOptions = new Map<string, QueueOptions>();
  private static readonly steps = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  private static readonly workflows = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  private readonly pingWorkflow: PingWorkflowFn;
  private readonly markStep: MarkStepFn;
  private readonly sleepStep: SleepStepFn;

  constructor() {
    this.markStep = this.registerStep(
      'DbosService.markStep',
      async function markStepImpl(workflowID: string, markerFile: string): Promise<number> {
        mkdirSync(dirname(markerFile), { recursive: true });
        try {
          writeFileSync(markerFile, `${workflowID}\t${new Date().toISOString()}\n`, { flag: 'wx' });
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
        const content = existsSync(markerFile) ? readFileSync(markerFile, 'utf8') : '';
        return content.split('\n').filter((l) => l.trim() !== '').length;
      },
    );

    this.sleepStep = this.registerStep(
      'DbosService.sleepStep',
      async function sleepStepImpl(ms: number): Promise<void> {
        await DBOS.sleep(ms);
      },
    );

    const markStepBound = this.markStep.bind(this);
    const sleepStepBound = this.sleepStep.bind(this);
    this.pingWorkflow = this.registerWorkflow(
      'DbosService.pingImpl',
      async function pingImpl(
        workflowID: string,
        sleepMs: number,
        markerFile: string,
      ): Promise<PingResult> {
        const markerCount = await markStepBound(workflowID, markerFile);
        await sleepStepBound(sleepMs);
        return { workflowID, markerCount };
      },
    );
  }





  registerStep<A extends unknown[], R>(
    name: string,
    fn: (...a: A) => Promise<R>,
  ): (...a: A) => Promise<R> {
    const cached = DbosService.steps.get(name);
    if (cached) return cached as (...a: A) => Promise<R>;
    const lastDot = name.lastIndexOf('.');
    const className = lastDot >= 0 ? name.slice(0, lastDot) : 'Pipeline';
    const methodName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
    const registered = DBOS.registerStep(fn, { name: methodName, className });
    DbosService.steps.set(name, registered as (...args: unknown[]) => Promise<unknown>);
    return registered;
  }




  registerWorkflow<A extends unknown[], R>(
    name: string,
    fn: (...a: A) => Promise<R>,
  ): (...a: A) => Promise<R> {
    const cached = DbosService.workflows.get(name);
    if (cached) return cached as (...a: A) => Promise<R>;
    const lastDot = name.lastIndexOf('.');
    const className = lastDot >= 0 ? name.slice(0, lastDot) : 'Pipeline';
    const methodName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
    const registered = DBOS.registerWorkflow(fn, { name: methodName, className });
    DbosService.workflows.set(name, registered as (...args: unknown[]) => Promise<unknown>);
    return registered;
  }




  registerQueue(name: string, opts: QueueOptions): void {
    const existing = DbosService.queueOptions.get(name);
    if (existing) {
      if (
        existing.concurrency !== opts.concurrency ||
        existing.workerConcurrency !== opts.workerConcurrency
      ) {
        throw new Error(`WorkflowQueue ${name} already registered with different options.`);
      }
      return;
    }
    DbosService.queues.set(name, new WorkflowQueue(name, opts));
    DbosService.queueOptions.set(name, { ...opts });
  }











  startWorkflowOn<A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
    workflowID: string,
    queueName: string,
    ...args: A
  ): Promise<WorkflowHandle<R>> {
    return DBOS.startWorkflow(fn, { workflowID, queueName })(...args);
  }








  signal(workflowId: string, topic: string, payload: unknown, idempotencyKey?: string): Promise<void> {
    return DBOS.send(workflowId, payload, topic, idempotencyKey);
  }





  awaitDecision<T>(topic: string, opts?: { deadlineEpochMS?: number }): Promise<T | null> {
    return DBOS.recv<T>(topic, { deadlineEpochMS: opts?.deadlineEpochMS ?? GATE_DEADLINE_EPOCH_MS });
  }

  setEvent<T>(key: string, value: T): Promise<void> {
    return DBOS.setEvent(key, value);
  }

  sleep(ms: number): Promise<void> {
    return DBOS.sleep(ms);
  }

  getEvent<T>(workflowID: string, key: string, opts?: { timeoutSeconds?: number }): Promise<T | null> {
    return DBOS.getEvent<T>(workflowID, key, opts);
  }



  writeStream<T>(key: string, value: T): Promise<void> {
    return DBOS.writeStream<T>(key, value);
  }



  closeStream(key: string): Promise<void> {
    return DBOS.closeStream(key);
  }

  readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown> {
    return DBOS.readStream<T>(workflowID, key);
  }




  setConfig(systemDatabaseUrl: string, options: DbosConfigOptions = {}): void {
    const nextConfig = { systemDatabaseUrl, logLevel: options.logLevel };
    if (DbosService.configured) {
      if (
        DbosService.configured.systemDatabaseUrl === nextConfig.systemDatabaseUrl &&
        DbosService.configured.logLevel === nextConfig.logLevel
      ) {
        return;
      }
      if (DbosService.launched) {
        throw new Error('Cannot reconfigure DBOS after launch.');
      }
    }
    DBOS.setConfig({
      name: 'agent-orchestrator',
      systemDatabaseUrl,
      runAdminServer: false,
      ...(options.logLevel ? { logLevel: options.logLevel } : {}),
    });
    DbosService.configured = nextConfig;
  }



  async launch(): Promise<void> {
    if (DbosService.launched) return;
    if (DbosService.launchPromise) return DbosService.launchPromise;
    DbosService.launchPromise = (async () => {
      await DBOS.launch();
      DbosService.launched = true;
    })();
    try {
      await DbosService.launchPromise;
    } finally {
      DbosService.launchPromise = null;
    }
  }












  async shutdown(timeoutMs: number = resolveShutdownDrainTimeoutMs()): Promise<void> {
    if (!DbosService.launched) return;
    DbosService.launched = false;
    const drain = DBOS.shutdown();
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      await drain;
      return;
    }
    void drain.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race<boolean>([
      drain.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!drained) {
      console.warn(
        `[dbos] shutdown drain exceeded ${timeoutMs}ms (likely a workflow parked at a human gate); ` +
          'detaching — durable state is preserved and recovered on next launch.',
      );
    }
  }











  async startPingWorkflow(
    workflowID: string,
    sleepMs: number,
    markerFile: string,
  ): Promise<WorkflowHandle<PingResult>> {
    return DBOS.startWorkflow(this.pingWorkflow, { workflowID })(workflowID, sleepMs, markerFile);
  }


  getWorkflowStatus(id: string) {
    return DBOS.getWorkflowStatus(id);
  }






  async waitForWorkflow(id: string): Promise<PingResult | null> {
    const handle = DBOS.retrieveWorkflow<PingResult>(id);
    return handle.getResult();
  }









  async waitForWorkflowResult<T>(id: string): Promise<T | null> {
    const handle = DBOS.retrieveWorkflow<T>(id);
    return handle.getResult();
  }
}
