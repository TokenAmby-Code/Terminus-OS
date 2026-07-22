import { z } from "zod";


export const DesktopActivity = z.enum(["silence", "music", "video", "gaming", "meeting"]);
export type DesktopActivityT = z.infer<typeof DesktopActivity>;

export const DesktopApplication = z.enum(["none", "spotify", "brave", "steam", "zoom"]);
export type DesktopApplicationT = z.infer<typeof DesktopApplication>;

/** A dumb observation from the operator's Windows desktop. Policy is not input. */
export const DesktopTelemetryEvent = z.strictObject({
  schema_version: z.literal(1),
  event_id: z.uuid(),
  observed_at: z.iso.datetime({ offset: true }),
  machine: z.literal("wsl"),
  source: z.literal("windows_event"),
  activity: DesktopActivity,
  application: DesktopApplication,
  title: z.string().max(512),
  foreground: z.boolean(),
  youtube: z.boolean(),
}).superRefine((event, ctx) => {
  if (event.youtube !== (event.activity === "video" && event.application === "brave")) {
    ctx.addIssue({ code: "custom", path: ["youtube"], message: "youtube must describe a Brave video observation" });
  }
});
export type DesktopTelemetryEventT = z.infer<typeof DesktopTelemetryEvent>;

export const DesktopTelemetryReceipt = z.strictObject({
  ok: z.literal(true),
  event_id: z.uuid(),
  recorded: z.boolean(),
});
export type DesktopTelemetryReceiptT = z.infer<typeof DesktopTelemetryReceipt>;
