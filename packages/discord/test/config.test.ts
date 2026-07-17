import { describe, expect, test } from "bun:test";
import { loadTenantConfig, TenantConfigError, type Env } from "../src/config.ts";

/** A fully-provisioned environment. Individual tests delete keys to exercise fail-loud paths. */
function fullEnv(overrides: Record<string, string | undefined> = {}): Env {
  return {
    TERMINUS_DISCORD_GUILD_ID: "guild-1",
    TERMINUS_DISCORD_CUSTODES_TOKEN: "custodes-token",
    TERMINUS_DISCORD_CUSTODES_APP_ID: "custodes-app",
    TERMINUS_DISCORD_GUARD_TOKEN: "guard-token",
    TERMINUS_DISCORD_GUARD_APP_ID: "guard-app",
    TERMINUS_DISCORD_VOICE_OPENAI_API_KEY: "sk-voice",
    TERMINUS_DISCORD_CHANNEL_ALERTS: "chan-alerts",
    TERMINUS_DISCORD_CHANNEL_FLEET: "chan-fleet",
    ...overrides,
  };
}

describe("env-only tenant config (foundation)", () => {
  test("resolves both identities, guild, voice credential, and routes from env alone", () => {
    const cfg = loadTenantConfig(fullEnv());
    expect(cfg.guild_id).toBe("guild-1");
    expect(cfg.identities.map((i) => i.id).sort()).toEqual(["custodes", "guard"]);
    expect(cfg.identities.find((i) => i.id === "custodes")?.token).toBe("custodes-token");
    expect(cfg.voice).toEqual({ openai_api_key: "sk-voice" });
  });

  test("the notification router discovers routes and lowercases their names", () => {
    const cfg = loadTenantConfig(fullEnv());
    expect(cfg.routes.map((r) => r.name).sort()).toEqual(["alerts", "fleet"]);
    expect(cfg.routes.find((r) => r.name === "alerts")?.channel_id).toBe("chan-alerts");
  });

  test("fail-loud: a missing token names the exact env var", () => {
    let err: unknown;
    try {
      loadTenantConfig(fullEnv({ TERMINUS_DISCORD_CUSTODES_TOKEN: undefined }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TenantConfigError);
    expect((err as TenantConfigError).problems).toContain(
      "missing env var: TERMINUS_DISCORD_CUSTODES_TOKEN",
    );
  });

  test("fail-loud is AGGREGATE: every missing var is reported in one pass", () => {
    let err: unknown;
    try {
      loadTenantConfig(
        fullEnv({
          TERMINUS_DISCORD_GUILD_ID: undefined,
          TERMINUS_DISCORD_GUARD_APP_ID: undefined,
          TERMINUS_DISCORD_VOICE_OPENAI_API_KEY: undefined,
        }),
      );
    } catch (e) {
      err = e;
    }
    const problems = (err as TenantConfigError).problems;
    expect(problems).toContain("missing env var: TERMINUS_DISCORD_GUILD_ID");
    expect(problems).toContain("missing env var: TERMINUS_DISCORD_GUARD_APP_ID");
    expect(problems).toContain("missing env var: TERMINUS_DISCORD_VOICE_OPENAI_API_KEY");
  });

  test("whitespace-only values are treated as missing (no silent empty credential)", () => {
    expect(() => loadTenantConfig(fullEnv({ TERMINUS_DISCORD_GUILD_ID: "   " }))).toThrow(
      TenantConfigError,
    );
  });

  test("zero routes is tolerated (minimal bring-up); voice stays required for Custodes", () => {
    const cfg = loadTenantConfig(
      fullEnv({ TERMINUS_DISCORD_CHANNEL_ALERTS: undefined, TERMINUS_DISCORD_CHANNEL_FLEET: undefined }),
    );
    expect(cfg.routes).toEqual([]);
    expect(cfg.voice).not.toBeNull();
  });
});
