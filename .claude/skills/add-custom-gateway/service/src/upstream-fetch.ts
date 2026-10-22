/**
 * `fetch` for the gateway's outbound calls, over IPv4 first.
 *
 * The gateway's upstream network is the container runtime's default network,
 * which hands out an IPv6 address behind a NAT that does not carry traffic
 * reliably. Hosts such as opencode.ai publish AAAA records, Bun's `fetch`
 * picks one of them, and the request hangs until the caller gives up or the
 * socket is reset — while the same call from the host, or over IPv4 from the
 * same container, answers in about a second. Measured on Apple `container`
 * 1.3 with Bun 1.4: IPv4 3/3, IPv6 0/1 (hung), and `dns.setDefaultResultOrder`
 * did not steer `fetch`.
 *
 * So every upstream call goes through `node:http(s)` with `family: 4`, which
 * Bun honours, and falls back to any family only when the host has no IPv4
 * address at all. The interface is `fetch`'s: callers get a `Response` whose
 * body streams, so SSE from a model still arrives incrementally.
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

type RequestFn = typeof httpRequest;

export interface UpstreamFetchDeps {
  http?: RequestFn;
  https?: RequestFn;
}

/** DNS answers meaning "this name has no address of the family asked for". */
const NO_ADDRESS_CODES = new Set(['ENOTFOUND', 'EAI_NONAME', 'EAI_ADDRFAMILY', 'ENODATA', 'EAI_NODATA']);

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

function noBody(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function send(
  url: URL,
  init: RequestInit,
  headers: Headers,
  body: Buffer | undefined,
  family: 0 | 4,
  deps: UpstreamFetchDeps,
): Promise<Response> {
  const request = url.protocol === 'https:' ? (deps.https ?? httpsRequest) : (deps.http ?? httpRequest);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method ?? 'GET',
        headers: Object.fromEntries(headers),
        family,
        signal: init.signal ?? undefined,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 502;
        resolve(
          new Response(noBody(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
            status,
            statusText: res.statusMessage,
            headers: toHeaders(res.headers),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export async function upstreamFetch(
  input: string | URL | Request,
  init: RequestInit = {},
  deps: UpstreamFetchDeps = {},
): Promise<Response> {
  // A `Request` carries its own method, headers and body; explicit `init`
  // fields win, as they do for `fetch`.
  if (input instanceof Request) {
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
    init = {
      method: input.method,
      headers: input.headers,
      signal: input.signal,
      ...(hasBody ? { body: await input.arrayBuffer() } : {}),
      ...init,
    };
    input = input.url;
  }
  const url = new URL(String(input));
  const body = init.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer());

  const headers = new Headers(init.headers);
  // `fetch` decoded compressed bodies for its callers; `node:http` does not.
  // Asking for identity keeps every caller's `.text()`/`.json()` and every
  // passed-through stream byte-for-byte what it was.
  headers.set('accept-encoding', 'identity');
  if (body) headers.set('content-length', String(body.length));
  else headers.delete('content-length');

  try {
    return await send(url, init, headers, body, 4, deps);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && NO_ADDRESS_CODES.has(code)) {
      return send(url, init, headers, body, 0, deps);
    }
    throw error;
  }
}
