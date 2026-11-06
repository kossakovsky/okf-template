import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBundle, indexTargets, repoMarkdown } from './okf.ts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const RUMDL = join(SCRIPTS, '../node_modules/.bin/rumdl');
const BOM = String.fromCodePoint(0xfeff);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const WORD_JOINER = String.fromCodePoint(0x2060);

const page = (type = 'Guide') =>
  `---\ntype: ${type}\ntitle: A page\ndescription: One sentence.\n---\n# A page\n`;

const ROOT_INDEX = `---\nokf_version: "0.2"\n---\n# Bundle\n\n- [A](a.md) — one.\n- [Docs](docs/index.md) — docs.\n`;

const GOOD: Record<string, string> = {
  'index.md': ROOT_INDEX,
  'a.md': page(),
  'docs/index.md': '# Docs\n\n- [B](/docs/b.md) — two.\n',
  'docs/b.md': page('Decision Log'),
  'log.md': '# Log\n\n## 2026-11-04\n\n### Details\n\n- started.\n',
};

function check(files: Record<string, string>) {
  return checkBundle(Object.keys(files), (path) => {
    const text = files[path];
    assert.ok(text !== undefined, path);
    return text;
  });
}

test('a conformant bundle has no errors', () => {
  assert.deepEqual(check(GOOD), []);
});

test('BOM and CRLF are accepted', () => {
  const crlf = (s: string) => `${BOM}${s.replaceAll('\n', '\r\n')}`;
  assert.deepEqual(
    check({ ...GOOD, 'index.md': crlf(ROOT_INDEX), 'a.md': crlf(page()), 'log.md': crlf('# Log\n\n## 2026-11-04\n') }),
    [],
  );
});

test('a page without frontmatter is an error', () => {
  assert.deepEqual(check({ ...GOOD, 'a.md': '# A\n' }), ['a.md: no YAML frontmatter block']);
});

test('frontmatter that is empty or not a mapping is an error', () => {
  for (const block of ['', 'just text', '- a\n- b']) {
    const text = block === '' ? '---\n---\n# A\n' : `---\n${block}\n---\n# A\n`;
    assert.deepEqual(check({ ...GOOD, 'a.md': text }), ['a.md: frontmatter must be a YAML mapping'], block);
  }
});

test('`type`, `title` and `description` must be non-empty strings', () => {
  for (const key of ['type', 'title', 'description']) {
    for (const value of ['', '""', '"  "', `"${ZERO_WIDTH_SPACE}"`, `"${WORD_JOINER}"`, '123', '[a]']) {
      const fields = { type: 'Guide', title: 'A', description: 'One.', [key]: value };
      const text = `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
      assert.deepEqual(
        check({ ...GOOD, 'a.md': text }),
        [`a.md: frontmatter \`${key}\` must be a non-empty string`],
        `${key}: ${value}`,
      );
    }
  }
});

test('a missing `type`, `title` or `description` is an error', () => {
  for (const key of ['type', 'title', 'description']) {
    const fields = ['type: Guide', 'title: A', 'description: One.'].filter((line) => !line.startsWith(key));
    assert.deepEqual(check({ ...GOOD, 'a.md': `---\n${fields.join('\n')}\n---\n` }), [
      `a.md: frontmatter \`${key}\` must be a non-empty string`,
    ]);
  }
});

test('a frontmatter block may end at the end of the file or with trailing spaces', () => {
  for (const close of ['---', '--- \n']) {
    assert.deepEqual(check({ ...GOOD, 'a.md': `---\ntype: Guide\ntitle: A\ndescription: One.\n${close}` }), [], close);
  }
});

test('invalid YAML is an error', () => {
  const text = '---\ntype: Guide\ntitle: Report: competitors\ndescription: One.\n---\n';
  const errors = check({ ...GOOD, 'a.md': text });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /^a\.md: invalid YAML frontmatter/);
});

test('a YAML warning, such as an unknown tag, is an error', () => {
  const text = '---\ntype: !foo Guide\ntitle: A\ndescription: One.\n---\n';
  assert.match(check({ ...GOOD, 'a.md': text })[0] ?? '', /^a\.md: invalid YAML frontmatter/);
});

test('a nested index.md must have no frontmatter, empty or not', () => {
  for (const block of ['---\ntype: Index\n---\n', '---\n---\n']) {
    assert.deepEqual(check({ ...GOOD, 'docs/index.md': block + GOOD['docs/index.md'] }), [
      'docs/index.md: a nested index.md must have no frontmatter',
    ]);
  }
});

