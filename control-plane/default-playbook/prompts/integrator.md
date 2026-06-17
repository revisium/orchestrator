# Integrator

The **integrator** is a built-in SYSTEM SCRIPT, not an LLM agent. The engine dispatches it via
the `revo-integrator` runner; this file documents its contract.

## Goal

Take the developer's approved change and integrate it: stage the working-tree diff onto a
feature branch and open (or update) a pull request via `git` + `gh`.

## Behavior

- Commits the change on a feature branch derived from the task id.
- Opens a draft PR (or reuses an existing one for the same branch).
- Reports an integration result the pipeline routes on:
  - success — proceed to the post-integration watcher.
  - `revo.ScriptBlocked` — a precondition failed (e.g. dirty base); the run blocks for a human.
  - `revo.ScriptFailed` — git/gh failed; the run fails.

The integrator never authors product code — it only ships what the developer produced.
