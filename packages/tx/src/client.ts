export type RequestMethod = 'GET' | 'POST';
export type TxdRequest = (
  method: RequestMethod,
  path: string,
  body?: unknown,
  options?: { sensitive?: boolean },
) => Promise<unknown>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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
    const text = await response.text();
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
