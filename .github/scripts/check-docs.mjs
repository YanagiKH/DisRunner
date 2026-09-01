import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const root = process.cwd();
const required = [
  '.github/BRANCH_PROTECTION.md',
  'README.md',
  'ROADMAP.md',
  'COMPATIBILITY.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'docs/installation.md',
  'docs/getting-started.md',
  'docs/architecture.md',
  'docs/ui-tour.md',
  'docs/offline-mode.md',
  'docs/debugging.md',
  'docs/troubleshooting.md',
  'docs/release-process.md',
  'docs/examples/discord-extensions-release-mirror.yml',
  'docs/schemas/discord-simulator.config.schema.json',
  'docs/schemas/discord-scenario.schema.json',
  'docs/assets/disrunner-logo.png',
  'docs/assets/disrunner-readme-cover.jpg',
  'docs/assets/screenshots/simulator.jpg',
  'examples/raw-webhook-bot/discord-simulator.config.json',
  'scenarios/interaction-lifecycle.discord-scenario.yml',
];

const failures = [];

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && ['.git', 'node_modules', 'dist', 'release'].includes(entry.name)) {
      return [];
    }
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function hasExactCase(path) {
  const relativePath = relative(root, path);
  let cursor = root;
  for (const part of relativePath.split(sep)) {
    if (!readdirSync(cursor).includes(part)) return false;
    cursor = resolve(cursor, part);
  }
  return true;
}

for (const path of required) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) failures.push(`Missing required file: ${path}`);
}

for (const jsonPath of [
  'docs/schemas/discord-simulator.config.schema.json',
  'docs/schemas/discord-scenario.schema.json',
  'examples/raw-webhook-bot/discord-simulator.config.json',
]) {
  try {
    JSON.parse(readFileSync(resolve(root, jsonPath), 'utf8'));
  } catch (error) {
    failures.push(`Invalid JSON: ${jsonPath} (${error instanceof Error ? error.message : error})`);
  }
}

const markdownFiles = walk(root).filter(
  (path) => path.endsWith('.md') && !path.includes(`${sep}node_modules${sep}`),
);
const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

for (const file of markdownFiles) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+["']/)[0];
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    const decoded = decodeURIComponent(target.split('#')[0]);
    if (!decoded) continue;
    const absolute = resolve(dirname(file), decoded);
    const display = `${relative(root, file)} -> ${target}`;
    if (!absolute.startsWith(`${root}${sep}`) && absolute !== root) {
      failures.push(`Local link escapes repository: ${display}`);
    } else if (!existsSync(absolute)) {
      failures.push(`Broken local link: ${display}`);
    } else if (!hasExactCase(absolute)) {
      failures.push(`Case-mismatched local link: ${display}`);
    }
  }
}

for (const [imagePath, expectedSignature] of [
  ['docs/assets/disrunner-logo.png', 'png'],
  ['docs/assets/disrunner-readme-cover.jpg', 'jpeg'],
  ['docs/assets/screenshots/simulator.jpg', 'jpeg'],
]) {
  const absolute = resolve(root, imagePath);
  if (!existsSync(absolute)) continue;
  if (statSync(absolute).size < 100) {
    failures.push(`Image appears to be a placeholder: ${imagePath}`);
    continue;
  }
  const signature = readFileSync(absolute).subarray(0, 8).toString('hex');
  if (expectedSignature === 'png' && signature !== '89504e470d0a1a0a') {
    failures.push(`Invalid PNG signature: ${imagePath}`);
  }
  if (expectedSignature === 'jpeg' && !signature.startsWith('ffd8ff')) {
    failures.push(`Invalid JPEG signature: ${imagePath}`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Documentation check passed (${markdownFiles.length} Markdown files).`);
