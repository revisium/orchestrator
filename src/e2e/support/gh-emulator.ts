import type { ExecGhFn } from '../../poller/pr-readiness.js';
import type { CasePlanRegistry } from './case-plan.js';

const PR_URL = 'https://github.com/e2e/repo/pull/1';
const PR_URL_2 = 'https://github.com/e2e/repo/pull/2';
const BASE = 'master'; // createTargetRepo() bases every run on master

/**
 * Named `gh` behaviours. The shapes mirror what `integrator.ts` reads: `pr list --json
 * number,url,baseRefName`, `pr create` (url on stdout), `pr view --json number,url`. Pair with the
 * per-task {@link plannedGhEmulator} so one host can give each immutable case plan a different outcome.
 */
export type GhScenario =
  | 'happy' //              list→[] , create→url , view→{number:1}
  | 'pr-already-exists' //  list→[one open PR on master] → integrator reuses it, no `pr create`
  | 'ambiguous-prs' //      list→[two open PRs on master] → integrator needsHuman (ambiguous)
  | 'pr-view-non-json' //   create succeeds but `pr view` returns non-JSON → needsHuman (never stub://)
  | 'merge-not-clean' //    `pr view` → OPEN but mergeStateStatus≠CLEAN → confirmMerge blocks (keeps worktree)
  | 'merge-conflict' //     pollPr rollup: checks green, no threads, but DIRTY/CONFLICTING → pollPr blocks (#240)
  | 'ci-red-then-green' //  pollPr: 1st readiness has a FAILING check (ci_changes); after a dev re-push it goes green (plan 0018)
  | 'review-comment' //     pollPr: one UNRESOLVED review thread until respondThreads resolves it; CI green (plan 0018)
  | 'gh-error' //           every gh call throws (rate-limit / network family) → DBOS retries the step
  | 'gh-token-leak' //      throws an error embedding a gho_ token → asserts redaction in the lesson
  | 'ready-fails' //        `gh pr ready` fails after green checks → recoveryGate recheck/cancel
  | 'always-ci-red' //     pollPr rollup: all CI checks permanently failing → ciLoop exhaustion → recoveryGate (#246)
  | 'merge-unknown-then-clean' // pollPr: UNKNOWN×1 then CLEAN; bounded recheck loop converges to merge (#248)
  | 'merge-stale-at-reverify' // pollPr+mergeReadiness: CLEAN; mergeApproveReverify: DIRTY → classifyRecovery (#248)
  | 'merged-externally'
  | 'closed-externally'
  | 'head-moved-after-approve'
  | 'empty-graphql-data'
  | 'no-checks-registered'
  | 'checks-never-settle'
  | 'nonsense-poll-state'
  | 'force-advisory-thread';

/** Branch from a `gh pr <view|merge|ready> <branch> …` argv (integrator/confirmMerge pass it as args[2]). */
function branchArg(args: string[]): string {
  return args[2] ?? '';
}

/** Value following a flag in argv (e.g. `--head <branch>`). */
function flagValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? '') : '';
}

/** The `-f key=value` GraphQL variable (gh api graphql passes vars as repeated `-f k=v`). */
function gqlVar(args: string[], key: string): string {
  for (let i = 0; i < args.length - 1; i++) {
    if ((args[i] === '-f' || args[i] === '-F') && (args[i + 1] ?? '').startsWith(`${key}=`)) {
      return (args[i + 1] ?? '').slice(key.length + 1);
    }
  }
  return '';
}

/** The GraphQL query/mutation text (the `-f query=…` value). */
function gqlQuery(args: string[]): string {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-f' && (args[i + 1] ?? '').startsWith('query=')) return (args[i + 1] ?? '').slice('query='.length);
  }
  return '';
}

/**
 * Mutable per-emulator state. `mergedBranches`/`readyBranches` model the integrator/confirmMerge flow
 * (plan 0017); `createdBranches`, `repushedBranches`, and `unresolvedThreads` model the plan 0018
 * pollPr/respondThreads loop: a created PR shows up on `pr list`, a developer re-push flips red CI to
 * green (ci-red-then-green), and `resolveReviewThread` removes a thread from the unresolved set.
 */
type GhState = {
  mergedBranches: Set<string>;
  readyBranches: Set<string>;
  createdBranches: Set<string>;
  /** Branches whose feature work has been re-pushed at least once (a CI-fixing developer iteration). */
  repushedBranches: Set<string>;
  /** Per-branch unresolved review-thread ids (review-comment scenario). resolve removes one. */
  unresolvedThreads: Map<string, Set<string>>;
  /**
   * Count of `gh pr ready` invocations. `pr ready` fires once per pollPr/mergeReadiness/
   * mergeApproveReverify node BEFORE the grace-view loop that determines the verdict, so this
   * counter increments at node entry. Used by node-boundary flip scenarios to change merge state
   * after a known number of nodes have been processed. Requires reviewGracePolls >= 1 (holds at
   * default 4; test:e2e does not override the grace count).
  */
  readyCount: number;
  forceAdvisoryThreadSeeded: boolean;
};

