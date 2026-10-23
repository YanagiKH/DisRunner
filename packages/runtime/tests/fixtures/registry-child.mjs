// Copied beside the unmodified raw example. Readiness still uses its Ed25519 and peer-HMAC gates.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createWebhookServer, loadServerOptionsFromEnvironment } from './server.mjs';
const options = loadServerOptionsFromEnvironment();
const server = createWebhookServer(options);
const handlers = server.listeners('request');
server.removeAllListeners('request');
const mac = (body) => createHmac('sha256', options.peerSecretHex).update(body).digest('hex');
async function rest(path, method = 'GET', body, credential = 'bot') {
  const base = new URL(process.env.DISCORD_API_BASE_URL);
  const authorization =
    credential === 'bot'
      ? `Bot ${process.env.DISRUNNER_FAKE_TOKEN}`
      : credential === 'bearer'
        ? `Bearer ${process.env.DISRUNNER_FAKE_TOKEN}`
        : credential === 'missing'
          ? undefined
          : credential;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: base.hostname,
        port: base.port,
        path: `${base.pathname.replace(/\/$/, '')}${path}`,
        method,
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 262144) req.destroy(Error('Bound exceeded'));
          else chunks.push(chunk);
        });
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            body: bytes.length ? JSON.parse(bytes.toString()) : null,
            bytes: bytes.length,
            revision: res.headers['x-disrunner-state-revision'] ?? null,
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(Error('REST timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
server.on('request', async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/registry-test') {
    for (const handler of handlers) handler.call(server, req, res);
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) {
      res.writeHead(413);
      res.end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const supplied = String(req.headers['x-test-auth'] ?? '');
  if (
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(mac(body)))
  ) {
    res.writeHead(401);
    res.end();
    return;
  }
  try {
    const input = JSON.parse(body.toString());
    const app = await rest('/oauth2/applications/@me');
    const result = await rest(
      input.path.replaceAll('{app}', app.body.id),
      input.method,
      input.body,
      input.credential,
    );
    const output = Buffer.from(
      JSON.stringify({
        nonce: input.nonce,
        app,
        result,
        claimedSuccess: input.faulty === true || result.status < 300,
      }),
    );
    res.writeHead(200, { 'content-type': 'application/json', 'x-test-auth': mac(output) });
    res.end(output);
  } catch {
    res.writeHead(500);
    res.end();
  }
});
server.listen(options.port, options.host);
const shutdown = () => {
  server.close();
  server.closeAllConnections();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
