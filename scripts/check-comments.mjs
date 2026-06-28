#!/usr/bin/env node
/**
 * check-comments.mjs — scan src/**\/*.ts (excluding *.test.ts and src/e2e/**)
 * for banned dead-pointer tokens in comments. Print each offender as file:line +
 * matched token. Exit 1 if any found.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(ROOT, 'src');

// When a block comment contains an in-repo doc path anywhere in the block,
// §N refs in that block are valid spec section pointers — do NOT flag them.
const IN_REPO_PATH_RE = /docs\/(?:specs|adr|plans)\//;

// Banned dead-pointer patterns.
const BANNED = [
  // §N bare section refs — skipped when the enclosing block comment references an in-repo doc path
  { re: /§\d+(?:\.\d+)*/, skipIfBlockHasInRepoPath: true },
  // plan 0015-0018
  { re: /\bplan\s+0(?:015|016|017|018)\b/i, skipIfBlockHasInRepoPath: false },
  // bare plan numbers 0015-0018 standing alone
  { re: /\b0(?:015|016|017|018)\b/, skipIfBlockHasInRepoPath: false },
  // slice N
  { re: /\bslice\s+\d+/, skipIfBlockHasInRepoPath: false },
  // consensus MN
  { re: /\bconsensus\s+M\d+/i, skipIfBlockHasInRepoPath: false },
  // audit §X
  { re: /\baudit\s+§/, skipIfBlockHasInRepoPath: false },
];

function* walkTs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'e2e') continue;
      yield* walkTs(full);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts')
    ) {
      yield full;
    }
  }
}

let offenders = 0;

for (const file of walkTs(SRC)) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, 'utf8').split('\n');

  let inBlock = false;       // inside a /* ... */ block comment
  let blockHasInRepoPath = false; // the current block contains a docs/ path

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();

    // Detect block comment boundaries and extract comment text.
    let text = null;

    if (inBlock) {
      // Inside an open block comment: each line is comment content.
      if (trimmed.includes('*/')) {
        // Last line of block.
        text = raw.slice(0, raw.indexOf('*/')); // everything before */
        inBlock = false;
      } else {
        text = raw;
      }
      if (IN_REPO_PATH_RE.test(text ?? '')) blockHasInRepoPath = true;
    } else if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
      // Block comment opener.
      inBlock = true;
      blockHasInRepoPath = false;
      const afterOpen = trimmed.startsWith('/**') ? trimmed.slice(3) : trimmed.slice(2);
      if (afterOpen.includes('*/')) {
        // Single-line block comment: /** ... */
        text = afterOpen.slice(0, afterOpen.indexOf('*/'));
        inBlock = false;
      } else {
        text = afterOpen;
      }
      if (IN_REPO_PATH_RE.test(text ?? '')) blockHasInRepoPath = true;
    } else {
      // Not in a block comment: look for // single-line comment.
      const idx = raw.indexOf('//');
      if (idx >= 0) {
        text = raw.slice(idx + 2);
        blockHasInRepoPath = false; // single-line comment — not a block
      }
    }

    if (text === null) continue;

    for (const { re, skipIfBlockHasInRepoPath } of BANNED) {
      if (skipIfBlockHasInRepoPath && blockHasInRepoPath) continue;
      const m = text.match(re);
      if (m) {
        console.log(`${rel}:${i + 1}  ${m[0]}`);
        offenders++;
        break; // one report per line
      }
    }
  }
}

if (offenders > 0) {
  console.error(`\n${offenders} dead-pointer token(s) found. Strip them before merging.`);
  process.exit(1);
}
