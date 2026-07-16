import { z } from "zod";
import { EngineId } from "./ledger.ts";

/**
 * Instance registration row — the FOUNDATION identity record.
 *
 * The identity/lifecycle core of the `instances` table
 * (token-api/db_schema.py :: CREATE TABLE instances). Enums are typed faithfully to the
 * DB CHECK constraints. The golden-throne / discord / workflow / planning column families
 * are deliberately NOT modelled here — they converge in as their own seams arrive
 * (design-for-convergence; unknown columns are tolerated/stripped on parse).
 */

export const ORIGIN_TYPES = ["local", "ssh", "cron", "dispatch", "api", "perpetual"] as const;
export const COMMANDER_TYPES = ["emperor", "persona", "chapter"] as const;
export const INSTANCE_STATUSES = [
  "idle",
  "working",
  "questioning",
  "preplanning",
  "planning",
  "compacting",
  "reviewing",
  "victorious",
  "stopped",
  "archived",
] as const;
export const NOTIFICATION_MODES = ["verbose", "muted", "silent"] as const;
export const INTERACTION_MODES = ["text", "voice_chat"] as const;
const FIXED_RANKS = ["astartes", "overseer", "primarch", "retired"] as const;

export const OriginType = z.enum(ORIGIN_TYPES);
export const CommanderType = z.enum(COMMANDER_TYPES);
export const InstanceStatus = z.enum(INSTANCE_STATUSES);
export const NotificationMode = z.enum(NOTIFICATION_MODES);
export const InteractionMode = z.enum(INTERACTION_MODES);

/** rank CHECK: one of the fixed ranks OR the GLOB `aspirant:*`. */
export const RankId = z.union([z.enum(FIXED_RANKS), z.string().regex(/^aspirant:.+$/)]);
export type RankIdT = z.infer<typeof RankId>;

/** SQLite stores booleans as INTEGER 0/1 — exposed faithfully, NOT coerced to a JS boolean. */
export const Bit = z.union([z.literal(0), z.literal(1)]);
export type BitT = z.infer<typeof Bit>;

export const InstanceRegistrationRow = z
  .object({
    id: z.string(),
    name: z.string(),
    engine: EngineId,
    working_dir: z.string(),
    device_id: z.string(),
    origin_type: OriginType,
    commander_type: CommanderType,
    commander_id: z.string().nullable(),
    status: InstanceStatus,
    created_at: z.string(),
    last_activity: z.string(),
    stopped_at: z.string().nullable(),
    archived_at: z.string().nullable(),
    persona_id: z.string().nullable(),
    rank: RankId,
    session_doc_id: z.number().int().nullable(),
    continuity_binding_source: z.string().nullable(),
    // ties this registration to its wrapper-ledger occupancy row (ledger.wrapper_id).
    wrapper_launch_id: z.string().nullable(),
    automated: Bit,
    notification_mode: NotificationMode,
    interaction_mode: InteractionMode,
    is_subagent: Bit,
    hook_driven: Bit,
    stop_allowed: Bit,
  })
  // db_schema.py cross-column CHECK: commander_id IS NULL iff commander_type = 'emperor'.
  .refine(
    (r) => (r.commander_type === "emperor" ? r.commander_id === null : r.commander_id !== null),
    { message: "commander_id must be null iff commander_type is 'emperor'", path: ["commander_id"] },
  );
export type InstanceRegistrationRowT = z.infer<typeof InstanceRegistrationRow>;
