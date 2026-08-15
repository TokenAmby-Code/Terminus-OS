import { z } from "zod";

const EpochMilliseconds = z.string().regex(/^\d{13}$/);
const HookTimestamp = z.union([EpochMilliseconds, z.iso.datetime({ offset: true })]);
const PhoneHookBase = {
  schema_version: z.literal(1),
  source: z.literal("phone.macrodroid"),
  occurred_at: HookTimestamp,
};
const Label = z.string().min(1).max(512);
const ApplicationPayload = z.union([z.strictObject({ app: Label }), z.strictObject({ event: Label })]);
const EventPayload = z.strictObject({ event: Label });
const ProbePayload = z.strictObject({ probe: Label });
const PlaybackPayload = z.strictObject({
  app: Label,
  playing: z.union([z.boolean(), z.enum(["true", "false", "True", "False"])]),
});

/** A passive phone observation emitted by a Fleet-managed MacroDroid macro. */
export const PhoneMacroDroidHook = z.discriminatedUnion("event_type", [
  z.strictObject({ ...PhoneHookBase, event_type: z.literal("phone.application"), payload: ApplicationPayload }),
  z.strictObject({ ...PhoneHookBase, event_type: z.literal("phone.spotify"), payload: PlaybackPayload }),
  z.strictObject({ ...PhoneHookBase, event_type: z.literal("phone.youtube"), payload: PlaybackPayload }),
  z.strictObject({ ...PhoneHookBase, event_type: z.literal("phone.geofence"), payload: EventPayload }),
  z.strictObject({ ...PhoneHookBase, event_type: z.literal("phone.proxy_egress_macro_probe"), payload: ProbePayload }),
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
    payload: z.strictObject({ app: Label, playing: z.boolean() }),
  }),
  z.strictObject({
    ...PhoneHookBase,
    hook_id: z.uuid(),
    occurred_at: z.iso.datetime({ offset: true }),
    event_type: z.literal("phone.youtube"),
    payload: z.strictObject({ app: Label, playing: z.boolean() }),
  }),
  z.strictObject({
    ...PhoneHookBase,
    hook_id: z.uuid(),
    occurred_at: z.iso.datetime({ offset: true }),
    event_type: z.literal("phone.geofence"),
    payload: EventPayload,
  }),
  z.strictObject({
    ...PhoneHookBase,
    hook_id: z.uuid(),
    occurred_at: z.iso.datetime({ offset: true }),
    event_type: z.literal("phone.proxy_egress_macro_probe"),
    payload: ProbePayload,
  }),
]);
export type PhoneMacroDroidHookRecordT = z.infer<typeof PhoneMacroDroidHookRecord>;

export const PhoneMacroDroidHookReceipt = z.strictObject({
  ok: z.literal(true),
  hook_id: z.uuid(),
  recorded: z.literal(true),
});
