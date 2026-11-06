---
type: Agent Guide
title: CLAUDE.md — okf-template
description: The rules for agents working in this repo.
---

# okf-template

- **Markdown in this repo is an OKF bundle.** A new `.md` needs frontmatter with non-empty `type`, `title` and `description`, and a line `- [title](path) — description` in its nearest `index.md` going up. If you change a `title` or `description`, change that line too: the check does not compare them. Some names differ: the root `index.md` has only `okf_version: "0.2"` in its frontmatter; a nested `index.md` has no frontmatter and is linked from the index above its folder; a `log.md` needs neither frontmatter nor a line, only `## YYYY-MM-DD` headings.
- **`npm run lint` is the commit gate.** It runs the Markdown lint, the Markdown format check and the OKF check in parallel. The pre-commit hook runs it on the whole working tree, not just the staged files: an unstaged file with an error blocks the commit, and after a partial `git add` a green hook does not prove the staged version is green.
- **Fix what is red.** `npm run fix` applies the format and the lint fixes rumdl can make, and exits 0 even if errors remain, so run `npm run lint` after it. OKF errors and the other lint errors are edited by hand.
- **Run `npm test` after changing `scripts/`.** The hook does not run it.
