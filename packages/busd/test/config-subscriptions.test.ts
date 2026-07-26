import { expect, test } from "bun:test";
import { assertConfig } from "../src/config.ts";

test("machine configuration declares strict, uniquely named durable subscriptions", () => {
  const config = assertConfig({
    machine: "test",
    subscriptions: [{
      name: "githubd-github",
      delivery_url: "http+unix://%2Frun%2Fgithubd%2Fghd.sock/event",
      event_pattern: "github.%",
      active: true,
      seed: "beginning",
    }],
  });
  expect(config.subscriptions).toEqual([{
    name: "githubd-github",
    delivery_url: "http+unix://%2Frun%2Fgithubd%2Fghd.sock/event",
    event_pattern: "github.%",
    active: true,
    seed: "beginning",
  }]);
  expect(() => assertConfig({
    machine: "test",
    subscriptions: [
      ...config.subscriptions,
      { ...config.subscriptions[0]!, seed: "now" },
    ],
  })).toThrow(/duplicate subscription/);
  expect(() => assertConfig({
    machine: "test",
    subscriptions: [{ ...config.subscriptions[0]!, seed: "later" as "now" }],
  })).toThrow(/invalid seed/);
});
