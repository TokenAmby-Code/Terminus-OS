import { expect, test } from "bun:test";
import { REPLAY_SCHEMA_VERSION } from "../src/replay.ts";

test("published replay JSON Schema and OpenAPI stay pinned to the runtime contract", async () => {
  const schema = await Bun.file(new URL("../schemas/replay-event-v1.schema.json", import.meta.url)).json() as {
    properties: { schema_version: { const: number } };
    required: string[];
    $defs: { safeObject: { propertyNames: { not: { pattern: string } } } };
  };
  expect(schema.properties.schema_version.const).toBe(REPLAY_SCHEMA_VERSION);
  expect(schema.required).toEqual(expect.arrayContaining([
    "replay_id",
    "event_id",
    "sequence",
    "schema_version",
    "provenance",
    "causation_event_id",
    "occurred_at",
    "recorded_at",
    "payload",
  ]));
  for (const credentialName of [
    "github_token",
    "access_token",
    "client_secret",
    "apiKey",
    "Authorization",
    "myGithubToken",
    "github_token_value",
    "authorization_header",
  ]) {
    expect(new RegExp(schema.$defs.safeObject.propertyNames.not.pattern).test(credentialName)).toBe(true);
  }
  expect(new RegExp(schema.$defs.safeObject.propertyNames.not.pattern).test("comment_author")).toBe(false);
  expect(JSON.stringify(schema)).toContain("\\\\s+");
  const openapi = await Bun.file(new URL("../openapi/replay-v1.yaml", import.meta.url)).text();
  for (const path of ["/v1/events:", "/v1/replays/admit:", "/v1/replays/{replay_id}:", "/v1/replays/{replay_id}/events:", "/ingress/github:"]) {
    expect(openapi).toContain(path);
  }
  for (const contract of ["ReplayAdmission:", "ReplayEventInput:", "ReplayEventRecord:", "ReplayProjection:", "ReplayEventPage:", "GithubEventName:"]) {
    expect(openapi).toContain(contract);
  }
  expect(openapi).toContain('pattern: "^[0-9a-f]{8}-[0-9a-f]{4}');
  expect(openapi).toContain("requestBody:");
  expect(openapi).toContain('$ref: "../schemas/replay-event-v1.schema.json#/$defs/safeObject"');
  expect(openapi).toContain("ReplayEventBase:");
  expect(openapi).toContain("unevaluatedProperties: false");
});
