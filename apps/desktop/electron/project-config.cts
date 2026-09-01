import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectSummary } from './runtime-contract.cjs';

const CONFIG_NAME = 'discord-simulator.config.json';
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_FIXTURE_BYTES = 8 * 1_048_576;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EXECUTION_CONTROL_ENVIRONMENT =
  /^(?:PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+)$/iu;
const SUPPORTED_ADAPTER_TYPE = 'raw-interaction-webhook';

interface ResolvedAdapter {
  readonly type: string;
  readonly interactionEndpoint?: string;
  readonly restBaseUrl?: string;
  readonly gatewayUrl?: string;
}

interface ResolvedProfile {
  readonly mode: 'strict' | 'lenient';
  readonly seed: number;
  readonly intents: readonly string[];
  readonly networkPolicy: 'offline';
  readonly hotReload: boolean;
}

export interface ResolvedProjectConfiguration {
  readonly summary: ProjectSummary;
  readonly environment: Readonly<Record<string, string>>;
  readonly adapter: ResolvedAdapter;
  readonly profile: ResolvedProfile;
  readonly resources: readonly Readonly<Record<string, unknown>>[];
}

export async function loadProjectConfiguration(
  selectedDirectory: string,
): Promise<ResolvedProjectConfiguration> {
  if (typeof selectedDirectory !== 'string' || selectedDirectory.trim() === '') {
    throw new TypeError('A project directory is required.');
  }
  const root = await canonicalDirectory(selectedDirectory, 'Selected project');
  const configPath = await canonicalWorkspacePath(root, CONFIG_NAME, 'Project configuration');
  const raw = await readBoundedJson(configPath, MAX_CONFIG_BYTES, 'Project configuration');
  const config = requireRecord(raw, 'Project configuration');
  assertKeys(
    config,
    ['$schema', 'version', 'bot', 'adapter', 'environment', 'profile', 'fixtures'],
    'Project configuration',
  );
  if (config['version'] !== 1) throw new TypeError('Project configuration version must be 1.');
  if (config['$schema'] !== undefined) requireString(config['$schema'], '$schema', 2048);

  const bot = requireRecord(config['bot'], 'bot');
  assertKeys(bot, ['name', 'runtime', 'startCommand', 'entryPoint', 'workingDirectory'], 'bot');
  const botName = requireString(bot['name'], 'bot.name', 100);
  const runtime = requireEnum(
    bot['runtime'],
    ['node', 'python', 'executable'] as const,
    'bot.runtime',
  );
  const command = tokenizeCommand(requireString(bot['startCommand'], 'bot.startCommand', 4096));
  const workingDirectoryValue = requireString(
    bot['workingDirectory'],
    'bot.workingDirectory',
    4096,
  );
  const cwd = await canonicalWorkspaceDirectory(
    root,
    workingDirectoryValue,
    'bot.workingDirectory',
  );
  const entryPoint =
    bot['entryPoint'] === undefined
      ? null
      : await canonicalWorkspaceFile(
          root,
          requireString(bot['entryPoint'], 'bot.entryPoint', 4096),
          'bot.entryPoint',
        );
  const executable = await resolveExecutable(root, runtime, command[0] as string);
  const args = [...command.slice(1)];
  if (runtime === 'node' || runtime === 'python') {
    if (entryPoint === null) {
      throw new TypeError(`bot.entryPoint is required for the ${runtime} runtime.`);
    }
    const entryPointArgument = args.findIndex(
      (argument) => !path.isAbsolute(argument) && path.resolve(cwd, argument) === entryPoint,
    );
    if (entryPointArgument === -1) {
      throw new TypeError(
        'bot.startCommand must execute the configured bot.entryPoint from bot.workingDirectory.',
      );
    }
    args[entryPointArgument] = entryPoint;
  }
  assertNoCredentialArguments(args);

  const adapterRaw = requireRecord(config['adapter'], 'adapter');
  assertKeys(adapterRaw, ['type', 'interactionEndpoint', 'restBaseUrl', 'gatewayUrl'], 'adapter');
  const adapterType = requireString(adapterRaw['type'], 'adapter.type', 100);
  if (adapterType !== SUPPORTED_ADAPTER_TYPE) {
    throw new TypeError(
      `Unsupported adapter.type: ${adapterType}. The Desktop runtime only supports ${SUPPORTED_ADAPTER_TYPE}.`,
    );
  }
  const adapter: ResolvedAdapter = {
    type: adapterType,
    ...optionalLoopbackTemplate(
      adapterRaw['interactionEndpoint'],
      'adapter.interactionEndpoint',
      'http:',
    ),
    ...optionalLoopbackTemplate(adapterRaw['restBaseUrl'], 'adapter.restBaseUrl', 'http:'),
    ...optionalLoopbackTemplate(adapterRaw['gatewayUrl'], 'adapter.gatewayUrl', 'ws:'),
  };
  if (adapter.interactionEndpoint === undefined) {
    throw new TypeError('adapter.interactionEndpoint is required for raw-interaction-webhook.');
  }

  const environmentRaw =
    config['environment'] === undefined ? {} : requireRecord(config['environment'], 'environment');
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(environmentRaw)) {
    if (!ENVIRONMENT_NAME.test(name))
      throw new TypeError(`Invalid environment variable name: ${name}.`);
    if (EXECUTION_CONTROL_ENVIRONMENT.test(name)) {
      throw new TypeError(`environment.${name} may not alter executable or module resolution.`);
    }
    environment[name] = requireString(value, `environment.${name}`, 32_768, true);
    if (looksLikeDiscordCredential(environment[name])) {
      throw new TypeError(
        `environment.${name} looks like a Discord credential and is not allowed offline.`,
      );
    }
  }

  const profileRaw = requireRecord(config['profile'], 'profile');
  assertKeys(profileRaw, ['mode', 'seed', 'intents', 'networkPolicy', 'hotReload'], 'profile');
  const mode = requireEnum(profileRaw['mode'], ['strict', 'lenient'] as const, 'profile.mode');
  const seed = profileRaw['seed'];
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError('profile.seed must be an integer from 0 through 4294967295.');
  }
  if (profileRaw['networkPolicy'] !== 'offline') {
    throw new TypeError('profile.networkPolicy must be offline.');
  }
  const intents = optionalStringArray(profileRaw['intents'], 'profile.intents');
  if (new Set(intents).size !== intents.length)
    throw new TypeError('profile.intents must be unique.');
  const hotReload = profileRaw['hotReload'] ?? false;
  if (typeof hotReload !== 'boolean') throw new TypeError('profile.hotReload must be a boolean.');

  const resources = await loadFixtures(root, config['fixtures']);
  return {
    summary: {
      root,
      configPath,
      botName,
      executable,
      args,
      cwd,
      adapter: adapterType,
      mode,
      seed,
      environmentNames: Object.keys(environment).sort(),
    },
    environment,
    adapter,
    profile: { mode, seed, intents, networkPolicy: 'offline', hotReload },
    resources,
  };
}

