// Run from the repo root: checks the repo, prints every error and exits 1 on any.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBundle, repoMarkdown } from './okf.ts';

const root = process.cwd();
const files = repoMarkdown(root);
const errors = checkBundle(files, (path) => readFileSync(join(root, path), 'utf8'));
if (errors.length > 0) {
  console.error(errors.join('\n'));
  console.error(`okf: ${errors.length} error(s) in ${files.length} Markdown file(s)`);
  process.exitCode = 1;
} else {
  console.log(`okf: ${files.length} Markdown file(s) ok`);
}
