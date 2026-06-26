# ADR-0003 - GraphQL admin API graph shape

- **Status:** Accepted target; not fully implemented in current v1 SDL
- **Decision date:** 2026-06-26
- **Specs:** [GraphQL admin API v1](../specs/graphql-admin-api-v1.spec.md)
- **Refines:** GraphQL front-door decision from the Revo host plan ADRs

## Context

The current GraphQL API is a useful local admin front door over the shared product service layer. The committed
SDL is still mostly flat and RPC-shaped: several run facets are top-level queries keyed by run id, while other
facets are nested under `RunModel`.

That shape works for smoke tests, but it is awkward for an admin UI. It creates client stitching, overlapping
read windows, inconsistent collection shapes, `*Model` type names, string statuses, JSON escape hatches, and
subscriptions that do not compose around one run screen.

## Decision

Migrate GraphQL toward a graph-shaped admin contract.

Query roots should be nouns with ids, list roots, or unscoped operations. Anything scoped by `runId` should become
a field on `Run` instead of a separate top-level query.

Run detail should have one canonical graph rooted at `run(id)`. Money, inbox, progress, workflow, attempts, agent
activity, and events each need one source-of-truth rule. Append-log streams should push items; state changes should
push a thin token and let the client refetch its selected `run(id)` graph.

This is a migration decision, not a claim that the schema already landed. The spec separates current v1 SDL from
the target graph shape.

## Examples

- Current: `runWorkflow(id)`, `runDigest(id)`, `runAgentLog(data)`.
- Target: `run(id) { workflow digest-equivalent-fields agent { log(...) } }`, with overlapping digest fields
  replaced by real graph fields.
- Current compatibility JSON variants for PR readiness can remain temporarily, but typed variants are the UI
  contract.

## Alternatives

- **Keep the flat RPC surface:** rejected because it makes the UI stitch one run from multiple roots.
- **Expose separate live and persisted attempt models as one type:** rejected because they have different sources
  of truth.
- **Make every status/event string an enum:** rejected for open vocabularies such as run event types.
- **Promise batching in the schema contract:** rejected; batching is a service-layer optimization.

## Consequences

- The migration is breaking and should be phased: add graph-shaped fields and explicit names, port clients, then
  remove old names/roots.
- Service-layer read paths may need additions for cost, progress summary, created-by, activity, lifecycle
  mutations, and source-of-truth consistency.
- Current docs must not describe the target graph shape as already implemented.
- The committed SDL and schema drift test remain the source of current behavior during migration.
