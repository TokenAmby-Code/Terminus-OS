import { expect, test } from "bun:test";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");

test("no apply leg is filed under packages", () => {
  const listed = spawnSync("git", ["ls-files", "-z", "--", "packages"], { cwd: root, encoding: "utf8" });
  expect(listed.status).toBe(0);
  const offenders = listed.stdout.split("\0").filter(Boolean)
    .filter((path) => (path.split("/").pop() ?? "").startsWith("apply-"));
  expect(offenders).toEqual([]);
});
