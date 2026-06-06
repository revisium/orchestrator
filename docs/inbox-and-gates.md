# Human control: the inbox & gates

> **Updated by the DBOS pivot ([ADR-0001](./adr/0001-execution-engine-and-host.md)).** The inbox stays in Revisium
> (single human queue, signed resolutions). The **mechanic changes**: parking no longer flips a `steps` row to
> `awaiting_approval` — instead the DBOS workflow writes an inbox row and durably waits on `DBOS.recv`, and `revo
> inbox resolve` signals it with `DBOS.send` (invariant #5). Built in
> [plans/0004-human-gates-via-dbos-inbox.md](./plans/0004-human-gates-via-dbos-inbox.md). Read step-status
> references below as pre-pivot.

> **Status: DRAFT.** Built with the inbox slice.
> **Depends on:** [repo-layer-contract.md](./repo-layer-contract.md) (`pushInbox` / `resolveInbox` /
> `listInbox`) · [control-plane-schema.md](./control-plane-schema.md) (`inbox`, `routing_policy`) ·
> [architecture-overview.md](./architecture-overview.md) (invariant: a human decision is a status change).
> **Realized by:** brief §11 / §11.1, built as a slice after the data-access layer (Plan TBD).

Everything that needs a human flows into **one** inbox (control plane): plan approval, merge approval, agent
blocker-questions, alerts (risky op / budget). Never split per project; decisions are signed (`resolved_by`)
even on the shared queue.

## Two mandatory gates

- **Plan** (before code) and **Merge** (into main). Everything else is auto-passed over time by
  `routing_policy.requires_human`.
- **Auto-recommendation + your approval:** the plan arrives filled in (breakdown + model levels + cost estimate
  + risk flags); the default is "approve as-is" in one action, editing is the exception. Record edits (later:
  feed them back into policy).

## Mechanics

- A parked step → `awaiting_approval`; its branch stops, siblings keep going. The human's `resolveInbox` answer
  revives the branch on the loop's next turn — a fresh narrow run carrying the context + answer (not a resumed
  session).
- **Escalation is directed:** an agent's question goes **up** to the architect-agent first; **out** to the human
  only for judgment calls and missing external knowledge.
- Notification (a light "N new" ping) and resolution (commands / a session) are **different channels**. MVP can
  skip push — the inbox just shows a count.

## Reviewer comments from GitHub — routed by type (§11.1)

A sorter step classifies each comment:
- **code fix** → straight to the developer (fix autonomously, push to the PR);
- **question / doubt** → developer **answers in-thread**; a fix only if the answer implies one;
- **objection to a decision (ADR)** → **up** (architect / human inbox). The developer may not change
  architecture on its own — stated explicitly in its prompt.
- Live-human comments, when the type is unclear → lean toward escalation. Auto-posting replies to live reviewers
  is deferred; at the start the user vets an agent's reply to a human.

"A comment appeared" is caught by the orchestrator (poll / GitHub webhook); "what is it and where does it go" is
an agent step. The result is ordinary steps / inbox records — same state-driven principle.
