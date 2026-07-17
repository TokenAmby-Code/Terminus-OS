import { describe, expect, test } from "bun:test";
import { planSummary, preflight } from "../src/main.ts";
import { createGateway, GatewayAdapterMissing } from "../src/gateway.ts";
import { TenantConfigError, type Env } from "../src/config.ts";

function fullEnv(overrides: Record<string, string | undefined> = {}): Env {
  return {
    TERMINUS_DISCORD_GUILD_ID: "guild-1",
    TERMINUS_DISCORD_CUSTODES_TOKEN: "custodes-secret-token",
    TERMINUS_DISCORD_CUSTODES_APP_ID: "custodes-app",
    TERMINUS_DISCORD_GUARD_TOKEN: "guard-secret-token",
    TERMINUS_DISCORD_GUARD_APP_ID: "guard-app",
    TERMINUS_DISCORD_VOICE_OPENAI_API_KEY: "sk-secret",
    TERMINUS_DISCORD_CHANNEL_ALERTS: "chan-alerts",
    ...overrides,
  };
}

describe("tenant entrypoint (foundation)", () => {
  test("preflight resolves a full plan from env alone", () => {
    const plan = preflight(fullEnv());
    expect(plan.identities.map((i) => i.id).sort()).toEqual(["custodes", "guard"]);
    expect(plan.voice).not.toBeNull();
  });

  test("preflight fails loud on a mis-provisioned host", () => {
    expect(() => preflight(fullEnv({ TERMINUS_DISCORD_CUSTODES_TOKEN: undefined }))).toThrow(
      TenantConfigError,
    );
  });

  test("the service-log summary never leaks a token", () => {
    const summary = planSummary(preflight(fullEnv()));
    expect(summary).not.toContain("custodes-secret-token");
    expect(summary).not.toContain("sk-secret");
    expect(summary).toContain("custodes[");
  });

  test("the gateway seam fails loud until the discord.js adapter lands", () => {
    expect(() => createGateway()).toThrow(GatewayAdapterMissing);
  });
});
