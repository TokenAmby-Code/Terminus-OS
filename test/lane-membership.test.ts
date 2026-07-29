// Lane membership is enforced, not conventional.
//
// The `tests` doctrine says a test's lane must be visible at the test site.
// Terminus-OS carried three different spellings of "this is an adversarial
// test" — `*.adversarial.test.ts` (4 files), `*-adversarial.test.ts` (1), and a
// `test/adversarial/` directory (1) — and nothing in package.json or CI could
// run the lane at all. The obvious selector, `bun test .adversarial.test.ts`,
// caught 4 of the 6: it ran 6 tests across 4 files while two files sat unrun,
// which is silent partial coverage wearing a green result.
//
// Per `exterminatus`: one name, no aliases, no back-compat glob that keeps the
// old spellings working. The canonical form is `<subject>.adversarial.test.ts`
// and `bun run test:adversarial` is the selector. These tests hold both.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const CANONICAL = ".adversarial.test.ts";
const SELECTOR = "test:adversarial";

function trackedFiles(): string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\0").filter(Boolean);
}

describe("adversarial lane membership", () => {
  test("every file that claims the lane uses the one canonical spelling", () => {
    const offenders = trackedFiles().filter(
      (path) => /adversarial/i.test(path) && !path.endsWith(CANONICAL),
    );
    expect(offenders).toEqual([]);
  });

  test("no directory carries the lane name instead of the filename", () => {
    const offenders = trackedFiles().filter((path) =>
      path.split("/").slice(0, -1).some((segment) => /adversarial/i.test(segment)),
    );
    expect(offenders).toEqual([]);
  });

  test("the selector exists and still selects on the canonical suffix", async () => {
    const manifest = await Bun.file(join(root, "package.json")).json();
    const script = manifest.scripts?.[SELECTOR];
    expect(script).toBeString();
    // A selector that stops matching the canonical suffix silently empties the
    // lane; that is the failure this whole file exists to prevent.
    expect(script).toContain(CANONICAL);
  });

  test("the lane is not empty", () => {
    // A selector matching nothing passes trivially. If a removal is genuinely
    // retired, lower this floor in the same commit that retires it.
    const lane = trackedFiles().filter((path) => path.endsWith(CANONICAL));
    expect(lane.length).toBeGreaterThanOrEqual(6);
  });
});
