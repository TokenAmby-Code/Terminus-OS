import {
  DesktopTelemetryEvent,
  DesktopTelemetryReceipt,
  PhoneMacroDroidHook,
  PhoneMacroDroidHookReceipt,
  PhoneMacroDroidHookRecord,
} from "@terminus-os/contracts";
import type { TelemetryStore } from "./store.ts";


export interface BuildInfo {
  version: string;
  git_sha: string;
  bun: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function makeServer(options: {
  store: TelemetryStore;
  build: BuildInfo;
  bind?: string;
  port?: number;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: options.bind ?? "127.0.0.1",
    port: options.port ?? 7784,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "telemetryd", build: options.build });
      }
      if (request.method === "POST" && url.pathname === "/events") {
        let input: unknown;
        try {
          input = await request.json();
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        const desktop = DesktopTelemetryEvent.safeParse(input);
        if (desktop.success) {
          const recorded = await options.store.record(desktop.data);
          return json(DesktopTelemetryReceipt.parse({ ok: true, event_id: desktop.data.event_id, recorded }));
        }
        const phone = PhoneMacroDroidHook.safeParse(input);
        if (!phone.success) return json({ ok: false, error: "invalid_telemetry" }, 400);
        const occurredAt = /^\d{13}$/.test(phone.data.occurred_at)
          ? new Date(Number(phone.data.occurred_at))
          : new Date(phone.data.occurred_at);
        if (Number.isNaN(occurredAt.getTime())) return json({ ok: false, error: "invalid_telemetry" }, 400);
        const hookId = crypto.randomUUID();
        const payload = phone.data.event_type === "phone.spotify" || phone.data.event_type === "phone.youtube"
          ? {
              ...phone.data.payload,
              playing: phone.data.payload.playing === true
                || (typeof phone.data.payload.playing === "string"
                  && phone.data.payload.playing.toLowerCase() === "true"),
            }
          : phone.data.payload;
        const record = PhoneMacroDroidHookRecord.parse({
          ...phone.data,
          hook_id: hookId,
          occurred_at: occurredAt.toISOString(),
          payload,
        });
        await options.store.recordPhoneHook(record);
        return json(PhoneMacroDroidHookReceipt.parse({ ok: true, hook_id: hookId, recorded: true }));
      }
      return json({ ok: false, error: "not_found" }, 404);
    },
  });
}
