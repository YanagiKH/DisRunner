import { createRequire } from 'node:module';
import path from 'node:path';
import type { ResolvedProjectConfiguration } from './project-config.js';

const require = createRequire(import.meta.url);

export function adapterCommand(configuration: ResolvedProjectConfiguration): readonly string[] {
  const args = [...configuration.summary.args];
  if (configuration.adapter.type === 'raw-interaction-webhook') return args;
  const entry = configuration.entryPoint;
  if (entry === null) throw new TypeError('An SDK project requires bot.entryPoint.');
  const index = args.indexOf(entry);
  if (index < 0) throw new TypeError('SDK entry point is missing from the start command.');
  const packageName =
    configuration.adapter.type === 'discord.js'
      ? '@disrunner/adapter-discordjs'
      : '@disrunner/adapter-discordpy';
  const bootstrap = path.join(
    path.dirname(require.resolve(packageName)),
    configuration.adapter.type === 'discord.js' ? 'bootstrap.cjs' : 'bootstrap.py',
  );
  const executableBootstrap = bootstrap.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
  args.splice(index, 0, executableBootstrap);
  return args;
}
