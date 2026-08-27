import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const contractsRoot = join(import.meta.dir, "..");

describe("registration contract twin stays dead", () => {
  test("the local registration declaration no longer exists", () => {
    expect(existsSync(join(contractsRoot, "src", "registration.ts"))).toBe(false);
  });

  test("the contracts barrel and package exports cannot resurrect it", () => {
    const index = readFileSync(join(contractsRoot, "src", "index.ts"), "utf8");
    const manifest = JSON.parse(
      readFileSync(join(contractsRoot, "package.json"), "utf8"),
    ) as { exports: Record<string, string> };

    expect(index).not.toContain("./registration.ts");
    expect(manifest.exports).not.toHaveProperty("./registration");
  });
});
