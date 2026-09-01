import { createServer } from 'node:http';

const port = Number(process.env.DISRUNNER_BOT_PORT);
if (!Number.isInteger(port)) throw new Error('Forged-peer smoke bot requires a loopback port.');

const server = createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    const encoded = Buffer.from(JSON.stringify({ type: 1 }));
    response.writeHead(200, {
      'content-length': String(encoded.byteLength),
      'content-type': 'application/json',
      'x-disrunner-webhook-response-auth': '00'.repeat(32),
    });
    response.end(encoded);
  });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
process.stdout.write('forged-peer smoke bot started\n');

function stop() {
  server.close(() => process.exit(0));
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
