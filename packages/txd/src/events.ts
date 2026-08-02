import {
  BUS_SCHEMA_VERSION,
  BusPublishResponseSchema,
  type BusPublishRequest,
} from '@terminus-os/contracts';

type RequestFunction = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type TxdPublishedEventType =
  | 'agent.dispatch_attested'
  | 'agent.dispatch_refused'
  | 'agent.pane_attested'
  | 'agent.pane_refused'
  | 'agent.placement_attested'
  | 'agent.placement_refused'
  | 'agent.retired'
  | 'agent.unregistered_closed';

export function makeBusPublisher(
  busUrl: string,
  request: RequestFunction = fetch,
): (eventType: TxdPublishedEventType, payload: Record<string, unknown>) => Promise<void> {
  const endpoint = new URL('/ingress/events', busUrl);
  return async (eventType, payload) => {
    const body: BusPublishRequest = {
      schema_version: BUS_SCHEMA_VERSION,
      event_type: eventType,
      source: 'txd',
      payload,
      occurred_at: new Date().toISOString(),
    };
    const response = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`bus_publish_refused:${response.status}`);
    BusPublishResponseSchema.parse(await response.json());
  };
}
