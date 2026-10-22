/**
 * The markdown helpers moved to `src/core/markdown.ts` (Phase 1 step 5) so that the pure guard
 * text (`src/guard/revert-text.ts`) can use them without importing from `src/github`.
 */
export { codeSpan, escapeProse } from "../core/markdown.js";
