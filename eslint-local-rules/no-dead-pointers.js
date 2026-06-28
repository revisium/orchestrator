// Project-local eslint rule: ban dead-pointer / crypto-tag tokens in comments.
// Replaces scripts/check-comments.mjs — reuses eslint's comment lexing instead of a
// hand-rolled block-comment parser. See VERIFICATION.md (comment policy, HARD RULE).

const IN_REPO_DOC_PATH = /docs\/(?:specs|adr|plans)\//;

// Each entry: { re, when? }. `when(commentValue) -> boolean` gates whether `re` is tested
// (used so a bare §N is valid when the comment also cites an in-repo doc path).
const PATTERNS = [
  { re: /§\d+(?:\.\d+)*/, when: (v) => !IN_REPO_DOC_PATH.test(v) },
  // Crypto internal rule tags: any single-letter+digit (G9, B5, C1, D3, F21, M3, S4036…) and CR-X.
  { re: /\bCR-[A-Z]\b/ },
  { re: /\b[A-Z]\d+\b/ },
  { re: /(?<!ADR[-\s])\d{4}\s*#\s*\d+\b/ },
  { re: /\bplan\s+\d{4}\b/i },
  { re: /\bTASK\s+\d{4}\b/ },
  { re: /\bslice\s+\d+/, },
  { re: /\bconsensus\s+M\d+/i },
  { re: /\baudit\s+§/ },
];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      deadPointer:
        'dead-pointer/crypto tag "{{token}}" in comment — strip it (see VERIFICATION.md comment policy).',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          for (const p of PATTERNS) {
            if (p.when && !p.when(comment.value)) continue;
            const m = comment.value.match(p.re);
            if (m) {
              context.report({ loc: comment.loc, messageId: 'deadPointer', data: { token: m[0] } });
              break;
            }
          }
        }
      },
    };
  },
};
