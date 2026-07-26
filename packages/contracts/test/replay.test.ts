import { describe, expect, test } from "bun:test";
import {
  CanonicalRequestHashSchema,
  ReplayEventInputSchema,
  ReplayIdSchema,
} from "../src/replay.ts";

const replayId = "d9428888-122b-4c26-b269-0a3f62f4f06b";
const eventId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

describe("generic replay wire contract", () => {
  test("accepts the complete immutable event vocabulary", () => {
    expect(ReplayEventInputSchema.parse({
      replay_id: replayId,
      event_id: eventId,
      event_type: "githubd.command_accepted",
      schema_version: 1,
      source: "githubd",
      provenance: { machine: "k12-personal", ingress: "command" },
      causation_event_id: null,
      occurred_at: "2026-07-26T17:00:00.000Z",
      payload: { repository: "token-fleet" },
    })).toMatchObject({ replay_id: replayId, event_id: eventId });
  });

  test("IDs are canonical lowercase UUIDs and request hashes are SHA-256 hex", () => {
    expect(ReplayIdSchema.safeParse(replayId.toUpperCase()).success).toBe(false);
    expect(ReplayIdSchema.safeParse("not-a-uuid").success).toBe(false);
    expect(CanonicalRequestHashSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(CanonicalRequestHashSchema.safeParse("A".repeat(64)).success).toBe(false);
  });

  test("unknown wire fields and credential-shaped provenance are refused", () => {
    const base = {
      replay_id: replayId,
      event_id: eventId,
      event_type: "githubd.command_accepted",
      schema_version: 1,
      source: "githubd",
      provenance: { machine: "k12-personal", ingress: "command" },
      causation_event_id: null,
      occurred_at: "2026-07-26T17:00:00.000Z",
      payload: {},
    };
    expect(ReplayEventInputSchema.safeParse({ ...base, sequence: 4 }).success).toBe(false);
    expect(ReplayEventInputSchema.safeParse({
      ...base,
      provenance: { ...base.provenance, authorization: "Bearer secret" },
    }).success).toBe(false);
    for (const key of [
      "github_token",
      "access_token",
      "client_secret",
      "apiKey",
      "signing-key",
      "github_token_value",
      "access_token_value",
      "client_secret_value",
      "authorization_header",
      "password_value",
      "passwd",
    ]) {
      expect(ReplayEventInputSchema.safeParse({
        ...base,
        payload: { nested: { [key]: "opaque" } },
      }).success).toBe(false);
    }
    expect(ReplayEventInputSchema.safeParse({
      ...base,
      payload: { comment_author: "octocat", author: "reviewer" },
    }).success).toBe(true);
    for (const value of [
      "Bearer opaque-credential",
      "Bearer\topaque-credential",
      "-----BEGIN PRIVATE KEY-----",
      `github_pat_${"a".repeat(24)}`,
      "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value",
    ]) {
      expect(ReplayEventInputSchema.safeParse({
        ...base,
        payload: { observation: value },
      }).success).toBe(false);
    }
  });
});
