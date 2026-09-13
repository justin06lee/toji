// An HTTP proxy that records every host a browser contacts. It tunnels CONNECT
// (TLS) and forwards plain HTTP, logging "<ms> <METHOD> <host:port> <path?>" per
// request. Used to prove a clean Toji profile talks to no Mozilla services
// beyond the intended ones (gecko/test/phase1.ts).

import { connect, createServer, type Socket } from 'node:net';

export type Hit = { at: number; method: string; host: string; path: string };

export function startProxy(port: number, onHit: (hit: Hit) => void) {
  const start = Date.now();
  const server = createServer((client: Socket) => {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      const lines = head.subarray(0, end).toString().split('\r\n');
      const [method, target] = lines[0].split(' ');
      if (method === 'CONNECT') {
        const [host, p] = target.split(':');
        onHit({ at: Date.now() - start, method, host, path: '' });
        const upstream = connect(Number(p) || 443, host, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const rest = head.subarray(end + 4);
          if (rest.length) upstream.write(rest);
          client.pipe(upstream).pipe(client);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        return;
      }
      let url: URL;
      try {
        url = new URL(target);
      } catch {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      onHit({ at: Date.now() - start, method, host: url.hostname, path: url.pathname });
      const upstream = connect(Number(url.port) || 80, url.hostname, () => {
        const rewritten = [`${method} ${url.pathname}${url.search} HTTP/1.1`, ...lines.slice(1).filter((l) => !/^proxy-/i.test(l))];
        upstream.write(rewritten.join('\r\n') + '\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  server.listen(port, '127.0.0.1');
  return server;
}
