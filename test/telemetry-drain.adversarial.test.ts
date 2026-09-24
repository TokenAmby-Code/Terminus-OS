import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

test("telemetry implementation and deployment cannot reappear in Terminus", () => {
  const root = resolve(import.meta.dir, "..");
  expect(existsSync(resolve(root, "packages/telemetryd"))).toBe(false);
  expect(existsSync(resolve(root, "bin/apply-telemetryd"))).toBe(false);
});