async function loadFixtures(
  root: string,
  input: unknown,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  if (input === undefined) return [];
  const fixtures = requireRecord(input, 'fixtures');
  assertKeys(fixtures, ['guild', 'user'], 'fixtures');
  const resources: Readonly<Record<string, unknown>>[] = [];
  for (const kind of ['guild', 'user'] as const) {
    const configuredPath = fixtures[kind];
    if (configuredPath === undefined) continue;
    const fixturePath = await canonicalWorkspaceFile(
      root,
      requireString(configuredPath, `fixtures.${kind}`, 4096),
      `fixtures.${kind}`,
    );
    const fixture = requireRecord(
      await readBoundedJson(fixturePath, MAX_FIXTURE_BYTES, `fixtures.${kind}`),
      `fixtures.${kind}`,
    );
    if (fixture['version'] !== 1) throw new TypeError(`${kind} fixture version must be 1.`);
    if (kind === 'user') {
      resources.push(toResource(requireRecord(fixture['user'], 'user fixture user'), 'user'));
      continue;
    }
    const guild = requireRecord(fixture['guild'], 'guild fixture guild');
    const { roles, channels, ...guildFields } = guild;
    const guildResource = toResource(guildFields, 'guild');
    resources.push(guildResource);
    for (const role of requireOptionalRecordArray(roles, 'guild fixture roles')) {
      resources.push(toResource({ guild_id: guildResource['id'], ...role }, 'role'));
    }
    for (const channel of requireOptionalRecordArray(channels, 'guild fixture channels')) {
      resources.push(toResource({ guild_id: guildResource['id'], ...channel }, 'channel'));
    }
  }
  return resources;
}

function toResource(
  value: Readonly<Record<string, unknown>>,
  resourceType: string,
): Readonly<Record<string, unknown>> {
  const id = value['id'];
  if (typeof id !== 'string' || id.trim() === '')
    throw new TypeError(`${resourceType} fixture id must be a string.`);
  return { ...value, id, resourceType };
}

function requireOptionalRecordArray(
  value: unknown,
  label: string,
): readonly Readonly<Record<string, unknown>>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((entry, index) => requireRecord(entry, `${label}[${index}]`));
}

