import {
  createObservationClient,
  type ObservationClient,
  type ObservationClientOptions,
  type ObservationFetch,
} from '@tokenamby-code/stc-contract/client';
import {
  HealthResponseSchema,
  InspectResponseSchema,
} from '@tokenamby-code/stc-contract/schemas';

const ClientHealthResponseSchema = HealthResponseSchema.strip();
const ClientInspectResponseSchema = InspectResponseSchema.strip();

/**
 * tx is the acceptance boundary for observation envelopes. The daemon and
 * client still take their declared shape from the same STC schemas; only the
 * root funnel mouth strips additive fields before the strict canonical client
 * validates the resulting internal value.
 */
export function createTxdObservationClient(options: ObservationClientOptions): ObservationClient {
  const upstream = options.fetch ?? (fetch as ObservationFetch);
  const funnelFetch: ObservationFetch = async (input, init) => {
    const response = await upstream(input, init);
    const operation = new URL(input instanceof Request ? input.url : input).pathname;
    const schema = operation === '/health'
      ? ClientHealthResponseSchema
      : operation === '/inspect'
        ? ClientInspectResponseSchema
        : null;
    if (!schema) return response;

    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return response;
    return new Response(JSON.stringify(parsed.data), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'content-type': 'application/json' },
    });
  };

  return createObservationClient({ ...options, fetch: funnelFetch });
}
