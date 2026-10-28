'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Bot example. */

const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('clientReady', async () => {
  await client.application.commands.set([
    { name: 'ping', description: 'Check the Bot connection.' },
  ]);
});
client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
    await interaction.reply('Pong!');
  }
});
if (require.main === module) void client.login(process.env.DISCORD_TOKEN);
