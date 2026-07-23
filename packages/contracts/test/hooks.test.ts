import { describe, expect, test } from "bun:test";
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  HOOK_TYPES,
  HookTypeSchema,
} from "../src/hooks.ts";

// The vendor hook-type enumeration is PINNED from the shipped vendor binaries
// (claude-code 2.1.215; codex-cli 0.144.6) — never invented. These tests are
// the re-pin alarm: a vendor contract change must arrive as a deliberate edit.

function snake(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

describe("vendor hook-type enumeration", () => {
  test("claude-code pins 30 hook events; codex pins 10", () => {
    expect(CLAUDE_HOOK_EVENTS).toHaveLength(30);
    expect(CODEX_HOOK_EVENTS).toHaveLength(10);
  });

  test("the codex set is a strict subset of the claude set", () => {
    for (const e of CODEX_HOOK_EVENTS) expect(CLAUDE_HOOK_EVENTS).toContain(e);
    expect(CODEX_HOOK_EVENTS.length).toBeLessThan(CLAUDE_HOOK_EVENTS.length);
  });

  test("HOOK_TYPES is the snake_cased vendor union, order-preserving and duplicate-free", () => {
    expect([...HOOK_TYPES] as string[]).toEqual(CLAUDE_HOOK_EVENTS.map(snake));
    expect(new Set(HOOK_TYPES).size).toBe(HOOK_TYPES.length);
    for (const t of HOOK_TYPES) expect(t).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test("the hooks txd consumes off the bus are in the enumeration", () => {
    expect(HOOK_TYPES).toContain("stop");
    expect(HOOK_TYPES).toContain("user_prompt_submit");
    expect(HookTypeSchema.parse("stop")).toBe("stop");
    expect(() => HookTypeSchema.parse("invented_hook")).toThrow();
  });
});
