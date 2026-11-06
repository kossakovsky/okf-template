---
type: Guide
title: okf-template
description: What this template is, how to create a repo from it, its commands and what to change afterwards.
---

# okf-template

A GitHub template for Markdown repositories. Every new repo starts as an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle with a Markdown linter and formatter ([rumdl](https://github.com/rvben/rumdl)), an OKF check with its tests, and a pre-commit hook that runs all three checks in parallel and rejects the commit if any of them is red.

## Create a repo

Use the **Use this template** button on GitHub, or:

```sh
gh repo create <name> --template kossakovsky/okf-template --private --clone
cd <name>
npm ci
```

It needs Node 26 or newer. `npm ci` installs the tools and connects the hook. It fails outside a git repository, because the hook could not be connected there.

## Commands

| Command | What it does |
| --- | --- |
| `npm run lint` | All three checks in parallel; each one reports even if another fails. The hook runs this |
| `npm run lint:md` | Markdown lint: `rumdl check .` |
| `npm run lint:format` | Markdown format check: `rumdl fmt --check .` |
| `npm run lint:okf` | OKF check: `node scripts/okf-check.ts` |
| `npm run fix` | Applies the Markdown format and the lint fixes rumdl can make: `rumdl fmt .`. It exits 0 even if errors remain, so run `npm run lint` after it |
| `npm test` | Tests of the OKF check and of the exclusions in `.rumdl.toml` |

The hook checks the whole working tree, not just the staged files. An unstaged file with an error blocks the commit, and after a partial `git add` a green hook does not prove the staged version is green. The hook does not run for `git commit --no-verify`, a merge without conflicts, `git cherry-pick`, `git revert` or a plain `git rebase`, or at all after `npm ci --ignore-scripts`; `npm run lint` is the full check.

## Exclude files from the checks

To keep a tracked path out of the checks, add it in both places:

- `exclude` in `.rumdl.toml`, for the lint and format checks: `"/drafts"`;
- `NOT_IN_BUNDLE` in `scripts/okf.ts`, for the OKF check: `':(exclude)drafts'`.

Files that `.gitignore` covers and git does not track stay out of all three checks with no further setup. rumdl also skips tracked files that `.gitignore` covers and anything in your global git ignore, while the OKF check still sees them.

To turn off one rule for some files and keep the other checks, add them to `[per-file-ignores]` in `.rumdl.toml`: `"drafts/*.md" = ["MD036"]`.

The root `.claude/` is excluded by default: Claude Code reads the frontmatter of the prompts there, and it is not OKF.

## What to change after creating a repo

- `name` in `package.json`, then run `npm install --package-lock-only` to update `package-lock.json`;
- the heading in `index.md`, and the `README.md` and `CLAUDE.md` lines there;
- `README.md` and `CLAUDE.md`: replace the text with your repo's own. Keep the frontmatter and their lines in `index.md`: the OKF check requires them to exist. It does not compare their text, so update both by hand;
- `LICENSE`: replace or delete it. It covers this template (MIT-0, no attribution required), not your content.