function newGhState(): GhState {
  return {
    mergedBranches: new Set(),
    readyBranches: new Set(),
    createdBranches: new Set(),
    repushedBranches: new Set(),
    unresolvedThreads: new Map(),
    readyCount: 0,
    forceAdvisoryThreadSeeded: false,
  };
}

function isExternallyTerminal(scenario: GhScenario): boolean {
  return scenario === 'merged-externally' || scenario === 'closed-externally';
}

function externalTerminalState(scenario: GhScenario): 'MERGED' | 'CLOSED' {
  return scenario === 'merged-externally' ? 'MERGED' : 'CLOSED';
}

/** True once the integrator created (or the scenario pre-seeds) a PR for `branch`. */
function hasOpenPr(scenario: GhScenario, st: GhState, branch: string): boolean {
  if (isExternallyTerminal(scenario) && st.createdBranches.has(branch)) return false;
  return scenario === 'pr-already-exists' || st.createdBranches.has(branch);
}

/** Review threads for a branch, lazily seeded from the scenario (review-comment → one unresolved). */
function threadsFor(
  scenario: GhScenario,
  st: GhState,
  branch: string,
  advisoryThreadVisible: boolean,
): Set<string> {
  let set = st.unresolvedThreads.get(branch);
  if (!set) {
    set = new Set(scenario === 'review-comment' ? ['PRRT_T1'] : []);
    st.unresolvedThreads.set(branch, set);
  }
  if (scenario === 'force-advisory-thread' && advisoryThreadVisible && !st.forceAdvisoryThreadSeeded) {
    set.add('PRRT_T1');
    st.forceAdvisoryThreadSeeded = true;
  }
  return set;
}

