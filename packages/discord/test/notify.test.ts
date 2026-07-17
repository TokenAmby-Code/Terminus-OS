import { describe, expect, test } from "bun:test";
import { resolveRoute, senders, UnknownRouteError } from "../src/notify.ts";
import type { ChannelRouteT, ResolvedIdentityT } from "../src/config.ts";

const routes: ChannelRouteT[] = [
  { name: "alerts", channel_id: "chan-alerts" },
  { name: "fleet", channel_id: "chan-fleet" },
];

const identities: ResolvedIdentityT[] = [
  { id: "custodes", capabilities: ["listen", "send", "voice-rx"], token: "t", application_id: "a" },
  { id: "guard", capabilities: ["listen"], token: "t", application_id: "a" },
];

describe("notification router sink (foundation)", () => {
  test("resolves a logical route to a channel id, case-insensitively", () => {
    expect(resolveRoute(routes, "alerts")).toBe("chan-alerts");
    expect(resolveRoute(routes, "  ALERTS ")).toBe("chan-alerts");
  });

  test("an unknown route fails loud and lists the known routes — never a silent drop", () => {
    let err: unknown;
    try {
      resolveRoute(routes, "nope");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnknownRouteError);
    expect([...(err as UnknownRouteError).known].sort()).toEqual(["alerts", "fleet"]);
  });

  test("senders are exactly the send-capable identities", () => {
    expect(senders(identities).map((i) => i.id)).toEqual(["custodes"]);
  });
});
