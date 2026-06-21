import type { ConsumesRef, Node, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import {
  branchSubgraph,
  cycleNodes,
  findBackEdges,
  forwardReach,
  structuralEdges,
} from './validate-graph.js';

// §12 rule 14 is STATIC only: the adapter persists/hydrates at runtime (0016 §5/§6); the core neither
// stores content nor reads it. Dominance proves a producer ran (presence); the runtime `revo.InputMissing`
// guard + the freshness rule cover what static analysis cannot.

type EffectNode = Extract<Node, { kind: 'agent' | 'script' }>;

interface DataflowCtx {
  nodes: Template['nodes'];
  hasEntry: boolean;
  dom: Map<string, Set<string>>;
  membership: Map<string, Array<{ parallel: string; branch: string }>>;
  cyclesByNode: Map<string, Array<Set<string>>>;
}

export function ruleDataflow(template: Template, ids: Set<string>, d: DiagSink): void {
  const ctx = analyse(template, ids);
  flagDuplicateProduces(template, d);
  for (const node of Object.values(template.nodes)) {
    if (node.kind === 'agent' || node.kind === 'script') checkConsumer(node, ctx, d);
  }
}

function analyse(template: Template, ids: Set<string>): DataflowCtx {
  const hasEntry = !!template.entry && ids.has(template.entry);
  return {
    nodes: template.nodes,
    hasEntry,
    dom: hasEntry ? dominators(template, template.entry) : new Map(),
    membership: branchMembership(template),
    cyclesByNode: consumerStaleCycles(template),
  };
}

/** PRODUCES_NAME_DUP — a clarity guard: the grammar keys consumes by NODE, so a duplicate name isn't a resolution bug. */
function flagDuplicateProduces(template: Template, d: DiagSink): void {
  const producedNames = new Map<string, string>();
  for (const node of Object.values(template.nodes)) {
    if (node.kind !== 'agent' && node.kind !== 'script') continue;
    if (!node.produces) continue;
    const prev = producedNames.get(node.produces.name);
    if (prev && prev !== node.id) {
      d.warn('PRODUCES_NAME_DUP', `nodes "${prev}" and "${node.id}" both produce "${node.produces.name}"`, {
        nodeId: node.id,
      });
    } else if (!prev) producedNames.set(node.produces.name, node.id);
  }
}

function checkConsumer(node: EffectNode, ctx: DataflowCtx, d: DiagSink): void {
  const seenAs = new Set<string>();
  (node.consumes ?? []).forEach((ref, i) => checkConsumeRef(node, ref, `consumes[${i}]`, seenAs, ctx, d));
}

function checkConsumeRef(
  node: EffectNode,
  ref: ConsumesRef,
  path: string,
  seenAs: Set<string>,
  ctx: DataflowCtx,
  d: DiagSink,
): void {
  if (seenAs.has(ref.as)) {
    d.error('CONSUMES_AS_DUP', `node "${node.id}" consumes two inputs as "${ref.as}"`, { nodeId: node.id, path });
  } else {
    seenAs.add(ref.as);
  }

  const producer = ctx.nodes[ref.node];
  if (!producer) {
    d.error('CONSUMES_NODE_UNRESOLVED', `node "${node.id}" consumes from unknown node "${ref.node}"`, {
      nodeId: node.id,
      path,
    });
    return;
  }
  if (!isEffectProducer(producer)) {
    d.error('CONSUMES_PRODUCER_MISSING', `node "${node.id}" consumes from "${ref.node}" which declares no produces`, {
      nodeId: node.id,
      path,
    });
    return;
  }

  checkDominance(node, ref, path, ctx, d);
  checkFreshness(node, ref, path, ctx, d);
  checkCrossParallel(node, ref, path, ctx, d);
}

function isEffectProducer(node: Node): node is EffectNode {
  return (node.kind === 'agent' || node.kind === 'script') && !!node.produces;
}

/** Dominance: the producer must run before the consumer on EVERY path (entry can never be dominated → a consuming entry node is always flagged). */
function checkDominance(node: EffectNode, ref: ConsumesRef, path: string, ctx: DataflowCtx, d: DiagSink): void {
  const dominated = ctx.hasEntry && ref.node !== node.id && ctx.dom.get(node.id)?.has(ref.node) === true;
  if (dominated) return;
  const msg = `producer "${ref.node}" does not run before "${node.id}" on every path`;
  if (ref.optional === true) d.warn('CONSUMES_NOT_DOMINATED', msg, { nodeId: node.id, path });
  else d.error('CONSUMES_NOT_DOMINATED', msg, { nodeId: node.id, path });
}

/** Freshness: a consumer inside a loop the producer is NOT on can silently reuse a stale output. */
function checkFreshness(node: EffectNode, ref: ConsumesRef, path: string, ctx: DataflowCtx, d: DiagSink): void {
  const iteration = ref.iteration ?? 'latest';
  if (iteration !== 'latest' || ref.staleOk === true) return;
  const reentersWithoutProducer = (ctx.cyclesByNode.get(node.id) ?? []).some((cycle) => !cycle.has(ref.node));
  if (reentersWithoutProducer) {
    d.warn(
      'CONSUMES_STALE_RISK',
      `node "${node.id}" can re-enter a loop without re-running producer "${ref.node}" (iteration:'latest') — set staleOk or use iteration:'all'/N`,
      { nodeId: node.id, path },
    );
  }
}

/** Cross-parallel: consuming a sibling branch's output is unsafe (the branch may be cancelled). */
function checkCrossParallel(node: EffectNode, ref: ConsumesRef, path: string, ctx: DataflowCtx, d: DiagSink): void {
  const consumerBranches = ctx.membership.get(node.id) ?? [];
  const producerBranches = ctx.membership.get(ref.node) ?? [];
  const crosses = consumerBranches.some((c) =>
    producerBranches.some((p) => c.parallel === p.parallel && c.branch !== p.branch),
  );
  if (crosses) {
    d.error('CONSUMES_CROSS_PARALLEL_UNSAFE', `node "${node.id}" consumes "${ref.node}" from a sibling parallel branch`, {
      nodeId: node.id,
      path,
    });
  }
}

/**
 * Standard iterative dominator sets over STRUCTURAL edges from `entry` (dom(entry) = {entry}). Both the node-set
 * and the predecessor graph use the structural edge model — a catch/escalate route is a failure path where the
 * producer did not successfully run, so it is excluded from "ran before the consumer on every path".
 */
function dominators(template: Template, entry: string): Map<string, Set<string>> {
  const reachable = [...forwardReach(template, entry)].filter((id) => template.nodes[id]);
  const preds = new Map<string, string[]>();
  for (const id of reachable) preds.set(id, []);
  for (const id of reachable) {
    for (const [, t] of structuralEdges(template.nodes[id]!)) if (preds.has(t)) preds.get(t)!.push(id);
  }
  const all = new Set(reachable);
  const dom = new Map<string, Set<string>>();
  for (const id of reachable) dom.set(id, new Set(all));
  dom.set(entry, new Set([entry]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of reachable) {
      if (id === entry) continue;
      const ps = preds.get(id)!;
      let next: Set<string>;
      if (ps.length === 0) next = new Set([id]);
      else {
        next = new Set(dom.get(ps[0])!);
        for (let i = 1; i < ps.length; i++) {
          const dp = dom.get(ps[i])!;
          for (const x of [...next]) if (!dp.has(x)) next.delete(x);
        }
      }
      next.add(id);
      const old = dom.get(id)!;
      if (old.size !== next.size || [...next].some((x) => !old.has(x))) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return dom;
}

/** For each node, the cycles (node-sets) it sits on — feeds the loop-freshness check (CONSUMES_STALE_RISK). */
function consumerStaleCycles(template: Template): Map<string, Array<Set<string>>> {
  const out = new Map<string, Array<Set<string>>>();
  for (const { from, to } of findBackEdges(template)) {
    const cycle = cycleNodes(template, to, from);
    for (const id of cycle) {
      const list = out.get(id) ?? [];
      list.push(cycle);
      out.set(id, list);
    }
  }
  return out;
}

/** Map each node to ALL its (parallel, branch) memberships — a node in nested parallels belongs to each. */
function branchMembership(template: Template): Map<string, Array<{ parallel: string; branch: string }>> {
  const out = new Map<string, Array<{ parallel: string; branch: string }>>();
  for (const par of Object.values(template.nodes)) {
    if (par.kind !== 'parallel') continue;
    for (const br of par.branches) {
      for (const id of branchSubgraph(template, br.entry, par.join)) {
        (out.get(id) ?? out.set(id, []).get(id)!).push({ parallel: par.id, branch: br.id });
      }
    }
  }
  return out;
}
