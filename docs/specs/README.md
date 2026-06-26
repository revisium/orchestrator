# Specs

Specs are durable contracts for implemented or approved product surfaces. They hold exact types, schemas,
API behavior, state-machine grammar, validation rules, examples, and changelog notes.

Work orders, slices, task lists, and delivery sequencing do not live here. Track those in GitHub Issues or Revo
dogfooding runs. Obsolete plans are recovered from git history when needed; this repository does not keep a docs
archive of superseded plans.

## Current specs

| Spec | Contract |
| --- | --- |
| [graphql-admin-api-v1.spec.md](./graphql-admin-api-v1.spec.md) | Local GraphQL admin API: current v1 SDL surface, transport rules, verification, and graph-shape migration target |
| [pipeline-state-machine-v1.spec.md](./pipeline-state-machine-v1.spec.md) | Data-driven pipeline template grammar, reducer contract, validation, versioning, and diff classification |
| [run-dataflow-v1.spec.md](./run-dataflow-v1.spec.md) | Step output production/consumption, prompt hydration, runtime output storage, and validation |
| [human-gates-v1.spec.md](./human-gates-v1.spec.md) | Inbox-backed human gates, gate resolution, question gates, watch tools, and PR review-feedback gates |

## Authoring rules

- Keep ADRs short. Put exact contracts here.
- Separate current behavior from target migration behavior when the code has not landed yet.
- Cite authoritative source files for current behavior.
- Include validation and compatibility rules, not just happy-path examples.
- Add a changelog entry when the contract changes.
