import { z } from "zod";
import { grants, type CapabilityT } from "./capability.ts";
import type { ChannelRouteT, ResolvedIdentityT } from "./config.ts";

/**
 * The text-channel NOTIFICATION ROUTER — the device-agnostic sink.
 *
 * A notification is addressed to a LOGICAL route name ("alerts", "fleet"), never a device and
 * never a raw channel id. The same logical send resolves the same way from any device, because
 * the route table is the single source of truth and there is no per-device branch anywhere in
 * the path. This is the whole point: an agent on the phone and an agent on k12 hit `alerts`
 * identically.
 *
 * Delivery is fail-loud: an unknown route throws (a dropped notification is a bug, never a
 * silent no-op — recon §10), and a route with no send-capable identity is a construction error
 * surfaced at bootstrap (../service.ts), not at 3am.
 */

export const NotificationRoute = z.object({ name: z.string().min(1), channel_id: z.string().min(1) });
export type NotificationRouteT = z.infer<typeof NotificationRoute>;

export class UnknownRouteError extends Error {
  constructor(
    public readonly route: string,
    public readonly known: readonly string[],
  ) {
    super(
      `notification route "${route}" is not declared; known routes: ${
        known.length > 0 ? known.join(", ") : "(none)"
      }`,
    );
    this.name = "UnknownRouteError";
  }
}

/**
 * Resolve a logical route name to a Discord channel id. Case-insensitive on the name (routes
 * are lowercased at load). Throws {@link UnknownRouteError} rather than guessing a target.
 */
export function resolveRoute(routes: readonly ChannelRouteT[], name: string): string {
  const wanted = name.trim().toLowerCase();
  const match = routes.find((r) => r.name === wanted);
  if (!match) throw new UnknownRouteError(wanted, routes.map((r) => r.name));
  return match.channel_id;
}

/** The identities that may drive the router: those declared with the `send` capability. */
export function senders(identities: readonly ResolvedIdentityT[]): ResolvedIdentityT[] {
  return identities.filter((i) => grants(i.capabilities as CapabilityT[], "send"));
}
