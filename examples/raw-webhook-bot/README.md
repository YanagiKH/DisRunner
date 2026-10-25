# Raw webhook bot example

This example is a real local HTTP interaction endpoint. It never connects to Discord. It verifies requests with the same Ed25519 `timestamp + raw body` signature shape used by Discord, then authenticates each accepted response back to DisRunner with a separate per-run HMAC secret.

Open this example folder as a DisRunner project and start the Bot. Its commands register with the local simulator and appear in Command Explorer. The example uses plain Node.js and needs no Discord SDK or production token.

## Try the commands

| Command                            | Result                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `/ping`                            | `Pong! Offline and deterministic.`                                           |
| `/secret`                          | A private response visible to the invoking user.                             |
| `/echo text`                       | The supplied text, including Unicode.                                        |
| `/tools math add left right`       | The sum of two integers.                                                     |
| `/defer` or `/slow`                | A private deferred response completed by editing the original.               |
| `/followup`                        | An initial response and a separate followup message.                         |
| `/controls`                        | A button that updates its message and a select menu with a private response. |
| `/modal`                           | A text input dialog that replies on submission.                              |
| `/search query`                    | Autocomplete choices from a local list.                                      |
| `/attachment`                      | A small text file uploaded to and verified through the local simulator.      |
| `Inspect user` / `Inspect message` | Context commands that reply with the selected target.                        |

This is an HTTP interaction example. Gateway events, prefix commands and SDK collectors are demonstrated by the separate SDK examples.

## Run it

Provide a 32-byte Ed25519 public key and a separate 32-byte peer secret as 64 hexadecimal characters. The server refuses to start when offline mode or either value is missing or malformed. DisRunner generates both values for each run; the commands below are only for manual testing.

```powershell
$env:DISRUNNER_OFFLINE = '1'
$env:DISRUNNER_PUBLIC_KEY = '<64-hex-character-public-key>'
$env:DISRUNNER_WEBHOOK_PEER_SECRET = '<64-hex-character-random-peer-secret>'
pnpm --filter @disrunner/example-raw-webhook-bot start
```

The default endpoint is `http://127.0.0.1:39001/interactions`; only IPv4/IPv6 loopback binding is accepted. `GET /health` is intentionally unsigned and reports diagnostics only—it is not proof that the listener is the supervised bot. `src/signed-client.mjs` exports `sendSignedInteraction` for test clients that own the matching private key and peer secret; it verifies response authentication before parsing JSON and defaults to a 3-second timeout plus a 1 MiB response cap. The project configuration uses self-contained fixtures under `fixtures/`, so strict project-root validation does not need a repository escape.

When DisRunner supplies `DISCORD_API_BASE_URL` and its synthetic `DISCORD_TOKEN`, the Bot registers its commands after opening the interaction endpoint. Startup completes after registration. Deferred edits, followups and attachments use that same local API, with bounded retries and timeouts. Manual testing without these variables can exercise signed immediate callbacks; deferred completion requires the simulator API.

## Security and resource limits

Defaults are deliberately fail-closed:

- request signatures may be at most 5 minutes old and 30 seconds in the future;
- a valid signature can be accepted only once during the replay window;
- accepted responses carry `x-disrunner-webhook-response-auth`, an HMAC-SHA-256 over a versioned domain, request timestamp, HTTP status, request digest, and exact response digest;
- the response secret is generated per run, injected through a protected supervisor field, redacted from captured output, and cannot be supplied through project configuration;
- `Content-Length` is required and bodies are capped at 1 MiB;
- incomplete bodies time out after 5 seconds;
- the process accepts at most 32 concurrent connections and 100 requests per socket;
- headers are capped at 16 KiB and responses disable caching.
- REST calls and attachment downloads accept only the injected IPv4 loopback simulator and never follow redirects.

The limits can be reduced with `DISRUNNER_MAX_BODY_BYTES`, `DISRUNNER_REQUEST_TIMEOUT_MS`, `DISRUNNER_MAX_SIGNATURE_AGE_MS`, `DISRUNNER_MAX_FUTURE_SKEW_MS`, `DISRUNNER_MAX_REPLAY_ENTRIES`, `DISRUNNER_MAX_CONNECTIONS`, `DISRUNNER_MAX_REQUESTS_PER_SOCKET`, and `DISRUNNER_MAX_HEADER_BYTES`.

## Verify it

```powershell
pnpm --filter @disrunner/example-raw-webhook-bot test
```

The suite opens real loopback servers and covers a mutually authenticated interaction; missing/malformed peer secrets; missing, wrong, or body-mismatched response authentication; bounded/timeout client responses; invalid/missing/expired/replayed request signatures, including hex-case replay variants; oversized or lengthless bodies; incomplete-body timeout; connection limits; and REST endpoint/token validation.

From the repository root, build the shared runtime and run the full raw Bot workflow:

```sh
pnpm run build:runtime
node --test tests/conformance/raw-session.test.mjs
```

These tests start the real Bot process, read its registered commands, exercise its interactions and asynchronous responses, verify a local attachment download, and check that modified or missing handler replies fail the same scenario.
