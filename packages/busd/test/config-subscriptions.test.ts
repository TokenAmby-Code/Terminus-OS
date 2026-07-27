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

test("the github webhook door requires the secret and the machine's App identity as a pair", () => {
  // Secret without a declared App id would be default-open across Apps — refused at boot.
  expect(() => assertConfig({
    machine: "test",
    githubWebhookSecretFile: "/run/credentials/busd.service/busd.github-webhook",
  })).toThrow(/githubWebhookAppId/);
  // An App id without the secret is an incoherent half-door — refused at boot.
  expect(() => assertConfig({
    machine: "test",
    githubWebhookAppId: 4400042,
  })).toThrow(/githubWebhookSecretFile/);
  // The App id is a numeric GitHub App id, nothing else.
  expect(() => assertConfig({
    machine: "test",
    githubWebhookSecretFile: "/run/credentials/busd.service/busd.github-webhook",
    githubWebhookAppId: 1.5,
  })).toThrow(/positive integer GitHub App id/);
  const config = assertConfig({
    machine: "test",
    githubWebhookSecretFile: "/run/credentials/busd.service/busd.github-webhook",
    githubWebhookAppId: 4400042,
  });
  expect(config.githubWebhookAppId).toBe(4400042);
});
