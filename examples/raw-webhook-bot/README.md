# Raw webhook bot example

This example is a real local HTTP interaction endpoint. It never connects to Discord. It verifies requests with the same Ed25519 `timestamp + raw body` signature shape used by Discord, then authenticates each accepted response back to DisRunner with a separate per-run HMAC secret.

## Run it

Provide a 32-byte Ed25519 public key and a separate 32-byte peer secret as 64 hexadecimal characters. The server refuses to start when offline mode or either value is missing or malformed. Electron generates both values for each run; the commands below are only for manual testing.

```powershell
$env:DISRUNNER_OFFLINE = '1'
$env:DISRUNNER_PUBLIC_KEY = '<64-hex-character-public-key>'
$env:DISRUNNER_WEBHOOK_PEER_SECRET = '<64-hex-character-random-peer-secret>'
pnpm --filter @disrunner/example-raw-webhook-bot start
```

The default endpoint is `http://127.0.0.1:39001/interactions`; only IPv4/IPv6 loopback binding is accepted. `GET /health` is intentionally unsigned and reports diagnostics only—it is not proof that the listener is the supervised bot. `src/signed-client.mjs` exports `sendSignedInteraction` for test clients that own the matching private key and peer secret; it verifies response authentication before parsing JSON. The project configuration uses self-contained fixtures under `fixtures/`, so strict project-root validation does not need a repository escape.

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

The limits can be reduced with `DISRUNNER_MAX_BODY_BYTES`, `DISRUNNER_REQUEST_TIMEOUT_MS`, `DISRUNNER_MAX_SIGNATURE_AGE_MS`, `DISRUNNER_MAX_FUTURE_SKEW_MS`, `DISRUNNER_MAX_REPLAY_ENTRIES`, `DISRUNNER_MAX_CONNECTIONS`, `DISRUNNER_MAX_REQUESTS_PER_SOCKET`, and `DISRUNNER_MAX_HEADER_BYTES`.

## Verify it

```powershell
pnpm --filter @disrunner/example-raw-webhook-bot test
```

The suite opens real loopback servers and covers a mutually authenticated interaction; missing/malformed peer secrets; missing, wrong, or body-mismatched response authentication; invalid/missing/expired/replayed request signatures; oversized or lengthless bodies; incomplete-body timeout; and connection limits. The desktop runtime suite uses the same fixed canonical vector, while the packaged smoke bot also proves that unauthenticated and wrong-key command responses are rejected before callback validation.
