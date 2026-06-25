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