function ghBehavior(
  scenario: GhScenario,
  args: string[],
  st: GhState,
  advisoryThreadVisible = false,
): string {
  if (scenario === 'gh-error') {
    throw new Error('gh: API rate limit exceeded for installation (e2e gh-error scenario)');
  }
  if (scenario === 'gh-token-leak') {
    throw new Error('gh: bad credentials using token gho_abcdEFGH1234567890LEAK rejected by server');
  }

  // ── plan 0018 — GraphQL review-thread query + reply/resolve mutations (gh api graphql) ──
  if (args[0] === 'api' && args[1] === 'graphql') {
    const query = gqlQuery(args);
    if (scenario === 'empty-graphql-data') return JSON.stringify({ data: {} });
    if (query.includes('reviewThreads')) {
      // collectPrReadiness reads reviewThreads by owner/name/number.
      const branch = onlyBranch(st);
      const ids = [...threadsFor(scenario, st, branch, advisoryThreadVisible)];
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false },
                nodes: ids.map((id) => ({
                  id,
                  isResolved: false,
                  isOutdated: false,
                  path: 'src/foo.ts',
                  line: 3,
                  comments: { nodes: [{ body: 'please address this review comment', url: `${PR_URL}#${id}`, author: { login: 'coderabbitai' } }] },
                })),
              },
            },
          },
        },
      });
    }
    if (query.includes('resolveReviewThread')) {
      const id = gqlVar(args, 'id');
      for (const set of st.unresolvedThreads.values()) set.delete(id);
      return JSON.stringify({ data: { resolveReviewThread: { thread: { id, isResolved: true } } } });
    }
    if (query.includes('addPullRequestReviewThreadReply')) {
      return JSON.stringify({ data: { addPullRequestReviewThreadReply: { clientMutationId: null } } });
    }
    if (query.includes('statusCheckRollup')) {
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              statusCheckRollup: {
                contexts: {
                  nodes: scenario === 'no-checks-registered'
                    ? []
                    : [{ __typename: 'CheckRun', name: 'build', isRequired: true }],
                },
              },
            },
          },
        },
      });
    }
    throw new Error(`unexpected gh api graphql call: ${args.join(' ')}`);
  }

  if (args[0] === 'pr' && args[1] === 'list') {
    if (scenario === 'ambiguous-prs') {
      return JSON.stringify([
        { number: 7, url: PR_URL, baseRefName: BASE, state: 'OPEN' },
        { number: 8, url: PR_URL_2, baseRefName: BASE, state: 'OPEN' },
      ]);
    }
    const head = flagValue(args, '--head');
    const requestedState = flagValue(args, '--state') || 'open';
    if (isExternallyTerminal(scenario) && st.createdBranches.has(head) && requestedState !== 'open') {
      return JSON.stringify([
        {
          number: 7,
          url: PR_URL,
          baseRefName: BASE,
          state: externalTerminalState(scenario),
          headRefOid: 'deadbeefcafe',
          title: 'Externally terminal PR',
          body: '',
        },
      ]);
    }
    if (hasOpenPr(scenario, st, head)) {
      if (head) st.createdBranches.add(head);
      return JSON.stringify([{ number: 7, url: PR_URL, baseRefName: BASE, state: 'OPEN' }]);
    }
    return JSON.stringify([]);
  }
  if (args[0] === 'pr' && args[1] === 'create') {
    st.createdBranches.add(flagValue(args, '--head'));
    return `${PR_URL}\n`;
  }
  if (args[0] === 'pr' && args[1] === 'ready') {
    if (scenario === 'ready-fails') {
      throw new Error('gh: cannot mark pull request ready for review: permission denied');
    }
    st.readyBranches.add(branchArg(args));
    st.readyCount++;
    return '';
  }
  if (args[0] === 'pr' && args[1] === 'merge') {
    // Real gh refuses to merge a draft — model that so a missing `pr ready` is caught.
    if (!st.readyBranches.has(branchArg(args))) {
      throw new Error('gh: Pull Request is still a draft (mergePullRequest)');
    }
    if (scenario === 'head-moved-after-approve') {
      const expected = flagValue(args, '--match-head-commit');
      if (expected && expected !== 'feedfacecafe') {
        throw new Error(`gh: Head commit moved from ${expected} to feedfacecafe`);
      }
    }
    // confirmMerge: record the merge so the verifying re-view reports MERGED.
    st.mergedBranches.add(branchArg(args));
    return '';
  }
  if (args[0] === 'pr' && args[1] === 'view') {
    if (scenario === 'pr-view-non-json') return 'not json — gh glitch';
    const prRef = branchArg(args);
    const branch = prRef.startsWith('feat/') ? prRef : (onlyBranch(st) || prRef);
    const wantsRollup = args.some((a) => a.includes('statusCheckRollup'));
    if (wantsRollup) {
      if (scenario === 'merged-externally') {
        return JSON.stringify({
          number: 7,
          url: PR_URL,
          state: 'MERGED',
          isDraft: false,
          baseRefName: BASE,
          headRefName: branch,
          headRefOid: 'deadbeefcafe',
          mergeStateStatus: 'CLEAN',
          reviewDecision: '',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        });
      }
      if (scenario === 'closed-externally') {
        return JSON.stringify({
          number: 7,
          url: PR_URL,
          state: 'CLOSED',
          isDraft: false,
          baseRefName: BASE,
          headRefName: branch,
          headRefOid: 'deadbeefcafe',
          mergeStateStatus: 'CLEAN',
          reviewDecision: '',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [],
        });
      }
      // pollPr's collectPrReadiness view: report the CI rollup + draft/state. ci-red-then-green starts
      // FAILING and flips to SUCCESS once a developer re-pushed (repushedBranches). A re-push is modelled
      // by the second `pr create` (idempotent integrator) NOT firing — so we flip on the integrator's push
      // recorded as a re-list; here we approximate: red until the branch is re-pushed at least once.
      const ciRed = (scenario === 'ci-red-then-green' && !st.repushedBranches.has(branch)) || scenario === 'always-ci-red';
      if (scenario === 'ci-red-then-green' && ciRed) st.repushedBranches.add(branch);
      const mergeConflict = scenario === 'merge-conflict';
      // Compute merge state for node-boundary flip scenarios.
      // readyCount is post-increment: `pr ready` fires BEFORE the grace views, so grace views (which
      // determine the verdict) see the updated count. Both new scenarios keep CI green so pr ready
      // always fires and the count advances on every node entry.
      let mergeStateStatus = mergeConflict ? 'DIRTY' : 'CLEAN';
      let mergeable = mergeConflict ? 'CONFLICTING' : 'MERGEABLE';
      if (scenario === 'checks-never-settle') {
        mergeStateStatus = 'UNKNOWN';
        mergeable = 'UNKNOWN';
      } else if (scenario === 'nonsense-poll-state') {
        mergeStateStatus = 'ALIEN';
        mergeable = 'BANANA';
      } else if (scenario === 'merge-unknown-then-clean') {
        // readyCount < 2: first pollPr node fires pr-ready (→1); grace views see readyCount=1 → UNKNOWN.
        // Second pollPr (after prRouter recheck self-loop) fires pr-ready (→2); grace views see
        // readyCount=2 → CLEAN. Exactly one prRouter recheck; converges to merge gate.
        if (st.readyCount < 2) { mergeStateStatus = 'UNKNOWN'; mergeable = 'UNKNOWN'; }
      } else if (scenario === 'merge-stale-at-reverify') {
        // readyCount < 3: pollPr (→1) and mergeReadiness (→2) both CLEAN (2 pre-gate nodes).
        // mergeApproveReverify fires pr-ready (→3); grace views see readyCount=3 → DIRTY →
        // mergeSignal blocked → {needsHuman} → catch → classifyRecovery → recoveryGate.
        if (st.readyCount >= 3) { mergeStateStatus = 'DIRTY'; mergeable = 'CONFLICTING'; }
      }
      const headRefOid = scenario === 'head-moved-after-approve' && st.readyCount >= 3 ? 'feedfacecafe' : 'deadbeefcafe';
      return JSON.stringify({
        number: 7,
        url: PR_URL,
        state: 'OPEN',
        isDraft: !st.readyBranches.has(branch),
        baseRefName: BASE,
        headRefName: branch,
        headRefOid,
        mergeStateStatus,
        reviewDecision: '',
        mergeable,
        statusCheckRollup: scenario === 'no-checks-registered'
          ? []
          : scenario === 'checks-never-settle'
          ? [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: null }]
          : scenario === 'nonsense-poll-state'
          ? [{ __typename: 'MysteryCheck', name: '???', state: 'WAT' }]
          : ciRed
          ? [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }]
          : [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      });
    }
    // Mirror REAL gh: there is NO `merged` JSON field — `state` (OPEN|MERGED|CLOSED) is the truth.
    // A freshly-created PR is a draft until `gh pr ready` (confirmMerge / integrator post-create view).
    return JSON.stringify({
      url: PR_URL,
      number: 1,
      state: scenario === 'merged-externally' || st.mergedBranches.has(branch)
        ? 'MERGED'
        : scenario === 'closed-externally'
        ? 'CLOSED'
        : 'OPEN',
      isDraft: !st.readyBranches.has(branch),
      mergeStateStatus: scenario === 'merge-not-clean' ? 'BLOCKED' : 'CLEAN',
    });
  }
  throw new Error(`unexpected gh call: ${args.join(' ')}`);
}

