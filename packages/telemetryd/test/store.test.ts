import { expect, test } from "bun:test";
import type { SQL } from "bun";
import type { PhoneMacroDroidHookRecordT } from "@terminus-os/contracts";
import { PostgresTelemetryStore } from "../src/store.ts";

test("phone hook payload is bound as a jsonb object, never a JSON string", async () => {
  const bindings: unknown[] = [];
  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    bindings.push(...values);
    return Promise.resolve([]);
  }) as unknown as SQL;
  const StoreConstructor = PostgresTelemetryStore as unknown as {
    new (sql: SQL): PostgresTelemetryStore;
  };
  const store = new StoreConstructor(sql);
  const hook: PhoneMacroDroidHookRecordT = {
    schema_version: 1,
    hook_id: "390ff9d1-0335-4261-93e2-e3ffebac2fe9",
    event_type: "phone.application",
    source: "phone.macrodroid",
    payload: { app: "json-object-proof" },
    occurred_at: "2026-08-15T17:37:49.210Z",
  };

  await store.recordPhoneHook(hook);

  expect(bindings[4]).toEqual(hook.payload);
  expect(typeof bindings[4]).toBe("object");
});

test("the database rejects every future non-object phone payload", async () => {
  const migration = await Bun.file(new URL(
    "../../../migrations/0018_phone_hook_payload_object.sql",
    import.meta.url,
  )).text();

  expect(migration).toContain("CHECK (jsonb_typeof(payload) = 'object') NOT VALID");
});
