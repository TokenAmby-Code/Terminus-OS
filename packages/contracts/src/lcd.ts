import { z } from "zod";

// Local mirror of Token-Fleet lifecycled's service-lane delivery envelope
// (shared/lifecycled/src/contracts.ts ServiceLaneDeliverySchema). lcd is the
// agent-domain authority: services consume typed lifecycle facts from its
// config-declared lanes instead of hook.% bus rows. The wrapper announcement
// arrives as fact_type `wrapper_started` with the wrapper's own envelope —
// including the proxy-minted hook_request_id — as the verbatim payload.
export const LCD_PROPAGATION_SCHEMA_VERSION = 1;

export const LCD_SERVICE_FACT_TYPES = ["wrapper_started"] as const;
export type LcdServiceFactType = (typeof LCD_SERVICE_FACT_TYPES)[number];

export const LcdServiceDeliverySchema = z.object({
  schema_version: z.literal(LCD_PROPAGATION_SCHEMA_VERSION),
  lane: z.string().min(1),
  subscriber: z.string().min(1),
  fact: z.object({
    seq: z.number().int().positive(),
    fact_type: z.enum(LCD_SERVICE_FACT_TYPES),
    payload: z.record(z.string(), z.unknown()),
    occurred_at: z.string().min(1),
    recorded_at: z.string().min(1),
  }).strict(),
}).strict();
export type LcdServiceDelivery = z.infer<typeof LcdServiceDeliverySchema>;
