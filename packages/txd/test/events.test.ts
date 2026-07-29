import { expect, test } from 'bun:test';
import { makeBusPublisher } from '../src/events.ts';

test('physical facts publish through busd generic ingress with no hook or identity forgery', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const publish = makeBusPublisher('http://bus.test:7782/base', async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ ok: true, seq: 7, event_type: 'agent.pane_attested' });
  });
  await publish('agent.pane_attested', { hook_request_id: crypto.randomUUID() });
  expect(requests).toEqual([{
    url: 'http://bus.test:7782/ingress/events',
    body: {
      schema_version: 1,
      event_type: 'agent.pane_attested',
      source: 'txd',
      payload: { hook_request_id: expect.any(String) },
      occurred_at: expect.any(String),
    },
  }]);
});

test('bus refusal remains loud so the wrapper hook delivery is retried', async () => {
  const publish = makeBusPublisher('http://bus.test:7782', async () =>
    Response.json({ ok: false }, { status: 503 }));
  await expect(publish('agent.pane_refused', {})).rejects.toThrow('bus_publish_refused:503');
});
