/**
 * `upstreamFetch` against a real local server, so what is asserted is what
 * went over the wire — and against a stubbed transport for the address-family
 * order, which a loopback server cannot show.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { EventEmitter } from 'node:events';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { upstreamFetch } from './upstream-fetch.js';

let server: Server;
let base: string;
const seen: { method?: string; headers?: IncomingMessage['headers']; body?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url === '/empty') {
        res.writeHead(204).end();
      } else if (req.url === '/stream') {
        // Two SSE events with a pause between: the caller must be able to read
        // the first before the second is written.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 50);
      } else {
        res.writeHead(201, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
        res.end(JSON.stringify({ ok: true }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => server.close());

describe('upstreamFetch', () => {
  it('sends method, headers and body, and returns status, headers and body', async () => {
    const response = await upstreamFetch(`${base}/echo`, {
      method: 'POST',
      headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('content-type')).toBe('application/json');

    const last = seen.at(-1)!;
    expect(last.method).toBe('POST');
    expect(last.body).toBe('{"model":"m"}');
    expect(last.headers?.authorization).toBe('Bearer k');
    expect(last.headers?.['content-length']).toBe(String('{"model":"m"}'.length));
  });

  /*
   * `fetch` decoded gzip for its callers; node:http would hand them the
   * compressed bytes. Asking for identity is what keeps `.json()` working.
   */
  it('asks the upstream not to compress', async () => {
    await upstreamFetch(`${base}/echo`, { headers: { 'accept-encoding': 'gzip, br' } });
    expect(seen.at(-1)!.headers?.['accept-encoding']).toBe('identity');
  });

  it('accepts a Request, as fetch does', async () => {
    const response = await upstreamFetch(new Request(`${base}/echo`, { method: 'PUT', body: 'x' }));
    expect(response.status).toBe(201);
    expect(seen.at(-1)).toMatchObject({ method: 'PUT', body: 'x' });
  });

  it('streams the body instead of buffering it', async () => {
    const response = await upstreamFetch(`${base}/stream`);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe('data: one\n\n');
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe('data: two\n\n');
  });

  it('returns no body for a 204', async () => {
    const response = await upstreamFetch(`${base}/empty`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

describe('address family', () => {
  /** A transport that fails with `code` for the families listed, else delegates. */
  function transport(failFor: Map<number, string>, families: number[]) {
    return ((url: URL, options: { family?: number }, callback: (res: IncomingMessage) => void) => {
      families.push(options.family ?? -1);
      const code = failFor.get(options.family ?? -1);
      if (code) {
        const req = new EventEmitter() as EventEmitter & { end: () => void };
        req.end = () => queueMicrotask(() => req.emit('error', Object.assign(new Error(code), { code })));
        return req;
      }
      return httpRequest(url, { ...options, family: undefined }, callback);
    }) as unknown as typeof httpRequest;
  }

  it('tries IPv4 first and stops there when it answers', async () => {
    const families: number[] = [];
    await upstreamFetch(`${base}/echo`, {}, { http: transport(new Map(), families) });
    expect(families).toEqual([4]);
  });

  it('falls back to any family only when the host has no IPv4 address', async () => {
    const families: number[] = [];
    const response = await upstreamFetch(
      `${base}/echo`,
      {},
      { http: transport(new Map([[4, 'ENOTFOUND']]), families) },
    );
    expect(response.status).toBe(201);
    expect(families).toEqual([4, 0]);
  });

  it('does not retry a connection failure as if it were a missing address', async () => {
    const families: number[] = [];
    await expect(
      upstreamFetch(`${base}/echo`, {}, { http: transport(new Map([[4, 'ECONNRESET']]), families) }),
    ).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(families).toEqual([4]);
  });
});
