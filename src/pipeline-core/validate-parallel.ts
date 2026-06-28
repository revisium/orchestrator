import { MERGE_REDUCERS } from './types.js';
import type { Node, Template } from './types.js';
import { DiagSink } from './validate-sink.js';
import { branchSubgraph, forwardReach, structuralEdges } from './validate-graph.js';

export function ruleParallelJoin(template: Template, d: DiagSink): void {
  const nodes = template.nodes;
  const parallels = Object.values(nodes).filter((n): n is Extract<Node, { kind: 'parallel' }> => n.kind === 'parallel');
  const joinUsedBy = new Map<string, string[]>();

  for (const par of parallels) checkParallelAgainstJoin(template, par, joinUsedBy, d);

  for (const [joinId, owners] of joinUsedBy) {
    if (owners.length > 1) {
      d.error('JOIN_MULTIPLE_PARALLELS', `join "${joinId}" is the target of ${owners.length} parallels`, {
        nodeId: joinId,
      });
    }
  }
}

/** Validate one parallel against its declared join (resolution, kind, quorum, membership, merge). */
function checkParallelAgainstJoin(
  template: Template,
  par: Extract<Node, { kind: 'parallel' }>,
  joinUsedBy: Map<string, string[]>,
  d: DiagSink,
): void {
  const join = template.nodes[par.join];
  if (!join) {
    d.error('PARALLEL_JOIN_UNRESOLVED', `parallel ${par.id} join "${par.join}" does not resolve`, { nodeId: par.id });
    return;
  }
  if (join.kind !== 'join') {
    d.error('PARALLEL_JOIN_KIND', `parallel ${par.id} join "${par.join}" is a ${join.kind}, not a join`, {
      nodeId: par.id,
    });
    return;
  }
  (joinUsedBy.get(par.join) ?? joinUsedBy.set(par.join, []).get(par.join)!).push(par.id);

  checkQuorumBound(par, join, d);
  // Branch membership + cross-branch goto + all-reachability.
  checkBranchMembership(template, par, join.id, d);
  // Multi-writer fields need a merge reducer.
  checkMergeReducers(template, par, join, d);
  checkRejectedMergeReducers(join, d);
}

/** Quorum K must satisfy 1 ≤ K ≤ N (branch count). */
function checkQuorumBound(
  par: Extract<Node, { kind: 'parallel' }>,
  join: Extract<Node, { kind: 'join' }>,
  d: DiagSink,
): void {
  if (join.joinMode.kind !== 'quorum') return;
  const K = join.joinMode.count;
  if (!Number.isInteger(K) || K < 1 || K > par.branches.length) {
    d.error('QUORUM_K_GT_N', `join ${join.id} quorum K=${K} but parallel has ${par.branches.length} branches`, {
      nodeId: join.id,
    });
  }
}

/** Reject any merge reducer outside the allowed set (defensive; the type forbids it but data may carry it). */
function checkRejectedMergeReducers(join: Extract<Node, { kind: 'join' }>, d: DiagSink): void {
  for (const [field, reducer] of Object.entries(join.merge ?? {})) {
    if (!MERGE_REDUCERS.includes(reducer)) {
      d.error('MERGE_LASTWRITE_REJECTED', `join ${join.id} merge.${field} = "${reducer}" is not allowed`, {
        nodeId: join.id,
        path: `merge.${field}`,
      });
    }
  }
}

function checkBranchMembership(
  template: Template,
  par: Extract<Node, { kind: 'parallel' }>,
  joinId: string,
  d: DiagSink,
): void {
  const memberOf = buildBranchMembership(template, par, joinId, d);
  checkCrossBranchGotos(template, memberOf, joinId, d);
}

/**
 * Assign each branch sub-graph node to its owning branch (flagging shared membership) and, for an
 * `all` join, flag any branch that cannot reach the join. Returns the node→branch ownership map.
 */
function buildBranchMembership(
  template: Template,
  par: Extract<Node, { kind: 'parallel' }>,
  joinId: string,
  d: DiagSink,
): Map<string, string> {
  const memberOf = new Map<string, string>();
  for (const branch of par.branches) {
    for (const m of branchSubgraph(template, branch.entry, joinId)) {
      if (memberOf.has(m) && memberOf.get(m) !== branch.id) {
        d.error('BRANCH_MEMBERSHIP', `node ${m} is a member of branches "${memberOf.get(m)}" and "${branch.id}"`, {
          nodeId: m,
        });
      }
      memberOf.set(m, branch.id);
    }
    checkAllJoinReachable(template, branch, joinId, d);
  }
  return memberOf;
}

/** all-reachability: an `all`-join branch must be able to reach the join (no deadlock). */
function checkAllJoinReachable(
  template: Template,
  branch: { id: string; entry: string },
  joinId: string,
  d: DiagSink,
): void {
  const join = template.nodes[joinId];
  if (join?.kind !== 'join' || join.joinMode.kind !== 'all') return;
  if (!forwardReach(template, branch.entry).has(joinId)) {
    d.error('JOIN_UNREACHABLE_BRANCH', `branch "${branch.id}" (all) cannot reach join ${joinId}`, {
      nodeId: branch.entry,
    });
  }
}

/** Cross-branch goto: a branch member may only goto within its own branch sub-graph or to the join. */
function checkCrossBranchGotos(
  template: Template,
  memberOf: Map<string, string>,
  joinId: string,
  d: DiagSink,
): void {
  for (const [member, branchId] of memberOf) {
    const node = template.nodes[member];
    if (!node) continue;
    for (const [path, target] of structuralEdges(node)) {
      if (target === joinId) continue;
      const targetBranch = memberOf.get(target);
      if (targetBranch !== undefined && targetBranch !== branchId) {
        d.error('BRANCH_CROSS_GOTO', `node ${member} (branch ${branchId}) goto ${target} crosses into branch ${targetBranch}`, {
          nodeId: member,
          path,
        });
      }
    }
  }
}

function checkMergeReducers(
  template: Template,
  par: Extract<Node, { kind: 'parallel' }>,
  join: Extract<Node, { kind: 'join' }>,
  d: DiagSink,
): void {
  // v1 cannot statically know a node's written fields without a resultSchema model, so we use a
  // conservative proxy: a parallel fanning out ≥2 effect (agent/script) branches writes results from
  // >1 branch; absent a `merge` reducer those fields are unguarded. A real per-field model
  // lands with native Revisium typing; until then the entry-kind heuristic surfaces the hazard.
  if (par.branches.length < 2) return;
  if (Object.keys(join.merge ?? {}).length > 0) return;
  const writers = par.branches.filter((b) => {
    const entry = template.nodes[b.entry];
    return entry?.kind === 'agent' || entry?.kind === 'script';
  });
  if (writers.length >= 2) {
    d.error('MERGE_MISSING', `join ${join.id} has ${writers.length} writer branches but no merge reducer`, {
      nodeId: join.id,
    });
  }
}
