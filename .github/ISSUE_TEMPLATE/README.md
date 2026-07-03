# Issue Writing Rules

Issues are for both humans and agents. Write them as durable project context,
not as a private prompt fragment or a raw log dump.

## Language

- Use clear professional English.
- Prefer short paragraphs and concrete nouns over vague shorthand.
- Expand local abbreviations the first time they appear.
- Link to evidence instead of assuming the reader knows the chat history.

## Reader Context

Every non-trivial issue should be understandable from the issue itself plus its
linked parent issue, ADR, design doc, PR, or Revo run. A reader should be able
to answer:

- what failed or needs to change;
- why it matters;
- what evidence supports the issue;
- what outcome closes the issue;
- which decisions are already made and which are still open.

## Scope

- Keep bugs focused on observed behavior and expected behavior.
- Keep delivery slices focused on one reviewable PR.
- Use umbrella issues only to organize child issues; do not hide the real work
  only inside the umbrella body.
- Use decision/spec issues when the next step is thinking, not coding.

## Density

- Lead with one plain-language paragraph: what happened or must change, why it
  matters, and what is being asked — no code tokens.
- Keep code-level forensics (paths, line numbers, call chains, inline schemas)
  in a collapsed `<details>` appendix at the end of the issue or in a linked
  artifact, never inline in the body sections.
- Budget the body: a decision issue targets roughly 600 words outside the
  appendix; a bug about half of that. Overflow means ADR, spec, or
  delivery-slice material is being written in the wrong place.
- Write one claim per sentence; name transitions with verbs instead of arrow
  chains; gloss project-internal jargon on first use.
- Use bold for at most one load-bearing statement per section, and never for
  inline code tokens.
- Consensus or multi-voice revision must compress, not accrete: after the last
  review round, remove qualifiers whose only purpose was to pre-empt a reviewer
  objection. The answered objection lives in the review thread or the appendix.

Canonical rules: [`references/quality/issue-authoring.md`](https://github.com/revisium/agent-playbook/blob/master/references/quality/issue-authoring.md)
in the agent playbook.
