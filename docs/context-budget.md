# Context budget

Revo starts short-lived agents. Every step should receive current state, not a chat transcript.

## Context layers

1. **Who I am:** role prompt, scope, allowed tools, runner policy.
2. **What we are doing:** run title, selected repo(s), relevant decisions, selected pipeline node.
3. **What is already done:** produced outputs, artifact refs, PR/branch pointers, concise lessons.
4. **What is right now:** the single task, review comment, gate, or script action for this step.

## Do not include

- Full dialogue history.
- Whole repository dumps.
- Unrelated ADR rationale.
- Raw logs when a concise lesson or artifact reference is enough.
- Code diffs copied into Revisium payloads.

## Dataflow

Step outputs used by later steps must be declared with `produces` and `consumes`. The adapter hydrates those
outputs into a stable inputs section before a runner starts. See
[specs/run-dataflow-v1.spec.md](./specs/run-dataflow-v1.spec.md).

## Cost discipline

Measure before optimizing. Use attempt and cost projections to find expensive steps, then compress the dominant
context layer. The usual first targets are oversized prior outputs and raw logs.
