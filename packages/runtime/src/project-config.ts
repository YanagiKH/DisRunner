import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { GatewayIntents, parseCommandRegistryProfile } from '@disrunner/core';
import type { CommandRegistryProfile, OrdinaryMessagePermissionProfile } from '@disrunner/core';

import { openWorkspace } from './workspace.js';
import type { ProjectSummary } from './contracts.js';

const CONFIG_NAME = 'discord-simulator.config.json';
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_FIXTURE_BYTES = 8 * 1_048_576;
// BotRunner's 256-entry envelope also includes up to four managed port/signing entries.
const MAX_PROJECT_ENVIRONMENT_VARIABLES = 252;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EXECUTION_CONTROL_ENVIRONMENT =
  /^(?:PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.+)$/iu;
const SUPPORTED_ADAPTERS = ['raw-interaction-webhook', 'discord.js', 'discord.py'];

interface ResolvedAdapter {
  readonly type: string;
  readonly interactionEndpoint?: string;
  readonly restBaseUrl?: string;
  readonly gatewayUrl?: string;
}

interface ResolvedProfile {
  readonly commandRegistry?: CommandRegistryProfile;
  readonly ordinaryMessagePermissions: OrdinaryMessagePermissionProfile;
  readonly mode: 'strict' | 'lenient';
  readonly seed: number;
  readonly intents: readonly string[];
  readonly networkPolicy: 'offline';
  readonly hotReload: boolean;
}

export interface ResolvedProjectConfiguration {
  readonly entryPoint: string | null;
  readonly workspaceIssue?: string;
  readonly botUserId?: string;
  readonly summary: ProjectSummary;
  readonly environment: Readonly<Record<string, string>>;
  readonly adapter: ResolvedAdapter;
  readonly profile: ResolvedProfile;
  readonly resources: readonly Readonly<Record<string, unknown>>[];
}

