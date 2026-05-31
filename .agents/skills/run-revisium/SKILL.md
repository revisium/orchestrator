---
name: run-revisium
description: Run, check, and stop the local standalone Revisium daemon that backs the orchestrator control plane.
---

# Run Revisium (local daemon)

Operate the local standalone Revisium via the `revo` CLI.

## Rules

- Always go through `revo revisium …` — never raw `npx @revisium/standalone`. Otherwise `runtime.json` and the
  resolved port drift out of sync.
- Never hardcode the port. Read the live port from `~/.revisium-orchestrator/runtime.json` (preferred `19222`,
  but the CLI scans upward if busy).
- Stop gracefully (`revo revisium stop` → SIGTERM) so PostgreSQL checkpoints; do not `kill -9` by hand.
- Never `rm -rf ~/.revisium-orchestrator` without stopping first.

## Workflow

1. `revo revisium start` — wait for health (first run downloads embedded PostgreSQL, ~60–120s).
2. `revo revisium status` — confirm `running … health OK`; note the resolved port.
3. Use the URLs on that port: Admin `/`, REST `/api`, GraphQL `/graphql`, MCP `/mcp`.
4. Troubleshoot via `revo revisium logs -n 50` (Node version, port busy, pg init).
5. `revo revisium stop` when done.
