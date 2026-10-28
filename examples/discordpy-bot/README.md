# Discord.py example

This example uses Python 3.12 and `discord.py` 2.6.4. It includes slash commands, prefix commands, deferred replies, followups, a View with buttons and a string select menu, autocomplete, context commands, and a Modal.

`/tools math add` demonstrates a nested command with integer options. `/attachment` sends a small local text file, and `/read-file` reads an attachment supplied to a command. `/collector` accepts one button response from the command author and closes after two seconds.

Prepare a Python environment before running offline:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r ../../packages/adapter-discordpy/requirements.txt
```

On Windows, use `.venv\Scripts\python.exe`. Set `bot.startCommand` in `discord-simulator.config.json` to the absolute path of the chosen interpreter followed by `bot.py`; quote the interpreter path if it contains spaces. Open this directory as a project in DisRunner, start the Bot, and send `/ping` or the text message `!ping`.

To use your own Bot, keep its normal `discord.Client` or `commands.Bot` startup and choose `"adapter": { "type": "discord.py" }`. Set `bot.entryPoint` to its Python entry file and select the environment containing the supported SDK. The adapter supplies a temporary local credential, routes API and Gateway traffic to the current session, and rejects external aiohttp requests while the Bot runs. It does not install Python packages during a session.

Scenario completion waits for registered event, command, View and Modal callbacks. Await the work a test must include. Detached background tasks are outside this callback completion guarantee.
