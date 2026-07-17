import { z } from "zod";
import { Capability, hasVoice, type CapabilityT } from "./capability.ts";
import { DEFAULT_IDENTITY_DECLARATIONS, IdentityId } from "./identity.ts";

/**
 * Tenant configuration is ENV-ONLY. Credentials never live in the checkout, never in a
 * Keychain, never inline in source — the launchd/Keychain/inline-OpenAI-secret assumptions
 * the old Mac daemon carried are all replaced by a single contract: the process environment
 * (populated on k12 from the systemd EnvironmentFile that Token-Fleet provisions).
 *
 * The loader is FAIL-LOUD and AGGREGATE: it collects every missing/invalid variable and
 * throws once, naming each one, so a mis-provisioned host reports the whole gap in one pass
 * instead of the "fix one var, restart, discover the next" treadmill.
 */

/** Environment variable names are all under one prefix so the host contract is greppable. */
export const ENV_PREFIX = "TERMINUS_DISCORD_";
export const GUILD_ID_ENV = `${ENV_PREFIX}GUILD_ID`;
/** Deliberate replacement of the old daemon's inline OpenAI key: env-sourced, gated on voice. */
export const VOICE_OPENAI_KEY_ENV = `${ENV_PREFIX}VOICE_OPENAI_API_KEY`;
/** `TERMINUS_DISCORD_CHANNEL_<NAME>=<channel id>` declares one notification-router route. */
export const CHANNEL_ENV_PREFIX = `${ENV_PREFIX}CHANNEL_`;

export type Env = Readonly<Record<string, string | undefined>>;

export class TenantConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Terminus Discord tenant configuration is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "TenantConfigError";
  }
}

// ---------- resolved shapes ----------

/** A resolved route: logical name → Discord channel id. Channel ids are env-sourced, not baked. */
export const ChannelRoute = z.object({
  name: z.string().min(1),
  channel_id: z.string().min(1),
});
export type ChannelRouteT = z.infer<typeof ChannelRoute>;

/**
 * A resolved identity: the declared capability policy plus the credentials read from the
 * environment. `token` is an in-memory secret — present at runtime, never serialised to source.
 */
export const ResolvedIdentity = z.object({
  id: IdentityId,
  capabilities: z.array(Capability),
  token: z.string().min(1),
  application_id: z.string().min(1),
});
export type ResolvedIdentityT = z.infer<typeof ResolvedIdentity>;

export const VoiceCredentials = z.object({ openai_api_key: z.string().min(1) });
export type VoiceCredentialsT = z.infer<typeof VoiceCredentials>;

/**
 * The fully resolved tenant configuration. `voice` is null iff no identity is granted a voice
 * capability — the OpenAI credential is required exactly when it is actually reachable.
 */
export const TenantConfig = z.object({
  guild_id: z.string().min(1),
  identities: z.array(ResolvedIdentity).min(1),
  routes: z.array(ChannelRoute),
  voice: VoiceCredentials.nullable(),
});
export type TenantConfigT = z.infer<typeof TenantConfig>;

// ---------- loader ----------

/**
 * Resolve the tenant configuration from an environment. Pure over its `env` argument (defaults
 * to `process.env`) so it is fully testable. Throws {@link TenantConfigError} listing every
 * missing or empty variable; returns a parsed {@link TenantConfigT} on success.
 */
export function loadTenantConfig(env: Env = process.env): TenantConfigT {
  const problems: string[] = [];

  const req = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`missing env var: ${name}`);
      return "";
    }
    return value;
  };

  const guild_id = req(GUILD_ID_ENV);

  const identities = Object.values(DEFAULT_IDENTITY_DECLARATIONS).map((decl) => ({
    id: decl.id,
    capabilities: [...decl.capabilities] as CapabilityT[],
    token: req(decl.token_env),
    application_id: req(decl.application_id_env),
  }));

  const voiceGranted = identities.some((i) => hasVoice(i.capabilities));
  const voice = voiceGranted ? { openai_api_key: req(VOICE_OPENAI_KEY_ENV) } : null;

  // The notification router discovers its routes from the environment: any TERMINUS_DISCORD_
  // CHANNEL_<NAME> pair is a route. Zero routes is tolerated (a minimal voice-only bring-up);
  // an unknown route fails loud at resolve time (../notify.ts).
  const routes: ChannelRouteT[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(CHANNEL_ENV_PREFIX)) continue;
    const channel_id = env[key]?.trim();
    if (!channel_id) continue;
    routes.push({ name: key.slice(CHANNEL_ENV_PREFIX.length).toLowerCase(), channel_id });
  }

  if (problems.length > 0) throw new TenantConfigError(problems);

  return TenantConfig.parse({ guild_id, identities, routes, voice });
}
