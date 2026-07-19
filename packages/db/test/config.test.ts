import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DB_CONFIG,
  DbConfig,
  DbEndpoint,
  describeEndpoint,
  parseDbConfig,
  resolveEndpoint,
} from "../src/config.ts";
import { sqlOptions } from "../src/client.ts";

const SOCKET = {
  kind: "socket",
  socket_dir: "/var/run/postgresql",
  database: "terminus",
  application_name: "terminus-os",
} as const;

const TCP = {
  kind: "tcp",
  host: "127.0.0.1",
  database: "postgres",
  username: "postgres",
  application_name: "terminus-os-ci",
} as const;

describe("db endpoint config (foundation)", () => {
  test("canonical defaults carry both earmarks and parse clean", () => {
    expect(DbConfig.parse(DEFAULT_DB_CONFIG)).toEqual(DEFAULT_DB_CONFIG);
    expect(DEFAULT_DB_CONFIG.remote.kind).toBe("socket");
    expect(DEFAULT_DB_CONFIG.local.kind).toBe("socket");
  });

  test("earmark resolution returns the matching endpoint", () => {
    const config = parseDbConfig({ remote: SOCKET, local: TCP });
    expect(resolveEndpoint(config, "remote").kind).toBe("socket");
    expect(resolveEndpoint(config, "local").kind).toBe("tcp");
  });

  test("port defaults to 5432 on both endpoint kinds", () => {
    expect(DbEndpoint.parse(SOCKET).port).toBe(5432);
    expect(DbEndpoint.parse(TCP).port).toBe(5432);
  });

  test("peer auth is the contract: a password field is rejected outright", () => {
    expect(() => DbEndpoint.parse({ ...SOCKET, password: "hunter2" })).toThrow();
    expect(() => DbEndpoint.parse({ ...TCP, password: "hunter2" })).toThrow();
  });

  test("socket endpoints carry no username (peer auth resolves the OS user)", () => {
    expect(() => DbEndpoint.parse({ ...SOCKET, username: "postgres" })).toThrow();
  });

  test("tcp endpoints require an explicit username", () => {
    const { username: _username, ...anonymous } = TCP;
    expect(() => DbEndpoint.parse(anonymous)).toThrow();
  });

  test("unknown endpoint kinds are rejected", () => {
    expect(() => DbEndpoint.parse({ ...SOCKET, kind: "url" })).toThrow();
  });

  test("describeEndpoint names the socket file and database", () => {
    const endpoint = DbEndpoint.parse(SOCKET);
    expect(describeEndpoint(endpoint)).toBe(
      "socket /var/run/postgresql/.s.PGSQL.5432 db=terminus",
    );
  });
});

describe("sql options translation", () => {
  test("socket endpoint maps to a path with no hostname or username", () => {
    const options = sqlOptions(DbEndpoint.parse(SOCKET));
    expect(options).toMatchObject({
      adapter: "postgres",
      path: "/var/run/postgresql",
      database: "terminus",
      port: 5432,
    });
    expect("hostname" in options).toBe(false);
    expect("username" in options).toBe(false);
    expect("password" in options).toBe(false);
  });

  test("tcp endpoint maps to hostname + username, still no password", () => {
    const options = sqlOptions(DbEndpoint.parse(TCP));
    expect(options).toMatchObject({
      adapter: "postgres",
      hostname: "127.0.0.1",
      username: "postgres",
      database: "postgres",
    });
    expect("path" in options).toBe(false);
    expect("password" in options).toBe(false);
  });

  test("application_name rides the connection runtime config", () => {
    const options = sqlOptions(DbEndpoint.parse(SOCKET));
    expect(options.connection).toEqual({ application_name: "terminus-os" });
  });
});