test('the root index.md frontmatter must be exactly okf_version "0.2"', () => {
  const body = ROOT_INDEX.replace(/^---\n[\s\S]*?\n---\n/, '');
  const variants = [
    body,
    `---\n---\n${body}`,
    `---\nokf_version: 0.2\n---\n${body}`,
    `---\nokf_version: "0.1"\n---\n${body}`,
    `---\nokf_version: "0.2"\ntitle: Bundle\n---\n${body}`,
  ];
  for (const text of variants) {
    assert.deepEqual(
      check({ ...GOOD, 'index.md': text }),
      ['index.md: the root index.md frontmatter must be exactly `okf_version: "0.2"`'],
      text,
    );
  }
});

test('a bundle without a root index.md is an error', () => {
  const { 'index.md': _, ...rest } = GOOD;
  assert.deepEqual(check(rest), ['index.md: missing at the bundle root']);
});

test('a page missing from the nearest index.md is an error', () => {
  assert.deepEqual(check({ ...GOOD, 'docs/c.md': page() }), ['docs/c.md: not linked from docs/index.md']);
});

test('a link from an index further up does not count', () => {
  const root = `${ROOT_INDEX}- [C](docs/c.md) — three.\n`;
  assert.deepEqual(check({ ...GOOD, 'index.md': root, 'docs/c.md': page() }), [
    'docs/c.md: not linked from docs/index.md',
  ]);
});

test('a nested index.md missing from the index above is an error', () => {
  const root = ROOT_INDEX.replace('- [Docs](docs/index.md) — docs.\n', '');
  assert.deepEqual(check({ ...GOOD, 'index.md': root }), ['docs/index.md: not linked from index.md']);
});

test('a nested index.md answers to the index above its own folder', () => {
  const files = { ...GOOD, 'docs/ref/index.md': '# Ref\n\n- [C](c.md) — c.\n', 'docs/ref/c.md': page() };
  assert.deepEqual(check(files), ['docs/ref/index.md: not linked from docs/index.md']);
  const docs = `${GOOD['docs/index.md']}- [Ref](ref/) — ref.\n`;
  assert.deepEqual(check({ ...files, 'docs/index.md': docs }), []);
});

test('a page in a folder without an index answers to the index above', () => {
  assert.deepEqual(check({ ...GOOD, 'docs/ref/c.md': page() }), [
    'docs/ref/c.md: not linked from docs/index.md',
  ]);
});

test('a log.md needs no index entry, at any level', () => {
  assert.deepEqual(check({ ...GOOD, 'docs/log.md': '# Log\n\n## 2026-11-01\n' }), []);
});

test('an index link to a missing page is an error', () => {
  const root = `${ROOT_INDEX}- [Gone](gone.md) — gone.\n`;
  assert.deepEqual(check({ ...GOOD, 'index.md': root }), ['index.md: links to a missing gone.md']);
});

test('a log heading must be a real date', () => {
  for (const heading of ['## November', '## 2026-13-45', '## 2026-02-30', '## 2026-11-04 ', '   ## indented', '##\ttab', '##']) {
    assert.deepEqual(check({ ...GOOD, 'docs/log.md': `# Log\n\n${heading}\n` }), [
      `docs/log.md: log heading must be a date, \`## YYYY-MM-DD\`: ${heading}`,
    ], heading);
  }
});

test('log headings inside code or comments are not checked', () => {
  const text = '# Log\n\n```md\n\n## not a date\n```\n\n<!--\n## draft\n-->\n';
  assert.deepEqual(check({ ...GOOD, 'log.md': text }), []);
});

test('Markdown files must use the .md extension', () => {
  assert.deepEqual(check({ ...GOOD, 'notes.markdown': page() }), [
    'notes.markdown: Markdown files must use the `.md` extension',
    'notes.markdown: not linked from index.md',
  ]);
});

const targets = (text: string, index = 'docs/index.md') => [...indexTargets(text, index)].sort();

test('index links: relative, ./, ../, bundle-absolute, folder, anchor, titles', () => {
  assert.deepEqual(
    targets(
      '[a](a.md#part) [b](./b.md) [b2](/docs/b2.md) [ref](ref/) [up](../x.md) [t](t.md "T") [s](s.md \'S\') [p](p.md (P)) [n](/docs/../n.md)',
    ),
    ['docs/a.md', 'docs/b.md', 'docs/b2.md', 'docs/p.md', 'docs/ref/index.md', 'docs/s.md', 'docs/t.md', 'n.md', 'x.md'],
  );
});

