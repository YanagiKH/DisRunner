import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';

export interface ChildTrace {
  event: string;
  pid: number;
  port?: number;
  restPort?: number;
  gatewayPort?: number;
  authenticatedResponse?: boolean;
}

export async function assertChildCleanup(records: ChildTrace[]): Promise<void> {
  const launches = records.filter((record) => record.event === 'launch');
  assert.ok(launches.length > 0, 'The real Bot must have launched.');
  const pids = new Set<number>();
  const ports = new Set<number>();
  for (const launch of launches) {
    assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
    pids.add(launch.pid);
    const listeners = [launch.port, launch.restPort, launch.gatewayPort];
    assert.equal(new Set(listeners).size, 3, 'Bot, REST and Gateway use distinct ports.');
    for (const port of listeners) {
      assert.ok(typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535);
      ports.add(port);
    }
    assert.ok(
      records.some(
        (record) =>
          record.event === 'listening' && record.pid === launch.pid && record.port === launch.port,
      ),
    );
  }
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        reject(new Error(`Owned port ${port} still accepts connections.`));
      });
      socket.once('error', (error) => {
        socket.destroy();
        if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve();
        else reject(error);
      });
      socket.setTimeout(500, () => {
        socket.destroy();
        reject(new Error(`Owned port ${port} closure was not established.`));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    });
  }
  console.info(
    'CLI_CHILD_CLEANUP_EVIDENCE ' +
      JSON.stringify({
        platform: process.platform,
        pids: [...pids],
        ports: [...ports],
        allPidsDead: true,
        allPortsClosedAndReusable: true,
      }),
  );
}
