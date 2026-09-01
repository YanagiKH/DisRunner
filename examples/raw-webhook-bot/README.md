# Raw webhook bot example

This example is a real local HTTP interaction endpoint. It never connects to Discord, but it verifies requests with the same Ed25519 `timestamp + raw body` signature shape used by Discord.

## Run it

Provide a 32-byte Ed25519 public key as 64 hexadecimal characters. The server refuses to start when offline mode or the key is missing.

```powershell
$env:DISRUNNER_OFFLINE = '1'
$env:DISRUNNER_PUBLIC_KEY = '<64-hex-character-public-key>'
pnpm --filter @disrunner/example-raw-webhook-bot start
```

The default endpoint is `http://127.0.0.1:39001/interactions`; only IPv4/IPv6 loopback binding is accepted. `GET /health` is unsigned and reports local readiness. `src/signed-client.mjs` exports `sendSignedInteraction` for simulator and integration-test clients that own the matching private key. The project configuration uses self-contained fixtures under `fixtures/`, so strict project-root validation does not need a repository escape.

## Security and resource limits

Defaults are deliberately fail-closed:

- request signatures may be at most 5 minutes old and 30 seconds in the future;
- a valid signature can be accepted only once during the replay window;
- `Content-Length` is required and bodies are capped at 1 MiB;
- incomplete bodies time out after 5 seconds;
- the process accepts at most 32 concurrent connections and 100 requests per socket;
- headers are capped at 16 KiB and responses disable caching.

The limits can be reduced with `DISRUNNER_MAX_BODY_BYTES`, `DISRUNNER_REQUEST_TIMEOUT_MS`, `DISRUNNER_MAX_SIGNATURE_AGE_MS`, `DISRUNNER_MAX_FUTURE_SKEW_MS`, `DISRUNNER_MAX_REPLAY_ENTRIES`, `DISRUNNER_MAX_CONNECTIONS`, `DISRUNNER_MAX_REQUESTS_PER_SOCKET`, and `DISRUNNER_MAX_HEADER_BYTES`.

## Verify it

```powershell
pnpm --filter @disrunner/example-raw-webhook-bot test
```

The suite opens a real loopback server and covers a valid signed interaction, invalid/missing/expired/replayed signatures, oversized or lengthless bodies, incomplete-body timeout, and connection limits.
