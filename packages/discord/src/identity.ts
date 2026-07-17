import { z } from "zod";
import { CapabilityGrant, type CapabilityT } from "./capability.ts";

/**
 * The tenant runs exactly two identities: Custodes and Imperial Guard. Each REUSES its
 * existing Discord application/token, repointed at this Terminus-OS tenant — the recon's
 * ruling was reuse-not-recreate for the two that already ride.
 *
 * Mechanicus is deliberately ABSENT. It requires a SEPARATE least-privilege application with
 * explicit capability declarations (the skill), which does not exist yet. Modelling it here
 * would resurrect the name-based listener/self-test coupling the recon told us to leave
 * behind on cutover, so it is reserved-but-unprovisioned, not a tenant identity.
 */
export const TENANT_IDENTITIES = ["custodes", "guard"] as const;
export const IdentityId = z.enum(TENANT_IDENTITIES);
export type IdentityIdT = z.infer<typeof IdentityId>;

/** Reserved names that are NOT tenant identities: their clean applications do not exist yet. */
export const RESERVED_IDENTITIES = ["mechanicus"] as const;

/**
 * A pure identity DECLARATION. It carries the capability policy plus the NAMES of the
 * environment variables that hold the bot token and application id — never the values. A
 * declaration holds no secret and no Discord id, so it is safe in source and reviewable in
 * a diff (the skill: no tokens in the checkout, no hardcoded application ids).
 */
export const IdentityDeclaration = z.object({
  id: IdentityId,
  capabilities: CapabilityGrant,
  token_env: z.string().min(1),
  application_id_env: z.string().min(1),
});
export type IdentityDeclarationT = z.infer<typeof IdentityDeclaration>;

/**
 * The source-of-truth capability policy. Capabilities live here (reviewable in source), NOT
 * inferred from the id and NOT read from the environment — only the credentials are env-sourced.
 *
 * The split below is the tenant's opening posture: Custodes is the operator-facing bot (voice
 * headline + notification router + slash commands); Imperial Guard is a conservative
 * notification-router participant (text only) until a wider grant is explicitly declared.
 * A change to a bot's authority is a one-line diff to this table, reviewed like any other.
 */
export const DEFAULT_IDENTITY_DECLARATIONS = {
  custodes: {
    id: "custodes",
    capabilities: ["listen", "send", "slash", "voice-rx", "voice-tx"],
    token_env: "TERMINUS_DISCORD_CUSTODES_TOKEN",
    application_id_env: "TERMINUS_DISCORD_CUSTODES_APP_ID",
  },
  guard: {
    id: "guard",
    capabilities: ["listen", "send"],
    token_env: "TERMINUS_DISCORD_GUARD_TOKEN",
    application_id_env: "TERMINUS_DISCORD_GUARD_APP_ID",
  },
} satisfies Record<IdentityIdT, { readonly id: IdentityIdT; readonly capabilities: readonly CapabilityT[]; readonly token_env: string; readonly application_id_env: string }>;
