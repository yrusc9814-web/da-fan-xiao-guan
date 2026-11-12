import { createServer } from 'node:net';
export async function assertPortAvailable(host, port) {
  if (host !== '127.0.0.1') throw new Error('loopback required');
  await new Promise((accept, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen({ host, port: Number(port), exclusive: true }, () => socket.close(accept));
  });
}
