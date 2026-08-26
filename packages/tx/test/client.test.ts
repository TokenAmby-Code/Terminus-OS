import { expect, test } from 'bun:test';
import { createClient } from '../src/client.ts';

test('client routes through configured base URL and fails loud on non-2xx', async () => {
  const seen: string[] = [];
  const client = createClient('http://127.0.0.1:7781', async (input) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ error: 'degraded' }), { status: 503 });
  });
  await expect(client('GET', '/health')).rejects.toThrow('txd request failed (503)');
  expect(seen).toEqual(['http://127.0.0.1:7781/health']);
});

test('sensitive requests never serialize an upstream response body', async () => {
  const secret = 'echoed-clipboard-secret';
  const client = createClient('http://127.0.0.1:7781', async () =>
    new Response(JSON.stringify({ error: 'proxy_failure', echoed: secret }), { status: 502 }));
  let message = '';
  try {
    await client('POST', '/ctl/clipboard/pull', { content: secret }, { sensitive: true });
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain('sensitive request failed (502)');
  expect(message).not.toContain(secret);
  expect(message).not.toContain('proxy_failure');
});

test('successful and error responses are cancelled beyond a caller cap', async () => {
  const oversized = JSON.stringify({ content_base64: 'A'.repeat(100) });
  const client = createClient('http://127.0.0.1:7781', async () =>
    new Response(oversized, { status: 200 }));
  await expect(client('POST', '/ctl/clipboard/push', {}, {
    sensitive: true,
    maxResponseBytes: 32,
  })).rejects.toThrow('sensitive request failed (200)');

  const secret = 'oversized-sensitive-secret';
  const errorClient = createClient('http://127.0.0.1:7781', async () =>
    new Response(secret.repeat(20), { status: 502 }));
  let message = '';
  try {
    await errorClient('POST', '/ctl/clipboard/pull', {}, {
      sensitive: true,
      maxResponseBytes: 32,
    });
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain('sensitive request failed (502)');
  expect(message).not.toContain(secret);
});
