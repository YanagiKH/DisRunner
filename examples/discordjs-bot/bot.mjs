import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  MessagePayload,
  Partials,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

client.once('clientReady', async () => {
  await client.application.commands.set([
    { name: 'ping', description: 'Check the Bot connection.' },
    {
      name: 'tools',
      description: 'Local development tools.',
      options: [
        {
          type: 2,
          name: 'math',
          description: 'Arithmetic.',
          options: [
            {
              type: 1,
              name: 'add',
              description: 'Add two integers.',
              options: [
                { type: 4, name: 'left', description: 'Left number.', required: true },
                { type: 4, name: 'right', description: 'Right number.', required: true },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'echo',
      description: 'Repeat some text.',
      options: [{ name: 'text', description: 'Text to repeat.', type: 3, required: true }],
    },
    { name: 'defer', description: 'Edit a deferred response.' },
    { name: 'followup', description: 'Send a followup message.' },
    { name: 'controls', description: 'Show buttons and a select menu.' },
    { name: 'attachment', description: 'Send a local text attachment.' },
    {
      name: 'read-file',
      description: 'Read a supplied local attachment.',
      options: [{ type: 11, name: 'file', description: 'Text file to read.', required: true }],
    },
    { name: 'collector', description: 'Collect one button response from the command author.' },
    { name: 'modal', description: 'Open a text input dialog.' },
    {
      name: 'search',
      description: 'Search local choices.',
      options: [{ name: 'query', description: 'Search text.', type: 3, autocomplete: true }],
    },
    { name: 'Inspect user', type: 2 },
    { name: 'Inspect message', type: 3 },
  ]);
  console.log('Commands registered.');
  console.log(
    `Cache: guilds=${client.guilds.cache.size} channels=${client.channels.cache.size} members=${[...client.guilds.cache.values()].reduce((total, guild) => total + guild.members.cache.size, 0)}`,
  );
});

client.on('messageCreate', async (message) => {
  if (!message.author.bot && message.content === '!ping') await message.reply('Pong!');
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isAutocomplete()) {
    const query = interaction.options.getFocused();
    await interaction.respond(
      ['apple', 'banana', 'cherry']
        .filter((choice) => choice.startsWith(query))
        .map((choice) => ({ name: choice, value: choice })),
    );
    return;
  }
  if (interaction.isButton()) {
    if (interaction.customId === 'collector') return;
    await interaction.update({ content: 'Button clicked.', components: [] });
    return;
  }
  if (interaction.isStringSelectMenu()) {
    await interaction.reply({ content: `Selected: ${interaction.values.join(', ')}`, flags: 64 });
    return;
  }
  if (interaction.isModalSubmit()) {
    await interaction.reply(`Submitted: ${interaction.fields.getTextInputValue('answer')}`);
    return;
  }
  if (interaction.isUserContextMenuCommand()) {
    await interaction.reply(`User: ${interaction.targetUser.username}`);
    return;
  }
  if (interaction.isMessageContextMenuCommand()) {
    await interaction.reply(`Message: ${interaction.targetMessage.content}`);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  switch (interaction.commandName) {
    case 'ping':
      await interaction.reply('Pong!');
      break;
    case 'echo':
      await interaction.reply(interaction.options.getString('text', true));
      break;
    case 'tools':
      await interaction.reply(
        `Sum: ${interaction.options.getInteger('left', true) + interaction.options.getInteger('right', true)}`,
      );
      break;
    case 'defer':
      await interaction.deferReply({ flags: 64 });
      await interaction.editReply('Deferred reply complete.');
      break;
    case 'followup':
      await interaction.reply('First reply.');
      await interaction.followUp('Followup reply.');
      break;
    case 'controls':
      await interaction.reply({
        content: 'Choose a control.',
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('confirm')
              .setLabel('Confirm')
              .setStyle(ButtonStyle.Primary),
          ),
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('choice')
              .addOptions({ label: 'Apple', value: 'apple' }, { label: 'Banana', value: 'banana' }),
          ),
        ],
      });
      break;
    case 'attachment': {
      await interaction.reply({
        content: 'Local attachment.',
        files: [{ attachment: Buffer.from('Offline attachment ✓\n'), name: 'note.txt' }],
      });
      const message = await interaction.fetchReply();
      const attachment = message.attachments.first();
      const file = await MessagePayload.resolveFile({ attachment: attachment.url });
      console.log(`Attachment bytes: ${file.data.length}`);
      break;
    }
    case 'read-file': {
      const attachment = interaction.options.getAttachment('file', true);
      const file = await MessagePayload.resolveFile({ attachment: attachment.url });
      await interaction.reply(`Read: ${file.data.toString('utf8')}`);
      break;
    }
    case 'collector': {
      await interaction.reply({
        content: 'Collector ready.',
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('collector')
              .setLabel('Collect')
              .setStyle(ButtonStyle.Primary),
          ),
        ],
      });
      const message = await interaction.fetchReply();
      const collector = message.createMessageComponentCollector({
        filter: (component) => {
          const accepted = component.user.id === interaction.user.id;
          if (!accepted) console.log('Collector filtered another user.');
          return accepted;
        },
        time: 2_000,
        max: 1,
      });
      collector.on('collect', (component) => {
        void component
          .update({ content: 'Collected.', components: [] })
          .catch((error) => client.emit('error', error));
      });
      collector.on('end', (_collected, reason) => {
        if (reason === 'time') {
          void interaction
            .editReply({ content: 'Collector timed out.', components: [] })
            .catch((error) => client.emit('error', error));
        }
        console.log(`Collector ended: ${reason}`);
      });
      console.log('Collector listening.');
      break;
    }
    case 'modal':
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId('feedback')
          .setTitle('Feedback')
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId('answer')
                .setLabel('Your answer')
                .setStyle(TextInputStyle.Short),
            ),
          ),
      );
      break;
  }
});

await client.login(process.env.DISCORD_TOKEN);
