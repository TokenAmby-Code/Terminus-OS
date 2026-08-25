import type { DesktopTelemetryEventT, PhoneMacroDroidHookRecordT } from "@terminus-os/contracts";
import { connectDb, describeEndpoint, MIGRATIONS_DIR, runMigrations, type DbEndpointT } from "@terminus-os/db";
import type { Observation } from "@tokenamby-code/stc-contract/observation";
import type { SQL } from "bun";


export interface TelemetryStore {
  record(event: DesktopTelemetryEventT): Promise<boolean>;
  recordPhoneHook(hook: PhoneMacroDroidHookRecordT): Promise<void>;
  observePostgres(signal?: AbortSignal): Promise<Observation>;
  close(): Promise<void>;
}

export class PostgresTelemetryStore implements TelemetryStore {
  private constructor(
    private readonly sql: SQL,
    private readonly connectionIdentity = "injected SQL connection",
  ) {}

  static async connect(endpoint: DbEndpointT): Promise<PostgresTelemetryStore> {
    const sql = await connectDb(endpoint);
    await runMigrations(sql, MIGRATIONS_DIR);
    return new PostgresTelemetryStore(sql, describeEndpoint(endpoint));
  }

  async record(event: DesktopTelemetryEventT): Promise<boolean> {
    const payload = JSON.stringify(event);
    const rows = await this.sql`
      insert into telemetry.desktop_events
        (event_id, observed_at, machine, activity, application, payload)
      values
        (${event.event_id}, ${event.observed_at}, ${event.machine}, ${event.activity}, ${event.application}, ${payload}::jsonb)
      on conflict (event_id) do nothing
      returning event_id
    `;
    return rows.length === 1;
  }

  async recordPhoneHook(hook: PhoneMacroDroidHookRecordT): Promise<void> {
    await this.sql`
      insert into telemetry.phone_hooks
        (hook_id, occurred_at, event_type, source, payload)
      values
        (${hook.hook_id}, ${hook.occurred_at}, ${hook.event_type}, ${hook.source}, ${hook.payload})
    `;
  }

  async observePostgres(signal?: AbortSignal): Promise<Observation> {
    const query = this.sql`
      select 1 as select_1, current_setting('server_version') as server_version
    `;
    const cancel = () => {
      try {
        query.cancel();
      } catch {
        // The observation remains failed even if driver cancellation is broken.
      }
    };
    if (signal?.aborted) {
      cancel();
      return { state: "undetermined", detail: "postgres observation was cancelled before it began" };
    }
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const rows = await query as Array<{ select_1: number; server_version: string }>;
      const row = rows[0];
      if (row?.select_1 !== 1 || typeof row.server_version !== "string") {
        return {
          state: "undetermined",
          detail: "postgres returned an invalid reachability observation",
          evidence: {
            select_1: row?.select_1 ?? null,
            server_version: row?.server_version ?? null,
            connection_identity: this.connectionIdentity,
          },
        };
      }
      return {
        state: "ready",
        evidence: {
          select_1: row.select_1,
          server_version: row.server_version,
          connection_identity: this.connectionIdentity,
        },
      };
    } catch (error) {
      return {
        state: signal?.aborted ? "undetermined" : "failed",
        detail: String(error),
        evidence: {
          select_1: null,
          server_version: null,
          connection_identity: this.connectionIdentity,
        },
      };
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