/** The single feature branch in play for an emulator instance (e2e routes one branch per run). */
function onlyBranch(st: GhState): string {
  return [...st.createdBranches][0] ?? '';
}

/** Single-scenario fake `gh`, recording argv into `calls`. (Default harness gh = `happy`.) */
export function createGhEmulator(calls: string[][], scenario: GhScenario = 'happy'): ExecGhFn {
  const st = newGhState();
  return (args: string[]): string => {
    calls.push(args);
    return ghBehavior(scenario, args, st);
  };
}

/**
 * Per-run fake `gh`: routes to a scenario by the feature branch (`feat/<taskId>-…`) present in the
 * gh argv, so one shared harness can drive many runs with different gh outcomes. Register a run case
 * keyed by taskId before starting it; unregistered runs get `happy`.
 *
 * Each run gets its OWN {@link GhState} so per-branch CI/thread/merge state never bleeds across runs.
 */
export function plannedGhEmulator(casePlans: CasePlanRegistry, calls: string[][]): ExecGhFn {
  const stateByTask = new Map<string, GhState>();
  const fallback = newGhState();
  // GraphQL review-thread calls carry owner/name/number, NOT the feature branch — they cannot be routed
  // by branch. collectPrReadiness always issues a branch-carrying `pr list`/`pr view` immediately BEFORE
  // its reviewThreads query within one poll, so the last branch-routed taskId is the right owner for it.
  let lastTaskId: string | undefined;
  return (args: string[]): string => {
    calls.push(args);
    const hasFeatureBranch = args.some((arg) => arg.includes('feat/'));
    const branchTaskId = casePlans.taskIdForArgs(args);
    if (branchTaskId !== undefined) {
      lastTaskId = branchTaskId;
    } else if (hasFeatureBranch) {
      lastTaskId = undefined;
    }
    const taskId = branchTaskId ?? (!hasFeatureBranch ? lastTaskId : undefined);
    const scenario = taskId ? casePlans.get(taskId)?.gh ?? 'happy' : 'happy';
    let st = fallback;
    if (taskId !== undefined) {
      st = stateByTask.get(taskId) ?? newGhState();
      stateByTask.set(taskId, st);
    }
    return ghBehavior(
      scenario,
      args,
      st,
      taskId !== undefined && casePlans.advisoryThreadVisible(taskId),
    );
  };
}
