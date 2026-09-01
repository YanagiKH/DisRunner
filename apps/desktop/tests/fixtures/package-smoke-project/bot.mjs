import { createHash, createHmac, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';

const publicKeyHex = process.env.DISRUNNER_PUBLIC_KEY;
const peerSecretHex = process.env.DISRUNNER_WEBHOOK_PEER_SECRET;
const port = Number(process.env.DISRUNNER_BOT_PORT);
if (
  !/^[a-f\d]{64}$/iu.test(publicKeyHex ?? '') ||
  !/^[a-f\d]{64}$/iu.test(peerSecretHex ?? '') ||
  !Number.isInteger(port)
) {
  throw new Error(
    'Package smoke bot requires a generated public key, peer secret, and loopback port.',
  );
}
const publicKey = createPublicKey({
  key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKeyHex, 'hex'),
  ]),
  format: 'der',
  type: 'spki',
});

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks);
    const timestamp = request.headers['x-signature-timestamp'];
    const signature = request.headers['x-signature-ed25519'];
    const valid =
      typeof timestamp === 'string' &&
      typeof signature === 'string' &&
      verify(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        publicKey,
        Buffer.from(signature, 'hex'),
      );
    const interaction = valid ? JSON.parse(body.toString('utf8')) : null;
    const validContext =
      interaction !== null &&
      typeof interaction.application_id === 'string' &&
      interaction.application_id !== interaction.id &&
      interaction.guild_id === '9001' &&
      interaction.channel_id === '9002';
    const commandName = interaction?.data?.name;
    const payload = !valid
      ? { code: 40001, message: 'Invalid request signature' }
      : interaction.type === 1
        ? { type: 1 }
        : !validContext
          ? { type: 99 }
          : commandName === 'invalid'
            ? { type: 99 }
            : { type: 4, data: { content: 'Pong from package smoke bot.' } };
    const finish = () => {
      const encoded = Buffer.from(JSON.stringify(payload));
      const status = valid ? 200 : 401;
      const headers = {
        'content-length': String(encoded.byteLength),
        'content-type': 'application/json',
      };
      if (valid) {
        headers['x-disrunner-webhook-response-auth'] = signResponseAuthentication(
          timestamp,
          status,
          body,
          encoded,
        );
      }
      response.writeHead(status, headers);
      response.end(encoded);
    };
    if (commandName === 'timeout') setTimeout(finish, 3_500);
    else finish();
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
process.stdout.write('package smoke bot started\n');

function stop() {
  server.close(() => process.exit(0));
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);

function signResponseAuthentication(timestamp, status, requestBody, responseBody) {
  const statusBytes = Buffer.allocUnsafe(2);
  statusBytes.writeUInt16BE(status);
  const message = Buffer.concat([
    Buffer.from('disrunner.webhook-response.v1\0', 'utf8'),
    Buffer.from(timestamp, 'ascii'),
    Buffer.from([0]),
    statusBytes,
    createHash('sha256').update(requestBody).digest(),
    createHash('sha256').update(responseBody).digest(),
  ]);
  return createHmac('sha256', Buffer.from(peerSecretHex, 'hex')).update(message).digest('hex');
}
