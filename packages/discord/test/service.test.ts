import { describe, expect, test } from "bun:test";
import type { TenantConfigT } from "../src/config.ts";
import {
  bootstrapTenant,
  type ConnectionIntent,
  type DiscordGateway,
  requiredGatewayFeatures,
  startTenant,
  TenantBootstrapError,
} from "../src/service.ts";

function config(overrides: Partial<TenantConfigT> = {}): TenantConfigT {
  return {
    guild_id: "guild-1",
    identities: [
      { id: "custodes", capabilities: ["listen", "send", "voice-rx", "voice-tx"], token: "c-tok", application_id: "c-app" },
      { id: "guard", capabilities: ["listen", "send"], token: "g-tok", application_id: "g-app" },
    ],
    routes: [{ name: "alerts", channel_id: "chan-alerts" }],
    voice: { openai_api_key: "sk" },
    ...overrides,
  };
}

describe("required gateway features", () => {
  test("listen→messages, slash→integrations, voice→voice; send needs no intent", () => {
    expect(requiredGatewayFeatures(["send"])).toEqual([]);
    expect(requiredGatewayFeatures(["listen"])).toEqual(["guild-messages"]);
    expect(requiredGatewayFeatures(["voice-rx", "voice-tx", "slash", "listen"])).toEqual([
      "guild-integrations",
      "guild-messages",
      "guild-voice",
    ]);
  });
});

describe("tenant bootstrap invariants (foundation)", () => {
  test("a well-formed config plans one connection intent per identity", () => {
    const plan = bootstrapTenant(config());
    expect(plan.identities.map((i) => i.id).sort()).toEqual(["custodes", "guard"]);
    const custodes = plan.identities.find((i) => i.id === "custodes") as ConnectionIntent;
    expect(custodes.gateway_features).toContain("guild-voice");
    expect(custodes.token).toBe("c-tok");
  });

  test("refuses to boot when voice is granted but no voice credential resolved", () => {
    expect(() => bootstrapTenant(config({ voice: null }))).toThrow(TenantBootstrapError);
  });

  test("refuses to boot with routes declared but no send-capable identity (recon §10)", () => {
    const noSenders = config({
      identities: [
        { id: "guard", capabilities: ["listen"], token: "g", application_id: "a" },
      ],
    });
    expect(() => bootstrapTenant(noSenders)).toThrow(/no identity has the "send" capability/);
  });

  test("no identities is a construction error", () => {
    expect(() => bootstrapTenant(config({ identities: [] }))).toThrow(TenantBootstrapError);
  });
});

describe("tenant lifecycle over an injected gateway (foundation)", () => {
  test("startTenant connects every planned identity through the gateway seam", async () => {
    const connected: string[] = [];
    const gateway: DiscordGateway = {
      connect: (intent: ConnectionIntent) =>
        Promise.resolve({
          identity: intent.id,
          close: () => Promise.resolve(),
        }),
    };
    const plan = bootstrapTenant(config());
    const conns = await startTenant(plan, gateway);
    connected.push(...conns.map((c) => c.identity));
    expect(connected.sort()).toEqual(["custodes", "guard"]);
  });
});
