import { z } from "zod";

const EpochMilliseconds = z.string().regex(/^\d{13}$/);
const PhoneHookBase = {
  schema_version: z.literal(1),
  source: z.literal("phone.macrodroid"),
  occurred_at: EpochMilliseconds,
};
const ApplicationPayload = z.strictObject({ app: z.string().min(1).max(512) });
const PlaybackPayload = z.strictObject({
  app: z.string().min(1).max(512),
  playing: z.union([z.boolean(), z.enum(["true", "false"])]),
});

/** A passive phone observation emitted by a Fleet-managed MacroDroid macro. */
export const PhoneMacroDroidHook = z.discriminatedUnion("event_type", [
  z.strictObject({ ...PhoneHookBase, event_type: z.literal("phone.application"), payload: ApplicationPayload }),
  z.strictObject({ ...PhoneHookBase, event_type: z.literal("phone.spotify"), payload: PlaybackPayload }),
  z.strictObject({ ...PhoneHookBase, event_type: z.literal("phone.youtube"), payload: PlaybackPayload }),
]);
export type PhoneMacroDroidHookT = z.infer<typeof PhoneMacroDroidHook>;

export const PhoneMacroDroidHookRecord = z.discriminatedUnion("event_type", [
  z.strictObject({
    ...PhoneHookBase,
    hook_id: z.uuid(),
    occurred_at: z.iso.datetime({ offset: true }),
    event_type: z.literal("phone.application"),
    payload: ApplicationPayload,
  }),
  z.strictObject({
    ...PhoneHookBase,
    hook_id: z.uuid(),
    occurred_at: z.iso.datetime({ offset: true }),
    event_type: z.literal("phone.spotify"),
    payload: z.strictObject({ app: z.string().min(1).max(512), playing: z.boolean() }),
  }),
  z.strictObject({
    ...PhoneHookBase,
    hook_id: z.uuid(),
    occurred_at: z.iso.datetime({ offset: true }),
    event_type: z.literal("phone.youtube"),
    payload: z.strictObject({ app: z.string().min(1).max(512), playing: z.boolean() }),
  }),
]);
export type PhoneMacroDroidHookRecordT = z.infer<typeof PhoneMacroDroidHookRecord>;

export const PhoneMacroDroidHookReceipt = z.strictObject({
  ok: z.literal(true),
  hook_id: z.uuid(),
  recorded: z.literal(true),
});
