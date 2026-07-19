import { SQL } from "bun";
import { z } from "zod";
import { describeEndpoint, type DbEndpointT } from "./config.ts";

/**
 * Translate a typed endpoint into Bun.sql constructor options.
 * Socket endpoints carry no username: peer auth resolves the OS user.
 */
export function sqlOptions(endpoint: DbEndpointT): Bun.SQL.PostgresOrMySQLOptions {
  const shared = {
    adapter: "postgres",
    database: endpoint.database,
    port: endpoint.port,
    connection: { application_name: endpoint.application_name },
  } as const;
  return endpoint.kind === "socket"
    ? { ...shared, path: endpoint.socket_dir }
    : { ...shared, hostname: endpoint.host, username: endpoint.username };
}

/**
 * Open a connection, failing loud: a dead database throws here, immediately,
 * with the endpoint identity in the message. No retry loop, no fallback.
 */
export async function connectDb(endpoint: DbEndpointT): Promise<SQL> {
  const sql = new SQL(sqlOptions(endpoint));
  try {
    await sql.connect();
  } catch (err) {
    await sql.close({ timeout: 0 });
    throw new Error(
      `[terminus-db] connect failed (${describeEndpoint(endpoint)}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return sql;
}

/**
 * Pair a query with a Zod row schema so every read is parse-validated at the
 * boundary — the same discipline @terminus-os/contracts applies to payloads.
 *
 * const rows = await typedRows(sql, MyRow)`select * from t where id = ${id}`;
 */
export function typedRows<S extends z.ZodType>(sql: SQL, schema: S) {
  return async (strings: TemplateStringsArray, ...values: unknown[]): Promise<z.infer<S>[]> => {
    const rows = await sql(strings, ...values);
    return z.array(schema).parse(rows);
  };
}
