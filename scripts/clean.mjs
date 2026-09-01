import { rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const targets = [
  'apps/cli/dist',
  'apps/desktop/dist',
  'apps/desktop/dist-electron',
  'apps/desktop/playwright-report',
  'apps/desktop/test-results',
  'packages/core/dist',
  'packages/core/coverage',
  'release',
];

for (const target of targets) {
  const absolute = resolve(root, target);
  const withinRoot = relative(root, absolute);
  if (withinRoot.startsWith('..') || withinRoot === '') {
    throw new Error(`Refusing to remove unsafe path: ${absolute}`);
  }
  await rm(absolute, { recursive: true, force: true });
}
