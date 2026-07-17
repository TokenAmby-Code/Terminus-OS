import { hasVoice, type CapabilityT } from "./capability.ts";
import type { ResolvedIdentityT, TenantConfigT } from "./config.ts";
import type { IdentityIdT } from "./identity.ts";
import { senders } from "./notify.ts";

/**
 * Tenant bootstrap — turns a resolved {@link TenantConfigT} into a connection plan and asserts
 * the tenant's construction invariants BEFORE any socket opens. Every failure here is a
 * config/policy contradiction that must be impossible to ship, not a runtime surprise.
 *
 * The plan is transport-agnostic. `startTenant` drives an injected {@link DiscordGateway}, so
 * the connection wiring is real and testable without pulling a live discord.js client into the
 * foundation; the discord.js adapter is the one seam left for the wave (see DiscordGateway).
 */

/** Abstract gateway features a capability requires. `send` needs none (REST channel post). */
export function requiredGatewayFeatures(caps: readonly CapabilityT[]): string[] {
  const features = new Set<string>();
  for (const cap of caps) {
    if (cap === "listen") features.add("guild-messages");
    if (cap === "slash") features.add("guild-integrations");
    if (cap === "voice-rx" || cap === "voice-tx") features.add("guild-voice");
  }
  return [...features].sort();
}

/** A per-identity connection intent. `token` is an in-memory secret; `gateway_features` are abstract. */
export interface ConnectionIntent {
  id: IdentityIdT;
  application_id: string;
  token: string;
  capabilities: CapabilityT[];
  gateway_features: string[];
}

export interface TenantPlan {
  guild_id: string;
  identities: ConnectionIntent[];
  routes: readonly { name: string; channel_id: string }[];
  voice: { openai_api_key: string } | null;
}

export class TenantBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantBootstrapError";
  }
}

export function bootstrapTenant(config: TenantConfigT): TenantPlan {
  if (config.identities.length === 0) {
    throw new TenantBootstrapError("tenant has no identities");
  }

  const voiceGranted = config.identities.some((i) => hasVoice(i.capabilities as CapabilityT[]));
  if (voiceGranted && config.voice === null) {
    throw new TenantBootstrapError(
      "a voice capability is granted but no voice credential is resolved",
    );
  }

  // A route nobody can deliver is a silent notification black hole. Refuse to boot with routes
  // declared but no send-capable identity — surface it at construction, not at 3am (recon §10).
  if (config.routes.length > 0 && senders(config.identities).length === 0) {
    throw new TenantBootstrapError(
      `${config.routes.length} notification route(s) declared but no identity has the "send" capability`,
    );
  }

  const identities = config.identities.map((identity: ResolvedIdentityT) => ({
    id: identity.id,
    application_id: identity.application_id,
    token: identity.token,
    capabilities: identity.capabilities as CapabilityT[],
    gateway_features: requiredGatewayFeatures(identity.capabilities as CapabilityT[]),
  }));

  return {
    guild_id: config.guild_id,
    identities,
    routes: config.routes,
    voice: config.voice,
  };
}

/**
 * The connection seam. The real implementation is a discord.js adapter (the wave); the
 * foundation depends only on this interface, so bootstrap and lifecycle are exercised with a
 * fake gateway and no un-runnable client code ships in the tenant.
 */
export interface GatewayConnection {
  identity: IdentityIdT;
  close(): Promise<void>;
}

export interface DiscordGateway {
  connect(intent: ConnectionIntent): Promise<GatewayConnection>;
}

/** Connect every planned identity through the injected gateway. */
export async function startTenant(
  plan: TenantPlan,
  gateway: DiscordGateway,
): Promise<GatewayConnection[]> {
  return Promise.all(plan.identities.map((intent) => gateway.connect(intent)));
}
