# ACP + OpenCode Research

- **Status:** Bounded PoC evidence for
  [ADR-0010](../../adr/0010-acp-process-and-session-isolation.md) and the
  [ACP runner session v1 spec](../../specs/acp-runner-session-v1.spec.md).
- **Date:** 2026-07-08.

## Read Order

1. [Documentation review](./en/documentation-review.md) - documentation facts, unknowns, and initial Revo implications.
2. [Experiment matrix](./en/experiment-matrix.md) - hypotheses, PoC harness requirements, and experiment matrix.
3. [External provider setup](./en/external-provider-setup.md) - research-only setup for free external OpenCode providers/models.
4. [Experiment results 2026-07-08](./en/experiment-results-2026-07-08.md) - local PoC results and follow-up gaps from July 8, 2026.

Raw JSONL artifacts from the local PoC runs were written outside the repository:

```text
/tmp/revo-opencode-acp-research-artifacts/*.jsonl
```

Those artifacts are local evidence from bounded PoC runs, not a committed contract or reusable fixture set. The ADR
and spec are normative; re-run or refresh these experiments if the OpenCode version, provider setup, model, sandbox,
or ACP implementation changes.
