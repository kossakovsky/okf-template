// Checks a repo as an OKF v0.2 bundle plus stricter rules: a required root index with only `okf_version` in its frontmatter, non-empty
// title and description, index links that resolve, every page but log.md in its nearest index.md, `.md` only; index text is not compared.

import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { parseDocument } from 'yaml';

const FRONTMATTER = /^\uFEFF?---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
// A backtick fence's info string has no backticks, so ```x``` on a line is inline code, not a fence.
const FENCED_CODE = /^ {0,3}(`{3,}(?=[^`\n]*$)|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t\r]*$|(?![\s\S]))/gm;
// HTML comments, code spans (which never cross a blank line) and images.
const NOT_LINKS = /<!--[\s\S]*?-->|(`+)(?:(?!\n[ \t]*\r?\n)[\s\S])*?\1|!\[[^\]]*\]\([^)]*\)/g;
const INLINE_LINK = /\]\(\s*(?:<([^>]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_LINK = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm;
const HEADING_2 = /^ {0,3}##(?:[ \t]|$)/;
const LOG_HEADING = /^## (\d{4}-\d{2}-\d{2})$/;
const BLANK = /^[\s\p{Cf}]*$/u;
const REQUIRED = ['type', 'title', 'description'];
// Git sets some of these in hooks (GIT_INDEX_FILE, and GIT_DIR in a linked worktree): they would point `git ls-files` at
// another repo or index than the one in `root`. The rest are cleared as a precaution.
const GIT_LOCATION = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY'];
// Outside the bundle, as git pathspecs from the repo root; keep rumdl's `exclude` in step. Files in .claude/ are prompts whose frontmatter Claude Code reads.
const NOT_IN_BUNDLE = [':(exclude).claude'];

type ReadText = (path: string) => string;

const isIndex = (path: string) => posix.basename(path) === 'index.md';
const isLog = (path: string) => posix.basename(path) === 'log.md';

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isDate = (s: string) => {
  const date = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(s);
};

const withoutCode = (text: string) => text.replace(FENCED_CODE, '');

// The frontmatter: `undefined` when the file has no block, else the parsed YAML (`null` for an empty block).
// Throws on YAML errors and warnings, such as an unknown tag.
function frontmatter(text: string): unknown {
  const m = text.match(FRONTMATTER);
  if (!m) return undefined;
  const doc = parseDocument(m[1] ?? '');
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) throw problem;
  return doc.toJS();
}

// Bundle paths (`docs/a.md`) an index links to: relative to its folder or bundle-absolute (`/docs/a.md`),
// `dir/` meaning `dir/index.md`; anchors dropped, external and non-.md targets ignored.
export function indexTargets(text: string, indexPath: string): ReadonlySet<string> {
  const out = new Set<string>();
  const body = withoutCode(text).replace(NOT_LINKS, '');
  for (const m of [...body.matchAll(INLINE_LINK), ...body.matchAll(REFERENCE_LINK)]) {
    const raw = m[1] ?? m[2];
    if (raw === undefined) continue;
    let target = raw.replace(/#.*$/, '');
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      // Malformed percent-encoding: the target stays as written.
    }
    if (target.endsWith('/')) target += 'index.md';
    if (!target.endsWith('.md')) continue;
    const full = target.startsWith('/')
      ? target.slice(1)
      : posix.join(posix.dirname(indexPath), target);
    out.add(posix.normalize(full));
  }
  return out;
}

// The nearest index.md in `dir` or above it, within the bundle. `dir` is relative, so dirname ends at '.'.
function governingIndex(dir: string, indexes: ReadonlyMap<string, ReadonlySet<string>>): string | null {
  for (let d = dir; ; d = posix.dirname(d)) {
    const candidate = d === '.' ? 'index.md' : `${d}/index.md`;
    if (indexes.has(candidate)) return candidate;
    if (d === '.') return null;
  }
}

function checkFile(path: string, text: string): string[] {
  if (!path.endsWith('.md')) {
    return ['Markdown files must use the `.md` extension'];
  }
  let fm: unknown;
  try {
    fm = frontmatter(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return [`invalid YAML frontmatter: ${message.split('\n')[0]}`];
  }

  if (isIndex(path)) {
    if (path !== 'index.md') {
      return fm === undefined ? [] : ['a nested index.md must have no frontmatter'];
    }
    const ok = isObject(fm) && Object.keys(fm).length === 1 && fm.okf_version === '0.2';
    return ok ? [] : ['the root index.md frontmatter must be exactly `okf_version: "0.2"`'];
  }

  if (isLog(path)) {
    return withoutCode(text)
      .replace(NOT_LINKS, '')
      .split(/\r?\n/)
      .filter((line) => HEADING_2.test(line))
      .filter((line) => {
        const date = line.match(LOG_HEADING)?.[1];
        return date === undefined || !isDate(date);
      })
      .map((line) => `log heading must be a date, \`## YYYY-MM-DD\`: ${line}`);
  }

  if (fm === undefined) return ['no YAML frontmatter block'];
  if (!isObject(fm)) return ['frontmatter must be a YAML mapping'];
  return REQUIRED.filter((key) => {
    const value = fm[key];
    return typeof value !== 'string' || BLANK.test(value);
  }).map((key) => `frontmatter \`${key}\` must be a non-empty string`);
}

// Every error in the bundle as `path: message`. `files` are relative bundle paths with `/` separators.
export function checkBundle(files: readonly string[], read: ReadText): string[] {
  const errors: string[] = [];
  const known = new Set(files);
  const targets = new Map<string, ReadonlySet<string>>();
  for (const path of files) {
    const text = read(path);
    for (const message of checkFile(path, text)) {
      errors.push(`${path}: ${message}`);
    }
    if (isIndex(path)) targets.set(path, indexTargets(text, path));
  }
  if (!targets.has('index.md')) {
    errors.push('index.md: missing at the bundle root');
  }

  for (const [index, links] of targets) {
    for (const target of links) {
      if (!known.has(target)) errors.push(`${index}: links to a missing ${target}`);
    }
  }

  for (const path of files) {
    if (path === 'index.md' || isLog(path)) continue;
    // A nested index answers to the index above its own folder.
    const folder = posix.dirname(path);
    const index = governingIndex(isIndex(path) ? posix.dirname(folder) : folder, targets);
    if (index && !targets.get(index)?.has(path)) {
      errors.push(`${path}: not linked from ${index}`);
    }
  }
  return errors;
}

// The repo's Markdown files, any case of .md/.markdown/.mdx: tracked, plus untracked ones that .gitignore and
// .git/info/exclude let through; deleted ones and NOT_IN_BUNDLE dropped. The user's global excludes file is off.
export function repoMarkdown(root: string): string[] {
  const env = { ...process.env };
  for (const name of GIT_LOCATION) delete env[name];
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.excludesFile=/dev/null', 'ls-files', '-z', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
  const patterns = ['--', ':(icase)*.md', ':(icase)*.markdown', ':(icase)*.mdx', ...NOT_IN_BUNDLE];
  const deleted = new Set(git('--deleted', ...patterns));
  const all = git('--cached', '--others', '--exclude-standard', ...patterns);
  return [...new Set(all)].filter((path) => !deleted.has(path)).sort();
}