test('index links: angle brackets, parentheses, percent-encoding, malformed encoding', () => {
  assert.deepEqual(targets('[a](<my file.md>) [b](my%20other.md) [c](bad%zz.md) [d](d_(1).md)'), [
    'docs/bad%zz.md',
    'docs/d_(1).md',
    'docs/my file.md',
    'docs/my other.md',
  ]);
});

test('index links: reference definitions count, footnotes do not', () => {
  assert.deepEqual(targets('[a][1]\n\n[1]: a.md\n[2]: <b c.md>\n[^3]: note.md\n'), ['docs/a.md', 'docs/b c.md']);
});

test('index links: external links, non-.md files, images, code and comments do not count', () => {
  const text = [
    '[web](https://example.com/y.md)',
    '[web2](//example.com/z.md)',
    '[img](img.png)',
    '[code](../scripts/okf.ts)',
    '![pic](pic.md)',
    '`[code](code.md)`',
    '<!-- [hidden](comment.md) -->',
    '```',
    '[fenced](fenced.md)',
    '```',
    '~~~',
    '[tilde](tilde.md)',
    '~~~',
    '[real](real.md)',
  ].join('\n');
  assert.deepEqual(targets(text), ['docs/real.md']);
});

test('index links: a stray backtick or a line of inline code hides nothing past its paragraph', () => {
  assert.deepEqual(targets('- [a](a.md) uses a ` char\n\n- [b](b.md) has `code`\n'), ['docs/a.md', 'docs/b.md']);
  assert.deepEqual(targets('```x``` is inline\n\n[c](c.md)\n'), ['docs/c.md']);
});

test('index links: an unclosed fence hides the rest, a longer closing fence ends it', () => {
  assert.deepEqual(targets('```\n[x](x.md)\n'), []);
  assert.deepEqual(targets('```\n[x](x.md)\n````\n[y](y.md)\n'), ['docs/y.md']);
});

