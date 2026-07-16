import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ErrorBody, ErrorEnvelope, envelope, okEnvelope } from "../src/envelope.ts";

// Live specimen — the fail-loud envelope observed 2026-07-16 when the wrapper-ledger
// occupancy scan died on a codex seat with no ledger row.
const FAIL_LOUD = {
  ok: false,
  error: {
    code: "ValueError",
    message: "wrapper ledger occupancy lookup failed for council:pax",
    detail: "",
  },
} as const;

describe("ok/error envelope", () => {
  test("error specimen parses; detail is present-but-empty", () => {
    const parsed = ErrorEnvelope.parse(FAIL_LOUD);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ValueError");
    expect(parsed.error.detail).toBe("");
  });

  test("ErrorBody requires detail as a string (not optional)", () => {
    expect(() => ErrorBody.parse({ code: "X", message: "y" })).toThrow();
  });

  test("okEnvelope wraps an arbitrary result schema", () => {
    const schema = okEnvelope(z.array(z.number()));
    const parsed = schema.parse({ ok: true, result: [1, 2, 3] });
    expect(parsed.result).toEqual([1, 2, 3]);
  });

  test("envelope() discriminates on ok and narrows both arms", () => {
    const schema = envelope(z.string());
    const ok = schema.parse({ ok: true, result: "hi" });
    const err = schema.parse(FAIL_LOUD);
    expect(ok.ok).toBe(true);
    expect(err.ok).toBe(false);
    if (ok.ok) expect(ok.result).toBe("hi");
    if (!err.ok) expect(err.error.message).toContain("occupancy lookup failed");
  });
});
