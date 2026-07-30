import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const self = "test/token-os-machine-config-containment.adversarial.test.ts";
const forbidden = [
  /nas-path\.sh/,
  /imperium_config/,
  /imperium_cfg/,
  /_IMPERIUM_CFG_/,
  /_IMPERIUM_TOKEN_API_HOST/,
  /Token-OS|token-api|Token-API|TOKEN_API|TOKEN_OS/,
  /macOS|launchctl|ai\.openclaw\.tokenapi|ssh-mac|sshmini|\/Volumes\//,
  /(^|[^A-Za-z0-9_])[Mm]ac([^A-Za-z0-9_]|$)/,
];

describe("adversarial: Token-OS machine configuration containment", () => {
  test("tracked files do not reference legacy registry surfaces", () => {
    const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
    expect(result.exitCode).toBe(0);
    const violations: string[] = [];
    for (const path of result.stdout.toString().split("\0").filter(Boolean)) {
      if (path === self) continue;
      const absolute = join(root, path);
      if (!existsSync(absolute)) continue;
      const content = readFileSync(absolute, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) violations.push(`${path}: forbidden archived-platform surface ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
