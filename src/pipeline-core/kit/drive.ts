/**
 * pipeline-core/kit/drive.ts — run `step()` to a terminal, feeding scripted results.
 *
 * The readability counterpart of the e2e `drive`: a test names the verdict each agent/gate produces
 * and `drive` walks the interpreter to completion, recording the visited path of effect/gate/terminal
 * nodes. This keeps interpreter tests declarative ("reviewer BLOCKER ×3 → blocked at the cap") instead
 * of hand-threading `step()` calls and `RunState`.
 *
 * Scripted results are keyed by NODE ID and consumed one-per-visit (arrays clamp to the last entry,
 * mirroring the e2e AgentSpec), so a node hit N times in a loop can yield a different verdict each pass.
 */

import { initialState, step } from '../interpret.js';
import type { Decision, JoinArrival, LastResult, Template } from '../types.js';

/** What a scripted node produces when its Decision is executed. */
export type ScriptedResult =
  | string //                                   shorthand: a domain verdict (outcome defaults to succeeded)
  | { verdict?: string; outcome?: LastResult['outcome']; errorCode?: LastResult['errorCode'] }
  | { joinArrivals: JoinArrival[] }; //         a recorded join aggregation, fed when a join is reached

/** Per-node script: a single result reused every visit, or an array consumed one-per-visit (clamped). */
export type DriveScript = Record<string, ScriptedResult | ScriptedResult[]>;

/** One recorded interpreter step — the Decision emitted and the node it concerns. */
export type Trace = { nodeId: string; decision: Decision['type'] };

export type DriveResult = {
  /** Terminal run status (`succeeded` | `failed` | `blocked`). */
  status: 'succeeded' | 'failed' | 'blocked';
  /** Ordered node ids whose Decision was emitted (effects, gates, forks, timers, the terminal). */
  path: string[];
  /** Full per-step trace (nodeId + decision type). */
  trace: Trace[];
  /** Final scoped-counter snapshot. */
  counters: Record<string, number>;
};

const MAX_STEPS = 1000; // a VALID template always terminates; this guards a test-authoring mistake.

/**
 * Drive `template` from its initial state to a terminal, feeding each emitted Decision the scripted
 * result for its node. Throws if a non-terminal Decision has no script entry, or if it runs away.
 */
export function drive(template: Template, script: DriveScript = {}): DriveResult {
  const visits = new Map<string, number>();
  const joinVisits = new Map<string, number>();
  const trace: Trace[] = [];
  const path: string[] = [];

  let state = initialState(template);
  let lastResult: LastResult | undefined;

  for (let i = 0; i < MAX_STEPS; i++) {
    const out = step(template, state, lastResult);
    state = out.state;
    const decision = out.decision;
    // For `complete` the cursor sits on the node that completed (terminal, or an aborting effect);
    // every other Decision carries its own nodeId.
    const nodeId = decision.type === 'complete' ? soleActive(state) : decision.nodeId;
    trace.push({ nodeId, decision: decision.type });
    path.push(nodeId);

    if (decision.type === 'complete') {
      return { status: decision.status, path, trace, counters: { ...state.scopedCounters } };
    }

    if (decision.type === 'fork') {
      // The adapter runs the branches concurrently and records arrivals; the core never sees the
      // live race. We model that by jumping the cursor to the JOIN and feeding the arrivals scripted
      // on the join node, so the next step aggregates a recorded result. A missing join script with
      // mode `all` synthesizes one arrival per branch (verdict undefined) so the barrier is satisfied.
      const arrivals = joinArrivalsFor(script, decision.joinId, decision.branches.map((b) => b.id), joinVisits);
      state = { ...state, activeNodeIds: new Set([decision.joinId]) };
      lastResult = { joinArrivals: arrivals };
      continue;
    }

    // Resolve the scripted result for THIS node's effect and feed it as the next lastResult.
    lastResult = resultFor(script, nodeId, decision, visits);
  }
  throw new Error(`drive: ${template.pipelineId} did not terminate within ${MAX_STEPS} steps (script gap or loop)`);
}

function soleActive(state: { activeNodeIds: ReadonlySet<string> }): string {
  return [...state.activeNodeIds][0] ?? '<none>';
}

/**
 * Recorded arrivals for a join: from the script entry on the join node, else one per branch. Like
 * `resultFor`, an ARRAY entry is consumed one-per-visit (clamped) so a join hit repeatedly in a loop can
 * yield a different recorded aggregation each pass; a single entry is reused every visit.
 */
function joinArrivalsFor(
  script: DriveScript,
  joinId: string,
  branchIds: string[],
  joinVisits: Map<string, number>,
): JoinArrival[] {
  const n = joinVisits.get(joinId) ?? 0;
  joinVisits.set(joinId, n + 1);
  const entry = script[joinId];
  const picked = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
  if (picked && typeof picked === 'object' && 'joinArrivals' in picked) return picked.joinArrivals;
  return branchIds.map((branchId, i) => ({ branchId, seq: i + 1 }));
}

function resultFor(
  script: DriveScript,
  nodeId: string,
  _decision: Decision,
  visits: Map<string, number>,
): LastResult {
  const n = visits.get(nodeId) ?? 0;
  visits.set(nodeId, n + 1);

  const entry = script[nodeId];
  if (entry === undefined) {
    // A gate/effect with no script: assume structural success with no domain verdict (e.g. a script
    // node that just proceeds). Tests that route on a verdict must script it. `_decision` is unused
    // here but kept in the signature so a future kind-specific default can branch on it.
    return {};
  }
  const picked = Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] ?? {}) : entry;
  return normalize(picked);
}

function normalize(r: ScriptedResult): LastResult {
  if (typeof r === 'string') return { verdict: r, outcome: 'succeeded' };
  if ('joinArrivals' in r) return { joinArrivals: r.joinArrivals };
  const out: LastResult = {};
  if (r.verdict !== undefined) out.verdict = r.verdict;
  if (r.outcome !== undefined) out.outcome = r.outcome;
  if (r.errorCode !== undefined) out.errorCode = r.errorCode;
  return out;
}
