# Discord.js example

This example uses Node.js 22 and `discord.js` 14.27.0. It includes slash commands, prefix commands, deferred replies, followups, buttons, a string select menu, autocomplete, context commands, and a modal.

`/tools math add` demonstrates a nested command with integer options. `/attachment` sends a small local text file, and `/read-file` reads an attachment supplied to a command. `/collector` accepts one button response from the command author and closes after two seconds.

From the DisRunner checkout, install the workspace dependencies once with `pnpm install`. Open this directory as a project in DisRunner, start the Bot, and send `/ping`. For a text message, send `!ping`.

To use your own Bot, install the supported SDK version in its project, compile TypeScript with your usual build command if needed, and point `bot.entryPoint` and `bot.startCommand` at the JavaScript entry file. Choose `"adapter": { "type": "discord.js" }`. Both ES modules and CommonJS entry files are accepted.

The adapter replaces the login credential with a temporary local credential and routes SDK REST and Gateway traffic to the current local session. It does not install dependencies while running a project. Unsupported routes return errors that can be inspected in the run output. Custom HTTP clients used by a Bot are outside this SDK transport adapter.

Scenario completion waits for registered event and collector callbacks. Use `async` functions or return native Promises for work a test must include. Custom thenables are rejected, and detached background tasks are outside this callback completion guarantee.
