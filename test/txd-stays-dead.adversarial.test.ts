import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("adversarial: estate ownership stays outside Terminus", () => {
  test("the daemon, client, installer and contract are absent", () => {
    for (const path of ["packages/txd", "packages/tx", "bin/apply-txd", "packages/contracts/src/txd.ts"]) {
      expect({ path, exists: existsSync(join(root, path)) }).toEqual({ path, exists: false });
    }
  });

  test("no migration or deployment lane owns the estate", () => {
    expect(readdirSync(join(root, "migrations")).filter((name) => name.includes("txd"))).toEqual([]);
    for (const path of [".github/workflows/ci.yml", "bin/terminus-install-generation", "bin/terminus-package-fingerprint", "packages/contracts/package.json", "packages/contracts/src/index.ts"]) {
      expect(readFileSync(join(root, path), "utf8")).not.toMatch(/txd|packages\/tx\b|tx-estate/);
    }
  });
});
