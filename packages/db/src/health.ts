import { z } from "zod";
import { connectDb } from "./client.ts";
import { describeEndpoint, type DbEndpointT } from "./config.ts";

/**
 * The seam the enforcement/notify surface consumes for loud down-detection.
 * This is a one-shot probe: no polling loop lives in this package — cadence
 * belongs to the event-driven caller.
 */
export const DbHealthReport = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("up"),
    /** PostgreSQL 18 is the fleet standard; "up" is unparseable for anything else. */
    server_version: z.string().regex(/^18\./),
    endpoint: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("wrong_version"),
    server_version: z.string().min(1),
    endpoint: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("down"),
    reason: z.string().min(1),
    endpoint: z.string().min(1),
  }),
]);
export type DbHealthReportT = z.infer<typeof DbHealthReport>;

const VersionRow = z.object({ server_version: z.string() });

export async function checkHealth(endpoint: DbEndpointT): Promise<DbHealthReportT> {
  const where = describeEndpoint(endpoint);
  let sql;
  try {
    sql = await connectDb(endpoint);
  } catch (err) {
    return DbHealthReport.parse({
      status: "down",
      reason: err instanceof Error ? err.message : String(err),
      endpoint: where,
    });
  }
  try {
    const rows = await sql`select current_setting('server_version') as server_version`;
    const { server_version } = VersionRow.parse((rows as unknown[])[0]);
    return DbHealthReport.parse(
      server_version.startsWith("18.")
        ? { status: "up", server_version, endpoint: where }
        : { status: "wrong_version", server_version, endpoint: where },
    );
  } catch (err) {
    return DbHealthReport.parse({
      status: "down",
      reason: err instanceof Error ? err.message : String(err),
      endpoint: where,
    });
  } finally {
    await sql.close();
  }
}
