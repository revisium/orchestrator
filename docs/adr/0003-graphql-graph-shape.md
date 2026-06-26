# ADR-0003 - GraphQL admin API graph shape

- **Status:** Accepted
- **Decision date:** 2026-06-26
- **Spec:** [GraphQL admin API v1](../specs/graphql-admin-api-v1.spec.md)
- **Refines:** GraphQL front-door decision from the Revo host plan ADRs

## Context

The GraphQL admin API is the UI and script front door for Revo host operations. Its contract should let the admin
UI render a run screen from one graph rooted at `run(id)`, while keeping product meaning behind feature services
instead of exposing persistence or workflow internals.

The contract needs stable rules for where fields live, how run-scoped facets compose, which concepts own source
data, which vocabularies are closed enums, and how subscriptions update a selected graph without forcing client
stitching.

## Decision

Adopt a graph-shaped admin contract.

Query roots are nouns with ids, list roots, or unscoped operations. Anything that requires a `runId` is a field on
`Run`, not a separate public root. A run screen should be able to issue one `run(id)` query that carries workflow,
events, inbox, attempts, agent observability, cost, usage, progress, and related display metadata.

Each concept has one source-of-truth rule:

- money is recorded through the `Run.cost` ledger, with `Usage` derived from it;
- inbox and gate state come from run-scoped inbox rows and their statuses;
- persisted run attempts and live agent attempts remain separate shapes;
- raw run events stay immutable, while activity feeds are derived views.

Subscriptions follow two patterns: append-log streams push appended items, and state changes push a thin
`RunChange` token that lets clients refetch their selected `run(id)` graph.

## Examples

```graphql
query RunScreen($id: ID!) {
  run(id: $id) {
    id
    status
    progress {
      status
      executionPosition
    }
    progressSummary {
      done
      total
    }
    workflow {
      nodes {
        id
        kind
        status
      }
      edges {
        from
        to
      }
    }
    inbox(status: PENDING, first: 20) {
      edges {
        node {
          id
          kind
          status
          risk {
            level
          }
        }
      }
    }
    cost(first: 20) {
      edges {
        node {
          amount
          currency
        }
      }
    }
    usage {
      totalCost
      totalTokens
    }
    agent {
      activity(first: 20) {
        edges {
          node {
            message
          }
        }
      }
    }
  }
}
```

```graphql
subscription RunScreenChanged($runId: ID!) {
  runChanged(runId: $runId) {
    runId
    changedAt
    kind
  }
}
```

## Boundaries

- Use clean domain names such as `Run`, `InboxItem`, and `WorkflowNode`.
- Use enums for closed sets such as run status, run priority, inbox kind/status, and workflow node kind.
- Keep open vocabularies such as `RunEvent.type` as `String`.
- Keep lifecycle mutations to `createRun`, `startRun`, `cancelRun`, and `installPlaybook`; continuation after
  human input is driven by inbox resolution, not a separate resume mutation.
- State performance expectations as query-shape and source-ownership rules. Batching and fan-out reduction are
  service-layer concerns, not schema guarantees.

## Consequences

- The admin UI can compose each run screen around one `run(id)` selection instead of coordinating parallel roots.
- Compatibility work must add graph-shaped fields first, port consumers, then remove legacy run-scoped roots and
  overlapping aggregate fields according to the spec.
- Feature services need read paths for run cost, progress summary, created-by metadata, activity, lifecycle
  mutations, and source-of-truth consistency.
- Schema drift tests and host e2e tests must guard the accepted public contract.
