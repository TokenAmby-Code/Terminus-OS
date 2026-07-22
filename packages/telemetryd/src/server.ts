import { DesktopTelemetryEvent, DesktopTelemetryReceipt } from "@terminus-os/contracts";
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
        const parsed = DesktopTelemetryEvent.safeParse(input);
        if (!parsed.success) {
          return json({ ok: false, error: "invalid_desktop_telemetry" }, 400);
        }
        const recorded = await options.store.record(parsed.data);
        return json(DesktopTelemetryReceipt.parse({ ok: true, event_id: parsed.data.event_id, recorded }));
      }
      return json({ ok: false, error: "not_found" }, 404);
    },
  });
}
