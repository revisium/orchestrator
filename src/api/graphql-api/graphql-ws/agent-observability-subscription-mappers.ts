import type {
  AgentActivitySnapshot,
  AgentOutputEvent,
  AgentRunActivity,
  AgentOutputStream as DomainAgentOutputStream,
} from '../../../observability/types.js';
import {
  AgentActivityStatus,
  AgentOutputEventKind,
  AgentOutputStream,
  type AgentOutputEventModel,
  type AgentRunActivityModel,
} from '../runs/model/agent-activity.model.js';

function toDate(value: string): Date {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function mapOutputStream(stream: DomainAgentOutputStream | undefined): AgentOutputStream | undefined {
  if (stream === 'stdout') return AgentOutputStream.stdout;
  if (stream === 'stderr') return AgentOutputStream.stderr;
  if (stream === 'agent-jsonl') return AgentOutputStream.agent_jsonl;
  return undefined;
}

function mapActivitySnapshot(snapshot: AgentActivitySnapshot): AgentRunActivityModel['attempts'][number] {
  return {
    runId: snapshot.runId,
    attemptId: snapshot.attemptId,
    stepId: snapshot.stepId,
    stepKey: snapshot.stepKey,
    role: snapshot.role,
    runner: snapshot.runner,
    pid: snapshot.pid,
    status: snapshot.status as AgentActivityStatus,
    startedAt: toDate(snapshot.startedAt),
    lastEventAt: toDate(snapshot.lastEventAt),
    lastOutputAt: snapshot.lastOutputAt ? toDate(snapshot.lastOutputAt) : undefined,
    lastStream: mapOutputStream(snapshot.lastStream),
    stdoutBytes: snapshot.stdoutBytes,
    stderrBytes: snapshot.stderrBytes,
    eventCount: snapshot.eventCount,
    artifactRef: snapshot.artifactRef,
    exitCode: snapshot.exitCode ?? null,
    timedOut: snapshot.timedOut,
    error: snapshot.error,
  };
}

export function mapAgentRunActivityForSubscription(activity: AgentRunActivity): AgentRunActivityModel {
  return {
    runId: activity.runId,
    aggregateStatus: activity.aggregateStatus as AgentActivityStatus,
    latestActivityAt: toDate(activity.latestActivityAt),
    latestOutputAt: activity.latestOutputAt ? toDate(activity.latestOutputAt) : undefined,
    attempts: activity.attempts.map(mapActivitySnapshot),
  };
}

export function mapAgentOutputEventForSubscription(event: AgentOutputEvent): AgentOutputEventModel {
  return {
    cursor: event.cursor,
    runId: event.runId,
    attemptId: event.attemptId,
    attemptSeq: event.attemptSeq,
    stepId: event.stepId,
    stepKey: event.stepKey,
    at: toDate(event.at),
    kind: event.kind as AgentOutputEventKind,
    stream: mapOutputStream(event.stream),
    bytes: event.bytes,
    preview: event.preview,
    parsedType: event.parsedType,
    statusHint: event.statusHint as AgentActivityStatus | undefined,
  };
}
