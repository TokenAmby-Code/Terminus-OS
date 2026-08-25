import {
  DesktopTelemetryEvent,
  DesktopTelemetryReceipt,
  PhoneMacroDroidHook,
  PhoneMacroDroidHookReceipt,
  PhoneMacroDroidHookRecord,
} from "@terminus-os/contracts";
import {
  PROBE_RUNGS,
  assertProbeSet,
  makeObservationHandler,
  type Deadline,
  type Observation,
  type ObservationStore,
  type Probe,
} from "@tokenamby-code/stc-contract/observation";
import { runningRuntimeMarker } from "@tokenamby-code/stc-contract/version";
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
  /** Every health walk is recorded durably; the store is the STC's, not ours. */
  observationStore: ObservationStore;
  build: BuildInfo;
  bind?: string;
  port?: number;
}): ReturnType<typeof Bun.serve> {
  const ingress = {
    lastAdmittedEvent: null as string | null,
    lastPersistedEvent: null as string | null,
    failedPersists: 0,
  };
  const postgresDeadline = {
    ms: 1_000,
    derivedFrom: "one cancellable read-only SELECT over telemetryd's existing PostgreSQL connection",
  } satisfies Deadline;
  const ingressDeadline = {
    ms: 1_000,
    derivedFrom: "one synchronous read of telemetryd's in-process ingress receipt counters",
  } satisfies Deadline;
  const probes: Probe[] = [
    {
      name: "postgres",
      rung: PROBE_RUNGS[0],
      deadline: postgresDeadline,
      caveats: ["non-actuating query"],
      observe: (signal) => options.store.observePostgres(signal),
    },
    {
      name: "telemetry-ingress",
      rung: PROBE_RUNGS[2],
      deadline: ingressDeadline,
      caveats: ["no synthetic event on health"],
      observe: async (): Promise<Observation> => {
        const evidence = {
          last_admitted_event: ingress.lastAdmittedEvent,
          last_persisted_event: ingress.lastPersistedEvent,
          failed_persists: ingress.failedPersists,
        };
        return ingress.failedPersists === 0
          ? { state: "ready", evidence }
          : {
              state: "failed",
              detail: `${ingress.failedPersists} admitted event persist(s) failed`,
              evidence,
            };
      },
    },
  ];
  assertProbeSet(probes);
  const observe = makeObservationHandler({
    identity: { service: "telemetryd", daemon: "telemetryd", cli: null },
    version: options.build.version,
    stcVersion: runningRuntimeMarker().version,
    machine: "k12-personal",
    probes,
    holdings: [],
    observationStore: options.observationStore,
  });

  async function persist(eventId: string, write: () => Promise<unknown>): Promise<boolean> {
    ingress.lastAdmittedEvent = eventId;
    try {
      await write();
      ingress.lastPersistedEvent = eventId;
      return true;
    } catch (error) {
      ingress.failedPersists += 1;
      console.error(JSON.stringify({
        level: "error",
        service: "telemetryd",
        event: "persist_failed",
        event_id: eventId,
        error: String(error),
      }));
      return false;
    }
  }

  return Bun.serve({
    hostname: options.bind ?? "127.0.0.1",
    port: options.port ?? 7784,
    async fetch(request) {
      const observation = await observe(request);
      if (observation) return observation;
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/events") {
        let input: unknown;
        try {
          input = await request.json();
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        const desktop = DesktopTelemetryEvent.safeParse(input);
        if (desktop.success) {
          let recorded = false;
          const persisted = await persist(desktop.data.event_id, async () => {
            recorded = await options.store.record(desktop.data);
          });
          if (!persisted) return json({ ok: false, error: "persist_failed" }, 500);
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
        if (!await persist(hookId, () => options.store.recordPhoneHook(record))) {
          return json({ ok: false, error: "persist_failed" }, 500);
        }
        return json(PhoneMacroDroidHookReceipt.parse({ ok: true, hook_id: hookId, recorded: true }));
      }
      return json({ ok: false, error: "not_found" }, 404);
    },
  });
}
