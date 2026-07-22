import type { DesktopTelemetryEventT } from "@terminus-os/contracts";
import { connectDb, MIGRATIONS_DIR, runMigrations, type DbEndpointT } from "@terminus-os/db";
import type { SQL } from "bun";


export interface TelemetryStore {
  record(event: DesktopTelemetryEventT): Promise<boolean>;
  close(): Promise<void>;
}

export class PostgresTelemetryStore implements TelemetryStore {
  private constructor(private readonly sql: SQL) {}

  static async connect(endpoint: DbEndpointT): Promise<PostgresTelemetryStore> {
    const sql = await connectDb(endpoint);
    await runMigrations(sql, MIGRATIONS_DIR);
    return new PostgresTelemetryStore(sql);
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

  async close(): Promise<void> {
    await this.sql.close();
  }
}
