import { normalizeIssueRefIntoParams } from '../run/issue-ref.js';
import {
  parseExecutionPlan,
  type CompiledExecutionPlan,
  type ExecutionPlan,
  type ResolvedAgentBinding,
  type ResolvedScriptBinding,
} from '../control-plane/run-profile-contract.js';

export type RouteProjection = {
  playbookId: string;
  pipelineId: string;
  pipelineRowId: string;
  source: 'explicit';
  profileSource: 'stored' | 'inline';
  profileId?: string;
  profileVersion?: string;
  profileHash: string;
  roles: string[];
  routeGates: string[];
  executionPolicy: unknown;
  materializedTemplateHash: string;
};

export type RouteDecision = {
  schemaVersion: 'route-decision/v1';
  executionPlanBytes: string;
  executionPlanDigest: string;
  projection: Readonly<RouteProjection>;
};

export function routeDecisionFromCompiledPlan(compiled: CompiledExecutionPlan): RouteDecision {
  const { plan } = compiled;
  const projection: RouteProjection = {
    playbookId: plan.selection.playbookId,
    pipelineId: plan.selection.pipelineId,
    pipelineRowId: plan.selection.pipelineRowId,
    source: plan.selection.source,
    profileSource: plan.profile.source,
    ...(plan.profile.profileId ? { profileId: plan.profile.profileId } : {}),
    ...(plan.profile.profileVersion ? { profileVersion: plan.profile.profileVersion } : {}),
    profileHash: plan.profile.profileHash,
    roles: [...new Set(plan.agentBindings.map((binding) => binding.roleId))],
    routeGates: [...plan.pipeline.routeGates],
    executionPolicy: plan.pipeline.executionPolicy,
    materializedTemplateHash: plan.pipeline.graphDigest,
  };
  return {
    schemaVersion: 'route-decision/v1',
    executionPlanBytes: compiled.bytes,
    executionPlanDigest: compiled.digest,
    projection,
  };
}

export function executionPlanFromRouteDecision(route: RouteDecision): ExecutionPlan {
  if (route.schemaVersion !== 'route-decision/v1') {
    throw new Error('execution_plan_invalid: route decision schema mismatch');
  }
  return parseExecutionPlan(route.executionPlanBytes, route.executionPlanDigest);
}

export function agentBindingForNode(plan: ExecutionPlan, nodeId: string): ResolvedAgentBinding {
  const binding = plan.agentBindings.find((candidate) => candidate.nodeId === nodeId);
  if (!binding) throw new Error(`execution_plan_binding_unresolved: agent node ${nodeId} has no pinned binding`);
  return binding;
}

export function scriptBindingForNode(plan: ExecutionPlan, nodeId: string): ResolvedScriptBinding {
  const binding = plan.scriptBindings.find((candidate) => candidate.nodeId === nodeId);
  if (!binding) throw new Error(`execution_plan_binding_unresolved: script node ${nodeId} has no pinned binding`);
  return binding;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeParams(value: unknown, issueRef?: unknown, issueAction?: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return normalizeIssueRefIntoParams({}, issueRef, issueAction);
  return normalizeIssueRefIntoParams(record, issueRef, issueAction);
}

const GATE_ID_BY_CANONICAL_LABEL: Record<string, string> = {
  'task spec approval': 'plan',
  'merge approval': 'merge',
};

export function normalizeRouteGates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const gate = item.trim();
    if (!gate) continue;
    const normalized = GATE_ID_BY_CANONICAL_LABEL[gate.toLowerCase()] ?? gate;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