// Git and rumdl without the caller's repo location (a hook sets it) and without the user's or system config.
function cleanEnv(t: TestContext, globalConfig = '') {
  const home = mkdtempSync(join(tmpdir(), 'okf-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'gitconfig'), globalConfig);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  Object.assign(env, { GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: home, XDG_CONFIG_HOME: home });
  return { env, home };
}

function gitRepo(t: TestContext, files: Record<string, string>, env: NodeJS.ProcessEnv) {
  const root = mkdtempSync(join(tmpdir(), 'okf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  git('init', '-q');
  return { root, git };
}

// Runs `fn` with these variables in process.env: what a hook would set, or the GIT_CONFIG_* that isolate git from the user's config.
function withEnv<T>(vars: NodeJS.ProcessEnv, fn: () => T): T {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

test('repoMarkdown: tracked, untracked, any case and extension, non-ASCII; not ignored or deleted', (t) => {
  const { env } = cleanEnv(t);
  const { root, git } = gitRepo(t, {
    '.gitignore': 'ignored/\n',
    'tracked.md': '',
    'gone.md': '',
    'ignored/x.md': '',
    'code.ts': '',
  }, env);
  git('add', 'tracked.md', 'gone.md');
  rmSync(join(root, 'gone.md'));
  for (const name of ['Заметки.md', 'Notes.MD', 'a.markdown', 'b.mdx', 'c.MDX']) writeFileSync(join(root, name), '');
  assert.deepEqual(withEnv(env, () => repoMarkdown(root)), [
    'Notes.MD',
    'a.markdown',
    'b.mdx',
    'c.MDX',
    'tracked.md',
    'Заметки.md',
  ]);
});

test('repoMarkdown leaves only the root .claude/ out of the bundle', (t) => {
  const { env } = cleanEnv(t);
  const kept = ['.claude-x/d.md', '.claude.md', 'a.md', 'docs/.claude/e.md'];
  const left = ['.claude/agents/a.md', '.claude/commands/b.md', '.claude/top.md'];
  const files = Object.fromEntries([...kept, ...left].map((path) => [path, '']));
  const { root } = gitRepo(t, files, env);
  assert.deepEqual(withEnv(env, () => repoMarkdown(root)), kept);
});

test('repoMarkdown: tracked files in the root .claude/ stay out, deleted ones cause no error', (t) => {
  const { env } = cleanEnv(t);
  const { root, git } = gitRepo(t, {
    'a.md': '',
    'gone.md': '',
    'docs/.claude/keep.md': '',
    'docs/.claude/gone.md': '',
    '.claude/commands/b.md': '',
    '.claude/commands/gone.md': '',
  }, env);
  git('add', '-A');
  for (const path of ['gone.md', 'docs/.claude/gone.md', '.claude/commands/gone.md']) {
    rmSync(join(root, path));
  }
  assert.deepEqual(withEnv(env, () => repoMarkdown(root)), ['a.md', 'docs/.claude/keep.md']);
});

test('repoMarkdown ignores the user\'s global excludes file', (t) => {
  const { env, home } = cleanEnv(t);
  writeFileSync(join(home, 'excludes'), '*.md\n');
  writeFileSync(join(home, 'gitconfig'), `[core]\n\texcludesFile = ${join(home, 'excludes')}\n`);
  const { root } = gitRepo(t, { 'a.md': '' }, env);
  assert.deepEqual(withEnv(env, () => repoMarkdown(root)), ['a.md']);
});

test('repoMarkdown lists the repo in `root`, not one a hook points GIT_DIR at', (t) => {
  const { env } = cleanEnv(t);
  const { root } = gitRepo(t, { 'a.md': '' }, env);
  const decoy = gitRepo(t, { 'decoy.md': '' }, env);
  decoy.git('add', 'decoy.md');
  const hook = { ...env, GIT_DIR: join(decoy.root, '.git'), GIT_WORK_TREE: decoy.root, GIT_INDEX_FILE: join(decoy.root, '.git', 'index') };
  assert.deepEqual(withEnv(hook, () => repoMarkdown(root)), ['a.md']);
});

function cli(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' });
}

test('the CLI exits 0 on a good bundle and 1 with the errors on a broken one', (t) => {
  const { env } = cleanEnv(t);
  const { root } = gitRepo(t, GOOD, env);
  const count = Object.keys(GOOD).length;

  const ok = cli(join(SCRIPTS, 'okf-check.ts'), root, env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `okf: ${count} Markdown file(s) ok\n`);

  writeFileSync(join(root, 'a.md'), '# A\n');
  const bad = cli(join(SCRIPTS, 'okf-check.ts'), root, env);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `a.md: no YAML frontmatter block\nokf: 1 error(s) in ${count} Markdown file(s)\n`);
});

// The exit codes of the OKF, lint and format checks on a bundle, under this repo's rumdl config.
function allChecks(t: TestContext, files: Record<string, string>) {
  const { env } = cleanEnv(t);
  const { root } = gitRepo(t, { 'index.md': '---\nokf_version: "0.2"\n---\n\n# Bundle\n', ...files }, env);
  copyFileSync(join(SCRIPTS, '../.rumdl.toml'), join(root, '.rumdl.toml'));
  const rumdl = (...args: string[]) => spawnSync(RUMDL, args, { cwd: root, env, encoding: 'utf8' });
  return [cli(join(SCRIPTS, 'okf-check.ts'), root, env), rumdl('check', '.'), rumdl('fmt', '--check', '.')].map(
    (run) => run.status,
  );
}

const BROKEN = '#bad heading\n\n\n\ntext   \n';

test('a broken file in the root .claude/ passes all three checks', (t) => {
  assert.deepEqual(allChecks(t, {}), [0, 0, 0]);
  assert.deepEqual(allChecks(t, { '.claude/commands/x.md': BROKEN }), [0, 0, 0]);
});

test('a page with a `title`, its own H1 and one long line passes all three checks', (t) => {
  const index = '---\nokf_version: "0.2"\n---\n\n# Bundle\n\n- [A page](a.md) — one.\n';
  const text = `---\ntype: Guide\ntitle: A page\ndescription: One sentence.\n---\n\n# A page\n\n${'word '.repeat(40).trim()}\n\n## Part\n`;
  assert.deepEqual(allChecks(t, { 'index.md': index, 'a.md': text }), [0, 0, 0]);
});

test('a broken file in any other .claude/ fails all three checks', (t) => {
  assert.deepEqual(allChecks(t, { 'docs/.claude/x.md': BROKEN }), [1, 1, 1]);
});

test('the CLI fails outside a git repo', (t) => {
  const { env } = cleanEnv(t);
  const dir = mkdtempSync(join(tmpdir(), 'okf-nogit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = cli(join(SCRIPTS, 'okf-check.ts'), dir, { ...env, GIT_CEILING_DIRECTORIES: dirname(dir), LC_ALL: 'C' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /not a git repository/);
});
