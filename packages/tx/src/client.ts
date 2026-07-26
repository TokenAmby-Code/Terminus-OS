export type RequestMethod = 'GET' | 'POST';
export type RequestOptions = { sensitive?: boolean; maxResponseBytes?: number };
export type TxdRequest = (
  method: RequestMethod,
  path: string,
  body?: unknown,
  options?: RequestOptions,
) => Promise<unknown>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function responseText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error('txd response exceeds configured limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error('txd response exceeds configured limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('txd returned invalid UTF-8'); }
}

export function createClient(
  baseUrl = process.env.TXD_URL ?? 'http://127.0.0.1:7781',
  fetchImpl: Fetch = fetch,
): TxdRequest {
  const base = baseUrl.replace(/\/$/, '');
  return async (method, path, body, options) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const limit = options?.maxResponseBytes ?? (8 * 1024 * 1024);
    let text: string;
    try {
      text = await responseText(response, limit);
    } catch {
      if (options?.sensitive) throw new Error(`txd sensitive request failed (${response.status})`);
      throw new Error(`txd response exceeded limit or was invalid (${response.status})`);
    }
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : null; }
    catch { throw new Error(`txd returned invalid JSON (${response.status})`); }
    if (!response.ok) {
      if (options?.sensitive) throw new Error(`txd sensitive request failed (${response.status})`);
      throw new Error(`txd request failed (${response.status}): ${JSON.stringify(parsed)}`);
    }
    return parsed;
  };
}
