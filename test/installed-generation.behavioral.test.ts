// terminus-install-generation realizes a package as a frozen tree outside the
// checkout, identified by its content. These are the properties a leg's
// restart key and a daemon's working directory stand on.
//
// The installer is run against this checkout itself, into a scratch install
// root, with the fleet's package-credential projector replaced by a plain
// install: the registry read is a machine concern the projector owns, and the
// closure this repository declares resolves from bun's cache or CI's scope
// token without it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const installer = join(root, "bin/terminus-install-generation");

let scratch: string;
let installRoot: string;
let fleet: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "terminus-generation-"));
  installRoot = join(scratch, "install");
  fleet = join(scratch, "fleet");
  mkdirSync(join(fleet, "shared/bin"), { recursive: true });
  writeFileSync(
    join(fleet, "shared/bin/fleet-packages"),
    '#!/usr/bin/env bash\nset -euo pipefail\n[[ "$1" == install ]] || exit 64\nproject="$2"; shift 2\ncd "$project" && exec bun install "$@"\n',
    { mode: 0o755 },
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const run = (...args: string[]) =>
  spawnSync(installer, args, {
    encoding: "utf8",
    env: { ...process.env, TERMINUS_INSTALL_ROOT: installRoot, FLEET_CHECKOUT: fleet },
  });

const generations = () => join(installRoot, "generations/telemetryd");
const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name === "node_modules") return [];
    return entry.isDirectory() ? [path, ...walk(path)] : [path];
  });

describe("an installed generation", () => {
  let digest: string;

  test("is realized from the closure, current by symlink, and named by its content", () => {
    const first = run(root, "telemetryd", "src/daemon.ts");
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    digest = first.stdout.trim();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const current = join(installRoot, "telemetryd");
    expect(lstatSync(current).isSymbolicLink()).toBe(true);
    expect(readlinkSync(current)).toBe(`generations/telemetryd/${digest}`);

    const tree = join(generations(), digest);
    // The daemon's own source and the runtime files its closure loads.
    expect(existsSync(join(tree, "packages/telemetryd/src/daemon.ts"))).toBe(true);
    expect(existsSync(join(tree, "packages/telemetryd/node_modules/@terminus-os/db"))).toBe(true);
    expect(readdirSync(join(tree, "packages/db/migrations")).some((f) => f.endsWith(".sql"))).toBe(true);
    for (const file of ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json"]) {
      expect(existsSync(join(tree, file))).toBe(true);
    }
    // Members outside the closure are manifest-only stubs that keep the
    // frozen lockfile describing this workspace; nothing of theirs is loaded.
    expect(existsSync(join(tree, "packages/txd/package.json"))).toBe(true);
    expect(existsSync(join(tree, "packages/txd/src"))).toBe(false);
  });

  test("carries no tests and no apply leg: the restart key is what the daemon loads", () => {
    const files = walk(join(generations(), digest));
    expect(files.filter((path) => path.endsWith("/test"))).toEqual([]);
    expect(files.filter((path) => path.split("/").pop()!.startsWith("apply-"))).toEqual([]);
    expect(existsSync(join(generations(), digest, "bin"))).toBe(false);
  });

  test("re-realizing the same sources yields the same digest and no second generation", () => {
    const second = run(root, "telemetryd", "src/daemon.ts");
    expect(second.status).toBe(0);
    expect(second.stdout.trim()).toBe(digest);
    expect(readdirSync(generations()).filter((name) => !name.startsWith("."))).toEqual([digest]);
  });

  test("retires a generation nothing runs from and keeps one a live process occupies", async () => {
    const stale = join(generations(), "0".repeat(64));
    const occupied = join(generations(), "1".repeat(64));
    mkdirSync(join(stale, "packages/telemetryd"), { recursive: true });
    mkdirSync(join(occupied, "packages/telemetryd"), { recursive: true });
    const resident = spawn("sleep", ["30"], { cwd: join(occupied, "packages/telemetryd"), stdio: "ignore" });
    try {
      await new Promise((resolve) => resident.once("spawn", resolve));
      const pass = run(root, "telemetryd", "src/daemon.ts");
      expect(pass.status).toBe(0);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(occupied)).toBe(true);
      expect(readlinkSync(join(installRoot, "telemetryd"))).toBe(`generations/telemetryd/${digest}`);
    } finally {
      resident.kill();
    }
  });

  // The digest is what the daemon loads, so a change to a workspace member
  // outside the closure — the case that restarted a service on every unrelated
  // merge while HEAD was the key — leaves it alone, and a change inside the
  // closure moves it. Both are held against a copy of this checkout with one
  // file edited, realized into its own install root.
  const realizeCopy = (edit: (checkout: string) => void): string => {
    const checkout = mkdtempSync(join(scratch, "checkout-"));
    const copy = spawnSync("bash", ["-c", `tar -C "$1" --exclude=./node_modules --exclude=./.git -cf - . | tar -C "$2" -xf -`, "_", root, checkout]);
    expect(copy.status).toBe(0);
    edit(checkout);
    const isolated = mkdtempSync(join(scratch, "install-"));
    try {
      const pass = spawnSync(installer, [checkout, "telemetryd", "src/daemon.ts"], {
        encoding: "utf8",
        env: { ...process.env, TERMINUS_INSTALL_ROOT: isolated, FLEET_CHECKOUT: fleet },
      });
      expect(pass.stderr).toBe("");
      expect(pass.status).toBe(0);
      return pass.stdout.trim();
    } finally {
      // Each realization is a full checkout copy plus a production install;
      // they are released as they are read so the suite's footprint on a
      // shared tmpfs stays one generation, not four.
      rmSync(checkout, { recursive: true, force: true });
      rmSync(isolated, { recursive: true, force: true });
    }
  };

  test("a change to a workspace member outside the closure does not move the digest", () => {
    const unrelated = realizeCopy((checkout) => {
      writeFileSync(join(checkout, "packages/txd/src/unrelated.ts"), "export const unrelated = true;\n");
      const manifest = join(checkout, "packages/txd/package.json");
      writeFileSync(manifest, JSON.stringify({
        ...JSON.parse(readFileSync(manifest, "utf8")), description: "edited outside telemetryd's closure",
      }));
    });
    expect(unrelated).toBe(digest);
  });

  test("a change inside the closure moves the digest", () => {
    const changed = realizeCopy((checkout) => {
      writeFileSync(join(checkout, "packages/db/src/generation-probe.ts"), "export const probe = true;\n");
    });
    expect(changed).not.toBe(digest);
    expect(changed).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses an entrypoint the package does not carry, before touching anything installed", () => {
    const refused = run(root, "telemetryd", "src/absent.ts");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("packages/telemetryd/src/absent.ts does not exist");
    expect(readlinkSync(join(installRoot, "telemetryd"))).toBe(`generations/telemetryd/${digest}`);
    expect(readdirSync(generations()).filter((name) => name.startsWith(".candidate"))).toEqual([]);
  });
});
