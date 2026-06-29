# Specs

Specs are durable contracts for implemented or approved product surfaces. They hold exact types, schemas,
API behavior, state-machine grammar, validation rules, examples, and changelog notes.

Work orders, slices, task lists, and delivery sequencing do not live here. Track those in GitHub Issues or Revo
dogfooding runs. Obsolete plans are recovered from git history when needed; this repository does not keep a docs
archive of superseded plans.

## Current specs

| Spec | Contract |
| --- | --- |
| [graphql-admin-api-v1.spec.md](./graphql-admin-api-v1.spec.md) | Local GraphQL admin API: transport rules, graph-shaped contract, compatibility, and verification |
| [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md) | Data-driven pipeline template grammar, reducer contract, validation, versioning, and diff classification |
| [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md) | Step output production/consumption, prompt hydration, runtime output storage, and validation |
| [human-gates-v1.spec.md](./human-gates-v1.spec.md) | Inbox-backed human gates, gate resolution, question gates, watch tools, and PR review-feedback gates |
| [default-playbook-policy.spec.md](./default-playbook-policy.spec.md) | Bundled `feature-development` policy rules, static verifier scope, and merge-gate recheck behavior |
| [runner-manifest-v1.spec.md](./runner-manifest-v1.spec.md) | Runner manifest field schema, StdoutParser/PermissionStyle code contracts, route-time capability snapshot, and replay determinism |
| [runner-result-envelope-v1.spec.md](./runner-result-envelope-v1.spec.md) | Canonical result envelope, structured-output tiers, `submit_result` tool-call floor, tier degradation, and the verdict-presence validate seam |
| [runner-capabilities-v1.spec.md](./runner-capabilities-v1.spec.md) | Runner capability vocabulary replacing the hardcoded branch functions, with one-to-one replacement mapping and worked blocks |

## Authoring rules

- Keep ADRs short. Put exact contracts here.
- Separate compatibility policy from the target public contract.
- Cite authoritative source files for implemented behavior.
- Include validation and compatibility rules, not just happy-path examples.
- Add a changelog entry when the contract changes.
