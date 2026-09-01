import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 100_000;
const MAX_DEPTH = 32;
const MAX_FILE_BYTES = 600 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const OVERLAP_CHARACTERS = 2_048;

const patterns = [
  [
    'Discord webhook',
    /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+/giu,
  ],
  ['authorization credential', /\bAuthorization\s*:\s*(?:Bot|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/giu],
  [
    'Discord token',
    /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/gu,
    isProductionShapedDiscordToken,
  ],
  [
    'secret assignment',
    /\b(?:DISCORD_TOKEN|BOT_TOKEN|API_KEY|CLIENT_SECRET|PRIVATE_KEY|PASSWORD)\s*=\s*["']?[A-Za-z0-9._~+/=-]{8,}/gu,
  ],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/gu],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/gu],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/gu],
];

const roots = process.argv.slice(2);
if (roots.length === 0) throw new Error('Provide at least one file or directory to scan.');

let fileCount = 0;
let totalBytes = 0;
let skippedSymlinkCount = 0;
const findings = [];
const scannedFiles = new Set();

for (const input of roots) {
  const requestedRoot = path.resolve(input);
  const canonicalRoot = await realpath(requestedRoot);
  await visit(canonicalRoot, canonicalRoot, 0, new Set());
}

if (findings.length > 0) {
  console.error(
    `Credential scan rejected ${findings.length} file(s). Match contents are intentionally hidden.`,
  );
  for (const finding of findings.slice(0, 50)) {
    console.error(`- ${path.relative(process.cwd(), finding.file)} [${finding.labels.join(', ')}]`);
  }
  if (findings.length > 50) console.error(`- …and ${findings.length - 50} more file(s)`);
  process.exitCode = 1;
} else {
  console.log(
    `Credential scan passed: ${fileCount} files, ${totalBytes} bytes, ${skippedSymlinkCount} internal symlinks skipped.`,
  );
}

async function visit(target, canonicalRoot, depth, visitedDirectories) {
  if (depth > MAX_DEPTH) throw new Error(`Scan depth exceeds ${MAX_DEPTH}: ${target}`);
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) {
    const canonicalTarget = await resolveLink(target);
    assertWithinRoot(canonicalRoot, canonicalTarget, target);
    skippedSymlinkCount += 1;
    return;
  }

  const canonicalTarget = await realpath(target);
  assertWithinRoot(canonicalRoot, canonicalTarget, target);
  if (metadata.isDirectory()) {
    const key = canonicalPathKey(canonicalTarget);
    if (visitedDirectories.has(key)) return;
    visitedDirectories.add(key);
    const entries = await readdir(canonicalTarget, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      await visit(
        path.join(canonicalTarget, entry.name),
        canonicalRoot,
        depth + 1,
        visitedDirectories,
      );
    }
    return;
  }
  if (!metadata.isFile()) throw new Error(`Unsupported scan input: ${canonicalTarget}`);

  const key = canonicalPathKey(canonicalTarget);
  if (scannedFiles.has(key)) return;
  scannedFiles.add(key);
  fileCount += 1;
  if (fileCount > MAX_FILES) throw new Error(`Credential scan exceeds ${MAX_FILES} files.`);
  if (metadata.size > MAX_FILE_BYTES)
    throw new Error(`Credential scan file exceeds 600 MiB: ${canonicalTarget}`);
  totalBytes += metadata.size;
  if (totalBytes > MAX_TOTAL_BYTES)
    throw new Error('Credential scan exceeds the 2 GiB total boundary.');
  const labels = await scanFile(canonicalTarget);
  if (labels.length > 0) findings.push({ file: canonicalTarget, labels });
}

async function resolveLink(link) {
  try {
    return await realpath(link);
  } catch (error) {
    throw new Error(
      `Cannot resolve symbolic link inside scan root: ${link}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function assertWithinRoot(canonicalRoot, canonicalTarget, source) {
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Symbolic link escapes canonical scan root: ${source} -> ${canonicalTarget} (root: ${canonicalRoot})`,
    );
  }
}

function canonicalPathKey(target) {
  const normalized = path.normalize(target);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function scanFile(file) {
  const labels = new Set();
  let tail = '';
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const text = tail + chunk.toString('latin1');
    for (const [label, pattern, validateCandidate] of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (!validateCandidate || validateCandidate(match[0])) {
          labels.add(label);
          break;
        }
      }
    }
    tail = text.slice(-OVERLAP_CHARACTERS);
  }
  return [...labels].sort();
}

function isProductionShapedDiscordToken(candidate) {
  if (candidate.startsWith('mfa.')) return true;

  const [snowflakeSegment, timestampSegment, signatureSegment, ...unexpected] =
    candidate.split('.');
  if (
    unexpected.length > 0 ||
    !snowflakeSegment ||
    !timestampSegment ||
    !signatureSegment ||
    signatureSegment.length < 20
  ) {
    return false;
  }

  const snowflakeBytes = Buffer.from(snowflakeSegment, 'base64url');
  const timestampBytes = Buffer.from(timestampSegment, 'base64url');
  const snowflake = snowflakeBytes.toString('ascii');

  return (
    /^[0-9]{17,20}$/u.test(snowflake) &&
    snowflakeBytes.toString('base64url') === snowflakeSegment &&
    timestampBytes.byteLength === 4 &&
    timestampBytes.toString('base64url') === timestampSegment
  );
}
