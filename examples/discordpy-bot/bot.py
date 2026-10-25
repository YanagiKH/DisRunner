"""A small Bot with slash commands, prefix commands, a View, and a Modal."""

import os
import io

import discord
from discord import app_commands
from discord.ext import commands


class Feedback(discord.ui.Modal, title="Feedback"):
    answer = discord.ui.TextInput(label="Your answer", custom_id="answer")

    def __init__(self):
        super().__init__(custom_id="feedback")

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.send_message(f"Submitted: {self.answer.value}")


class Controls(discord.ui.View):
    @discord.ui.button(label="Confirm", custom_id="confirm", style=discord.ButtonStyle.primary)
    async def confirm(self, interaction: discord.Interaction, _button: discord.ui.Button):
        await interaction.response.edit_message(content="Button clicked.", view=None)
        self.stop()

    @discord.ui.select(
        custom_id="choice",
        options=[discord.SelectOption(label="Apple", value="apple"), discord.SelectOption(label="Banana", value="banana")],
    )
    async def choose(self, interaction: discord.Interaction, select: discord.ui.Select):
        await interaction.response.send_message(f"Selected: {', '.join(select.values)}", ephemeral=True)


class Collector(discord.ui.View):
    def __init__(self, interaction):
        super().__init__(timeout=2.0)
        self.interaction = interaction

    async def interaction_check(self, interaction):
        accepted = interaction.user.id == self.interaction.user.id
        if not accepted:
            print("Collector filtered another user.", flush=True)
        return accepted

    @discord.ui.button(label="Collect", custom_id="collector", style=discord.ButtonStyle.primary)
    async def collect(self, interaction: discord.Interaction, _button: discord.ui.Button):
        await interaction.response.edit_message(content="Collected.", view=None)
        self.stop()
        print("Collector ended: limit", flush=True)

    async def on_timeout(self):
        await self.interaction.edit_original_response(content="Collector timed out.", view=None)
        print("Collector ended: time", flush=True)


class ExampleBot(commands.Bot):
    async def setup_hook(self):
        await self.tree.sync()


intents = discord.Intents.default()
intents.members = True
intents.dm_messages = True
intents.message_content = True
bot = ExampleBot(command_prefix="!", intents=intents, chunk_guilds_at_startup=False)


@bot.event
async def on_ready():
    print(f"Cache: guilds={len(bot.guilds)} channels={sum(len(guild.channels) for guild in bot.guilds)} members={sum(len(guild.members) for guild in bot.guilds)}", flush=True)


tools = app_commands.Group(name="tools", description="Local development tools.")
math = app_commands.Group(name="math", description="Arithmetic.", parent=tools)


@math.command(name="add", description="Add two integers.")
async def add(interaction: discord.Interaction, left: int, right: int):
    await interaction.response.send_message(f"Sum: {left + right}")


bot.tree.add_command(tools)


@bot.command(name="ping")
async def prefix_ping(ctx):
    await ctx.send("Pong!")


@bot.tree.command(name="ping", description="Check the Bot connection.")
async def ping(interaction: discord.Interaction):
    await interaction.response.send_message("Pong!")


@bot.tree.command(name="echo", description="Repeat some text.")
async def echo(interaction: discord.Interaction, text: str):
    await interaction.response.send_message(text)


@bot.tree.command(name="defer", description="Edit a deferred response.")
async def deferred(interaction: discord.Interaction):
    await interaction.response.defer(ephemeral=True)
    await interaction.edit_original_response(content="Deferred reply complete.")


@bot.tree.command(name="followup", description="Send a followup message.")
async def followup(interaction: discord.Interaction):
    await interaction.response.send_message("First reply.")
    await interaction.followup.send("Followup reply.")


@bot.tree.command(name="controls", description="Show buttons and a select menu.")
async def controls(interaction: discord.Interaction):
    await interaction.response.send_message("Choose a control.", view=Controls())


@bot.tree.command(name="attachment", description="Send a local text attachment.")
async def attachment(interaction: discord.Interaction):
    await interaction.response.send_message(
        "Local attachment.",
        file=discord.File(io.BytesIO("Offline attachment ✓\n".encode("utf-8")), filename="note.txt"),
    )
    message = await interaction.original_response()
    content = await message.attachments[0].read()
    print(f"Attachment bytes: {len(content)}", flush=True)


@bot.tree.command(name="read-file", description="Read a supplied local attachment.")
async def read_file(interaction: discord.Interaction, file: discord.Attachment):
    content = await file.read()
    await interaction.response.send_message(f"Read: {content.decode('utf-8')}")


@bot.tree.command(name="collector", description="Collect one button response from the command author.")
async def collector(interaction: discord.Interaction):
    await interaction.response.send_message("Collector ready.", view=Collector(interaction))
    print("Collector listening.", flush=True)


@bot.tree.command(name="modal", description="Open a text input dialog.")
async def modal(interaction: discord.Interaction):
    await interaction.response.send_modal(Feedback())


@bot.tree.command(name="search", description="Search local choices.")
@app_commands.describe(query="Search text.")
async def search(interaction: discord.Interaction, query: str):
    await interaction.response.send_message(query)


@search.autocomplete("query")
async def search_choices(_interaction: discord.Interaction, current: str):
    return [app_commands.Choice(name=value, value=value) for value in ("apple", "banana", "cherry") if value.startswith(current)]


@bot.tree.context_menu(name="Inspect user")
async def inspect_user(interaction: discord.Interaction, user: discord.User):
    await interaction.response.send_message(f"User: {user.name}")


@bot.tree.context_menu(name="Inspect message")
async def inspect_message(interaction: discord.Interaction, message: discord.Message):
    await interaction.response.send_message(f"Message: {message.content}")


bot.run(os.environ["DISCORD_TOKEN"])