export async function loadProjectConfiguration(
  selectedDirectory: string,
  options: { allowInvalidWorkspace?: boolean } = {},
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
  if (!SUPPORTED_ADAPTERS.includes(adapterType)) {
    throw new TypeError(
      `Unsupported adapter.type: ${adapterType}. Supported adapters: ${SUPPORTED_ADAPTERS.join(', ')}.`,
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
  if (adapterType === 'raw-interaction-webhook' && adapter.interactionEndpoint === undefined) {
    throw new TypeError('adapter.interactionEndpoint is required for raw-interaction-webhook.');
  }

  if (
    (adapterType === 'discord.js' && runtime !== 'node') ||
    (adapterType === 'discord.py' && runtime !== 'python')
  )
    throw new TypeError('The SDK adapter must match bot.runtime.');
  if (adapterType !== 'raw-interaction-webhook' && adapter.interactionEndpoint !== undefined)
    throw new TypeError(
      'SDK adapters use Gateway interactions and cannot set interactionEndpoint.',
    );

  const environmentRaw =
    config['environment'] === undefined ? {} : requireRecord(config['environment'], 'environment');
  if (Object.keys(environmentRaw).length > MAX_PROJECT_ENVIRONMENT_VARIABLES)
    throw new TypeError(
      'environment cannot contain more than 252 variables; four slots are reserved for runtime settings.',
    );
  const environment: Record<string, string> = {};
  let environmentBytes = 0;
  for (const [name, value] of Object.entries(environmentRaw)) {
    if (!ENVIRONMENT_NAME.test(name) || Buffer.byteLength(name) > 256)
      throw new TypeError(`Invalid environment variable name: ${name}.`);
    if (EXECUTION_CONTROL_ENVIRONMENT.test(name)) {
      throw new TypeError(`environment.${name} may not alter executable or module resolution.`);
    }
    environment[name] = requireString(value, `environment.${name}`, 32_768, true);
    const valueBytes = Buffer.byteLength(environment[name]);
    if (valueBytes > 65_536)
      throw new TypeError(`environment.${name} cannot exceed 65,536 UTF-8 bytes.`);
    environmentBytes += Buffer.byteLength(name) + valueBytes;
    if (environmentBytes > 1_048_576)
      throw new TypeError('environment cannot exceed 1,048,576 total UTF-8 bytes.');
    if (looksLikeDiscordCredential(environment[name])) {
      throw new TypeError(
        `environment.${name} looks like a Discord credential and is not allowed offline.`,
      );
    }
  }

  const profileRaw = requireRecord(config['profile'], 'profile');
  assertKeys(
    profileRaw,
    [
      'mode',
      'seed',
      'intents',
      'networkPolicy',
      'hotReload',
      'ordinaryMessagePermissions',
      'commandRegistry',
    ],
    'profile',
  );
  let commandRegistry: CommandRegistryProfile | undefined;
  if (Object.hasOwn(profileRaw, 'commandRegistry')) {
    try {
      commandRegistry = parseCommandRegistryProfile(profileRaw['commandRegistry']);
    } catch {
      throw new TypeError(
        'profile.commandRegistry must be a command-registry-v1 descriptor with unique canonical guildIds (maximum 128).',
      );
    }
  }
  const ordinaryMessagePermissions =
    profileRaw['ordinaryMessagePermissions'] === undefined
      ? adapterType === 'raw-interaction-webhook'
        ? 'legacy-unenforced'
        : 'guild-text-own-messages-v1'
      : requireEnum(
          profileRaw['ordinaryMessagePermissions'],
          ['legacy-unenforced', 'guild-text-own-messages-v1'] as const,
          'profile.ordinaryMessagePermissions',
        );
  const mode = requireEnum(profileRaw['mode'], ['strict', 'lenient'] as const, 'profile.mode');
  const seed = profileRaw['seed'];
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new TypeError('profile.seed must be an integer from 0 through 4294967295.');
  }
  if (profileRaw['networkPolicy'] !== 'offline') {
    throw new TypeError('profile.networkPolicy must be offline.');
  }
  const intents = optionalStringArray(profileRaw['intents'], 'profile.intents');
  if (intents.some((name) => !Object.hasOwn(GatewayIntents, name)))
    throw new TypeError('profile.intents contains an unsupported intent name.');
  if (new Set(intents).size !== intents.length)
    throw new TypeError('profile.intents must be unique.');
  const hotReload = profileRaw['hotReload'] ?? false;
  if (typeof hotReload !== 'boolean') throw new TypeError('profile.hotReload must be a boolean.');
  if (hotReload)
    throw new TypeError(
      'profile.hotReload is not supported. Stop and restart the bot after changes.',
    );

  const fixtureResources = await loadFixtures(
    root,
    config['fixtures'],
    ordinaryMessagePermissions,
    adapterType !== 'raw-interaction-webhook',
  );
  const workspace = await openWorkspace(root);
  if (
    !options.allowInvalidWorkspace &&
    (workspace.status === 'future' || workspace.status === 'corrupt')
  )
    throw new TypeError(workspace.error ?? 'Workspace cannot be read.');
  const resources = workspace.document?.resources ?? fixtureResources;
  if (commandRegistry !== undefined) {
    const guildIds = new Set(
      resources
        .filter((resource) => resource['resourceType'] === 'guild')
        .map((resource) => resource['id']),
    );
    if (commandRegistry.guildIds.some((id) => !guildIds.has(id))) {
      throw new TypeError('profile.commandRegistry.guildIds must reference loaded guild fixtures.');
    }
  }
  const botUserId =
    ordinaryMessagePermissions === 'guild-text-own-messages-v1' ||
    adapterType !== 'raw-interaction-webhook'
      ? (resources.find((r) => r['resourceType'] === 'user' && r['bot'] === true)?.['id'] as
          string | undefined)
      : undefined;
  return {
    entryPoint,
    ...(workspace.status === 'corrupt' || workspace.status === 'future'
      ? { workspaceIssue: workspace.error ?? 'Workspace cannot be read.' }
      : {}),
    ...(botUserId === undefined ? {} : { botUserId }),
    summary: {
      root,
      configPath,
      botName,
      executable,
      args,
      cwd,
      adapter: adapterType,
      mode: workspace.document?.options.mode ?? mode,
      seed: workspace.document?.options.seed ?? seed,
      environmentNames: Object.keys(environment).sort(),
    },
    environment,
    adapter,
    profile: {
      ...(commandRegistry === undefined ? {} : { commandRegistry }),
      mode: workspace.document?.options.mode ?? mode,
      seed: workspace.document?.options.seed ?? seed,
      intents,
      networkPolicy: 'offline',
      hotReload,
      ordinaryMessagePermissions,
    },
    resources,
  };
}

async function loadFixtures(
  root: string,
  input: unknown,
  profile: OrdinaryMessagePermissionProfile,
  structured = false,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const strict = profile === 'guild-text-own-messages-v1';
  if (input === undefined && !strict) return [];
  const fixtures = requireRecord(input, 'fixtures');
  assertKeys(fixtures, ['guild', 'user', 'bot'], 'fixtures');
  if (strict && !structured && fixtures['bot'] === undefined)
    throw new TypeError('fixtures.bot is required for guild-text-own-messages-v1.');
  if (!strict && !structured && fixtures['bot'] !== undefined)
    throw new TypeError('fixtures.bot requires guild-text-own-messages-v1.');
  const resources: Readonly<Record<string, unknown>>[] = [];
  for (const kind of ['guild', 'user', 'bot'] as const) {
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
    if (kind === 'user' || kind === 'bot') {
      const user = toResource(requireRecord(fixture['user'], `${kind} fixture user`), 'user');
      if (kind === 'bot') {
        const id = user['id'];
        if (
          typeof id !== 'string' ||
          !/^[1-9][0-9]{0,19}$/.test(id) ||
          BigInt(id) > 18_446_744_073_709_551_615n
        )
          throw new TypeError(
            'bot fixture user.id must be a canonical positive decimal unsigned 64-bit string.',
          );
        if (user['bot'] !== true) throw new TypeError('bot fixture user.bot must be true.');
      }
      resources.push(user);
      continue;
    }
    const guild = requireRecord(fixture['guild'], 'guild fixture guild');
    const { roles, channels, ...legacyFields } = guild;
    const { members, ...strictFields } = legacyFields;
    const guildFields = strict || structured ? strictFields : legacyFields;
    const guildResource = toResource(guildFields, 'guild');
    resources.push(guildResource);
    for (const role of requireOptionalRecordArray(roles, 'guild fixture roles')) {
      resources.push(toResource(nestedResource(role, guildResource['id'], strict, 'role'), 'role'));
    }
    for (const channel of requireOptionalRecordArray(channels, 'guild fixture channels')) {
      resources.push(
        toResource(
          nestedResource(
            structured ? { permission_overwrites: [], ...channel } : channel,
            guildResource['id'],
            strict,
            'channel',
          ),
          'channel',
        ),
      );
    }
    if (strict || structured) {
      for (const member of requireOptionalRecordArray(members, 'guild fixture members')) {
        resources.push(
          toResource(
            nestedResource(
              structured && member['id'] === undefined
                ? {
                    ...member,
                    id:
                      member['user_id'] ??
                      (member['user'] as Record<string, unknown> | undefined)?.['id'],
                    user_id:
                      member['user_id'] ??
                      (member['user'] as Record<string, unknown> | undefined)?.['id'],
                  }
                : member,
              guildResource['id'],
              true,
              'member',
            ),
            'member',
          ),
        );
      }
    }
  }
  if (strict) {
    const keys = new Set<string>();
    for (const resource of resources) {
      const key = JSON.stringify([resource['resourceType'], resource['id']]);
      if (keys.has(key)) throw new TypeError('Duplicate fixture resource key (resourceType, id).');
      keys.add(key);
    }
  }
  return resources;
}

function nestedResource(
  value: Readonly<Record<string, unknown>>,
  guildId: unknown,
  strict: boolean,
  kind: string,
): Readonly<Record<string, unknown>> {
  if (strict && Object.hasOwn(value, 'guild_id') && value['guild_id'] !== guildId) {
    throw new TypeError(`guild fixture ${kind}.guild_id must match its parent guild id.`);
  }
  return { guild_id: guildId, ...value };
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
  if (runtime !== 'executable' && path.isAbsolute(command)) {
    const resolved = await realpath(command);
    if (!(await stat(resolved)).isFile())
      throw new TypeError('Runtime path must identify an executable file.');
    if (
      runtime === 'node'
        ? !/^node(?:\.exe)?$/u.test(base)
        : !/^(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?$/u.test(base)
    )
      throw new TypeError('Runtime path must identify the configured Node or Python executable.');
    return path.resolve(command);
  }
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
  const file = await open(filePath, 'r');
  let source: string;
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) throw new TypeError(`${label} must be a regular file.`);
    if (fileStat.size > limit) throw new TypeError(`${label} exceeds the ${limit}-byte limit.`);

    const buffer = Buffer.allocUnsafe(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > limit) throw new TypeError(`${label} exceeds the ${limit}-byte limit.`);
    source = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
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
