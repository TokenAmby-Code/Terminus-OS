import { loadTenantConfig, type Env } from "./config.ts";
import { bootstrapTenant, startTenant, type TenantPlan } from "./service.ts";
import { createGateway } from "./gateway.ts";

/**
 * The tenant entrypoint — the systemd unit's ExecStart target (deploy/systemd/
 * terminus-discord.service). It resolves the env-only configuration, plans the tenant, and
 * connects every identity through the gateway. Everything up to the live transport is real and
 * exercised; only the discord.js adapter (./gateway.ts) is the deferred seam.
 */

/** Preflight: resolve config and plan the tenant. Fail-loud on any missing credential or route. */
export function preflight(env: Env = process.env): TenantPlan {
  return bootstrapTenant(loadTenantConfig(env));
}

/** A secret-free service-log summary. Lists identities and capabilities; NEVER a token. */
export function planSummary(plan: TenantPlan): string {
  const identities = plan.identities.map((i) => `${i.id}[${i.capabilities.join(",")}]`).join(" ");
  return `guild=${plan.guild_id} identities=${identities} routes=${plan.routes.length} voice=${
    plan.voice ? "on" : "off"
  }`;
}

if (import.meta.main) {
  const plan = preflight();
  console.log(`[terminus-discord] ${planSummary(plan)}`);
  const connections = await startTenant(plan, createGateway());
  console.log(`[terminus-discord] connected ${connections.length} identities`);
}
