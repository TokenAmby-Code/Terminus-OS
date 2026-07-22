import { expect, test } from 'bun:test';
import { createClient } from '../src/client.ts';

test('client routes through configured base URL and fails loud on non-2xx', async () => {
  const seen: string[] = [];
  const client = createClient('http://127.0.0.1:7781', async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ error: 'degraded' }), { status: 503 });
  });
  await expect(client('GET', '/ctl/health')).rejects.toThrow('txd request failed (503)');
  expect(seen).toEqual(['http://127.0.0.1:7781/ctl/health']);
});
