/**
 * pipeline-core/kit/builders.ts — fluent helpers for writing templates in tests.
 *
 * Mirrors the readability of the e2e kit: a test builds a `Template` declaratively instead of hand-
 * writing the verbose discriminated-union literals. Builders apply NO semantics — they only assemble
 * data; `validateTemplate` is the single source of truth. Intentionally permissive so INVALID
 * fixtures can be expressed (e.g. omit a default, point an edge nowhere).
 */

import type {
  AgentNode,
  Branch,
  ChoiceNode,
  Condition,
  HumanGateNode,
  JoinMode,
  JoinNode,
  Node,
  NodeId,
  ParallelBranch,
  ParallelNode,
  RoleRef,
  Scope,
  ScopeId,
  ScriptNode,
  ScriptRef,
  Template,
  TemplatePolicy,
  TerminalNode,
  TerminalStatus,
  WaitNode,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Condition shorthands — read like the spec (§3).
// ─────────────────────────────────────────────────────────────────────────────

export const verdictEq = (value: string): Condition => ({ op: 'verdict.eq', value });
export const verdictIn = (...value: string[]): Condition => ({ op: 'verdict.in', value });
export const counterLt = (scope: ScopeId, value: number): Condition => ({ op: 'counter.lt', scope, value });
export const counterGte = (scope: ScopeId, value: number): Condition => ({ op: 'counter.gte', scope, value });
export const allOf = (...of: Condition[]): Condition => ({ op: 'all', of });
export const anyOf = (...of: Condition[]): Condition => ({ op: 'any', of });
export const notCond = (cond: Condition): Condition => ({ op: 'not', cond });

// ─────────────────────────────────────────────────────────────────────────────
// Branch shorthands.
// ─────────────────────────────────────────────────────────────────────────────

export const on = (when: Condition, goto: NodeId): Branch => ({ when, goto });
export const otherwise = (goto: NodeId): Branch => ({ default: goto });

// ─────────────────────────────────────────────────────────────────────────────
// Node builders — `node.*` factories returning a fully-typed Node.
// ─────────────────────────────────────────────────────────────────────────────

type EffectOpts = {
  catch?: AgentNode['catch'];
  onFailure?: AgentNode['onFailure'];
  escalateTo?: NodeId;
  resultSchema?: string;
  incrementCounters?: ScopeId[];
  displayName?: string;
};

export const node = {
  agent(id: NodeId, roleRef: RoleRef, next: NodeId, opts: EffectOpts = {}): AgentNode {
    return { id, kind: 'agent', roleRef, next, ...effect(opts) };
  },
  script(id: NodeId, scriptRef: ScriptRef, next: NodeId, opts: EffectOpts = {}): ScriptNode {
    return { id, kind: 'script', scriptRef, next, ...effect(opts) };
  },
  humanGate(
    id: NodeId,
    reason: string,
    outcomes: string[],
    branches: Branch[],
    opts: { timeout?: HumanGateNode['timeout']; displayName?: string; incrementCounters?: ScopeId[] } = {},
  ): HumanGateNode {
    return {
      id,
      kind: 'humanGate',
      reason,
      outcomes,
      branches,
      ...(opts.timeout ? { timeout: opts.timeout } : {}),
      ...(opts.incrementCounters ? { incrementCounters: opts.incrementCounters } : {}),
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
    };
  },
  choice(id: NodeId, branches: Branch[], opts: { displayName?: string; incrementCounters?: ScopeId[] } = {}): ChoiceNode {
    return {
      id,
      kind: 'choice',
      branches,
      ...(opts.incrementCounters ? { incrementCounters: opts.incrementCounters } : {}),
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
    };
  },
  parallel(id: NodeId, branches: ParallelBranch[], join: NodeId, opts: { displayName?: string } = {}): ParallelNode {
    return { id, kind: 'parallel', branches, join, ...(opts.displayName ? { displayName: opts.displayName } : {}) };
  },
  join(id: NodeId, joinMode: JoinMode, next: NodeId, opts: { merge?: JoinNode['merge']; displayName?: string } = {}): JoinNode {
    return {
      id,
      kind: 'join',
      joinMode,
      next,
      ...(opts.merge ? { merge: opts.merge } : {}),
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
    };
  },
  wait(id: NodeId, duration: string, next: NodeId, opts: { displayName?: string } = {}): WaitNode {
    return { id, kind: 'wait', duration, next, ...(opts.displayName ? { displayName: opts.displayName } : {}) };
  },
  terminal(id: NodeId, status: TerminalStatus, opts: { displayName?: string } = {}): TerminalNode {
    return { id, kind: 'terminal', status, ...(opts.displayName ? { displayName: opts.displayName } : {}) };
  },
};

function effect(opts: EffectOpts) {
  return {
    ...(opts.catch ? { catch: opts.catch } : {}),
    ...(opts.onFailure ? { onFailure: opts.onFailure } : {}),
    ...(opts.escalateTo ? { escalateTo: opts.escalateTo } : {}),
    ...(opts.resultSchema ? { resultSchema: opts.resultSchema } : {}),
    ...(opts.incrementCounters ? { incrementCounters: opts.incrementCounters } : {}),
    ...(opts.displayName ? { displayName: opts.displayName } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Join-mode shorthands.
// ─────────────────────────────────────────────────────────────────────────────

export const joinAll = (): JoinMode => ({ kind: 'all' });
export const joinAny = (): JoinMode => ({ kind: 'any' });
export const joinQuorum = (count: number): JoinMode => ({ kind: 'quorum', count });

// ─────────────────────────────────────────────────────────────────────────────
// Template builder — `template().entry(...).domain(...).scope(...).add(...).build()`.
// ─────────────────────────────────────────────────────────────────────────────

export class TemplateBuilder {
  private t: Template;
  constructor(pipelineId: string) {
    this.t = { specVersion: '1.0', pipelineId, entry: '', verdicts: { domain: [] }, nodes: {} };
  }
  specVersion(v: string): this {
    this.t.specVersion = v;
    return this;
  }
  title(title: string): this {
    this.t.title = title;
    return this;
  }
  entry(id: NodeId): this {
    this.t.entry = id;
    return this;
  }
  domain(...labels: string[]): this {
    this.t.verdicts = { domain: labels };
    return this;
  }
  policy(policy: TemplatePolicy): this {
    this.t.policy = policy;
    return this;
  }
  scope(id: ScopeId, scope: Scope): this {
    this.t.scopes = { ...(this.t.scopes ?? {}), [id]: scope };
    return this;
  }
  add(...nodes: Node[]): this {
    for (const n of nodes) this.t.nodes[n.id] = n;
    return this;
  }
  build(): Template {
    // Return a deep-ish clone so a fixture can be mutated by a diff test without leaking.
    return structuredClone(this.t);
  }
}

export function template(pipelineId: string): TemplateBuilder {
  return new TemplateBuilder(pipelineId);
}