function optionalLoopbackTemplate(
  value: unknown,
  label: 'adapter.interactionEndpoint' | 'adapter.restBaseUrl' | 'adapter.gatewayUrl',
  protocol: 'http:' | 'ws:',
): Partial<ResolvedAdapter> {
  if (value === undefined) return {};
  const template = requireString(value, label, 2048);
  const rendered = template
    .replaceAll('${DISRUNNER_BOT_PORT}', '1')
    .replaceAll('${DISRUNNER_REST_PORT}', '1')
    .replaceAll('${DISRUNNER_GATEWAY_PORT}', '1');
  let parsed: URL;
  try {
    parsed = new URL(rendered);
  } catch {
    throw new TypeError(`${label} must be an absolute URL.`);
  }
  if (
    parsed.protocol !== protocol ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new TypeError(`${label} must use ${protocol}//127.0.0.1 without credentials.`);
  }
  const key = label.split('.')[1] as keyof ResolvedAdapter;
  return { [key]: template };
}

async function resolveExecutable(
  root: string,
  runtime: 'node' | 'python' | 'executable',
  command: string,
): Promise<string> {
  const base = path.basename(command).toLowerCase();
  if (runtime === 'node') {
    if ((base !== 'node' && base !== 'node.exe') || command.toLowerCase() !== base) {
      throw new TypeError(
        'A node runtime startCommand must begin with the PATH-resolved node executable name.',
      );
    }
    return command;
  }
  if (runtime === 'python') {
    if (
      !['python', 'python.exe', 'python3', 'python3.exe', 'py', 'py.exe'].includes(base) ||
      command.toLowerCase() !== base
    ) {
      throw new TypeError('A python runtime startCommand must begin with python, python3, or py.');
    }
    return command;
  }
  return canonicalWorkspaceFile(root, command, 'bot executable');
}

function assertNoCredentialArguments(args: readonly string[]): void {
  for (const argument of args) {
    if (/^--?(?:token|bot-token|password|secret|private-key|api-key)(?:=|$)/iu.test(argument)) {
      throw new TypeError('bot.startCommand cannot carry credentials in command-line arguments.');
    }
    if (looksLikeDiscordCredential(argument)) {
      throw new TypeError('bot.startCommand contains a Discord-credential-shaped argument.');
    }
  }
}

function looksLikeDiscordCredential(value: string): boolean {
  return /^(?:Bot\s+)?(?:mfa\.[A-Za-z\d_-]{20,}|[A-Za-z\d_-]{20,30}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{20,})$/u.test(
    value.trim(),
  );
}

function tokenizeCommand(command: string): readonly string[] {
  if (/[\0\r\n]/u.test(command))
    throw new TypeError('bot.startCommand cannot contain control characters.');
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] as string;
    if (quote !== null) {
      if (character === quote) quote = null;
      else if (character === '\\' && command[index + 1] === quote)
        token += command[++index] as string;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (token !== '') {
        tokens.push(token);
        token = '';
      }
    } else {
      token += character;
    }
  }
  if (quote !== null) throw new TypeError('bot.startCommand contains an unterminated quote.');
  if (token !== '') tokens.push(token);
  if (tokens.length === 0) throw new TypeError('bot.startCommand must contain an executable.');
  return tokens;
}

async function readBoundedJson(filePath: string, limit: number, label: string): Promise<unknown> {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (fileStat.size > limit) throw new TypeError(`${label} exceeds the ${limit}-byte limit.`);
  const source = await readFile(filePath, 'utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new TypeError(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function canonicalDirectory(candidate: string, label: string): Promise<string> {
  const canonical = await realpath(path.resolve(candidate));
  const candidateStat = await stat(canonical);
  if (!candidateStat.isDirectory()) throw new TypeError(`${label} must be a directory.`);
  return canonical;
}

async function canonicalWorkspaceDirectory(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  const canonical = await canonicalWorkspacePath(root, candidate, label);
  const candidateStat = await stat(canonical);
  if (!candidateStat.isDirectory()) throw new TypeError(`${label} must resolve to a directory.`);
  return canonical;
}

async function canonicalWorkspaceFile(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  const canonical = await canonicalWorkspacePath(root, candidate, label);
  const candidateStat = await stat(canonical);
  if (!candidateStat.isFile()) throw new TypeError(`${label} must resolve to a regular file.`);
  return canonical;
}

async function canonicalWorkspacePath(
  root: string,
  candidate: string,
  label: string,
): Promise<string> {
  if (candidate.includes('\0') || path.isAbsolute(candidate)) {
    throw new TypeError(`${label} must be a relative workspace path.`);
  }
  const canonical = await realpath(path.resolve(root, candidate));
  const relative = path.relative(root, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(
      `${label} resolves outside the selected project (including through a symlink).`,
    );
  }
  return canonical;
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0)
    throw new TypeError(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`);
}

function requireString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim() === '') ||
    value.length > maxLength
  ) {
    throw new TypeError(
      `${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string no longer than ${maxLength} characters.`,
    );
  }
  return value;
}

function requireEnum<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return value.map((entry, index) => requireString(entry, `${label}[${index}]`, 100));
}
