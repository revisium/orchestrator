









import { initialState, step } from '../interpret.js';
import type { Decision, JoinArrival, LastResult, Template } from '../types.js';


export type ScriptedResult =
  | string
  | { verdict?: string; outcome?: LastResult['outcome']; errorCode?: LastResult['errorCode'] }
  | { joinArrivals: JoinArrival[] };


export type DriveScript = Record<string, ScriptedResult | ScriptedResult[]>;


export type Trace = { nodeId: string; decision: Decision['type'] };

export type DriveResult = {

  status: 'succeeded' | 'failed' | 'blocked' | 'cancelled';

  path: string[];

  trace: Trace[];

  counters: Record<string, number>;
};

const MAX_STEPS = 1000;



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
    const nodeId = decision.type === 'complete' ? soleActive(state) : decision.nodeId;
    trace.push({ nodeId, decision: decision.type });
    path.push(nodeId);

    if (decision.type === 'complete') {
      return { status: decision.status, path, trace, counters: { ...state.scopedCounters } };
    }

    if (decision.type === 'fork') {
      const arrivals = joinArrivalsFor(script, decision.joinId, decision.branches.map((b) => b.id), joinVisits);
      state = { ...state, activeNodeIds: new Set([decision.joinId]) };
      lastResult = { joinArrivals: arrivals };
      continue;
    }

    lastResult = resultFor(script, nodeId, decision, visits);
  }
  throw new Error(`drive: ${template.pipelineId} did not terminate within ${MAX_STEPS} steps (script gap or loop)`);
}

function soleActive(state: { activeNodeIds: ReadonlySet<string> }): string {
  return [...state.activeNodeIds][0] ?? '<none>';
}




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
