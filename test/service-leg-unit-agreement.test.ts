// A service's apply leg and the unit it installs are one artifact.
//
// Each leg owns the runtime root it realizes. The installed unit remains
// uniform while generation.conf supplies the leg's exact WorkingDirectory.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");

// Apply legs prove the daemon function before stamping.
const SERVICES = [
  { service: "telemetryd", unit: "packages/telemetryd/systemd/telemetryd.service", leg: "bin/apply-telemetryd", proves: "function-probe", root: '$install_root/telemetryd/packages/telemetryd' },
] as const;

// Services whose daemon executes from an installed generation: the leg's
// restart key is the generation digest terminus-install-generation prints, and
// the unit's WorkingDirectory is the current-generation pointer that installer
// maintains. The rest still fingerprint the checkout they execute from.
const INSTALLED = SERVICES;
const CHECKOUT_EXECUTED: typeof SERVICES = [];

const read = (relative: string) => readFileSync(join(root, relative), "utf8");

describe("apply leg and installed unit agree", () => {
  test.each(SERVICES)("$service: the leg drop-in owns WorkingDirectory", ({ unit, leg, root: runtimeRoot }) => {
    const declared = read(unit)
      .split("\n")
      .filter((line) => line.startsWith("WorkingDirectory="));
    expect(declared).toEqual([]);

    const source = read(leg);
    expect(source).not.toMatch(/grep -qx 'WorkingDirectory=/);
    expect(source).toContain(`working_directory="${runtimeRoot}"`);
    expect(source).toContain("WorkingDirectory=%s\\n");
    expect(source).toContain('"$sha" "$working_directory" >"$generation_dropin"');
  });

  test.each(CHECKOUT_EXECUTED)("$service: the leg resolves the fingerprint helper inside this repository", ({ leg }) => {
    const source = read(leg);
    expect(source).toContain('"$terminus/bin/terminus-package-fingerprint"');
    // The helper is no longer reachable through the fleet checkout: a leg that
    // still looked for it there would fail only on a live converge.
    expect(source).not.toContain("shared/bin/terminus-package-fingerprint");
  });

  test.each(INSTALLED)("$service: the leg realizes the generation its unit executes from", ({ service, unit, leg, proves }) => {
    const source = read(leg);
    expect(source).toContain(`"$terminus/bin/terminus-install-generation" "$terminus" ${service} src/daemon.ts`);
    expect(source).not.toContain("terminus-package-fingerprint");
    expect(read(unit)).not.toMatch(/^WorkingDirectory=/m);
    // An installed tree cannot answer `git rev-parse`; the checkout SHA reaches
    // the daemon as a drop-in the restart key does not fold.
    expect(source).toContain(`printf '[Service]\\nEnvironment=GIT_SHA=%s\\nWorkingDirectory=%s\\n' "$sha"`);
    expect(proves).toBe("function-probe");
    expect(source.indexOf("prove-service-function-ready")).toBeGreaterThan(source.indexOf("systemctl --user restart"));
    expect(source.indexOf('echo "$new_hash" > "$stamp"')).toBeGreaterThan(source.indexOf("prove-service-function-ready"));
  });

  test("telemetryd: tm links to its baked generation launcher", () => {
    const source = read("bin/apply-telemetryd");
    expect(source).toContain('src/daemon.ts --launcher tm src/cli.ts');
    expect(source).toContain('ln -sfn "$install_root/telemetryd/bin/tm" "$HOME/.local/bin/tm"');
  });

  test.each(SERVICES)("$service: the leg carries no restart-control branch", ({ leg }) => {
    // A restart control is a root artifact the machine baseline installs from
    // the Token-Fleet registry. A leg outside that repository never trampolines
    // into the installer to declare its own.
    expect(read(leg)).not.toContain("FLEET_RESTART_CONTROLS_ONLY");
  });
});

describe("a service's restart key does not fold in its own installer", () => {
  // terminus-package-fingerprint emits everything a service loads at RUNTIME —
  // that is what its restart stamp keys on. It walks packages/<svc> whole,
  // pruning only node_modules and test. An apply leg placed under
  // packages/<svc>/ therefore lands INSIDE the restart key, and editing the
  // installer would restart a daemon for a change it cannot observe.
  //
  // The legs live at the repository root instead, outside every package walk,
  // so no prune rule is needed and none is added. An installed generation
  // carries the same set — its installer reads the closure from this helper
  // and copies nothing from bin/ — which test/installed-generation.behavioral
  // .test.ts holds directly against the realized tree.
  const fingerprint = (pkg: string) => {
    const result = spawnSync(join(root, "bin/terminus-package-fingerprint"), [root, pkg], {
      encoding: "utf8", maxBuffer: 1024 * 1024 * 256,
    });
    expect(result.status).toBe(0);
    return result.stdout;
  };

  test.each(SERVICES)("$service: no apply leg is inside its restart key", ({ service }) => {
    const paths = fingerprint(service).split("\n").filter((line) => line.startsWith("packages/"));
    expect(paths.filter((path) => path.includes("/apply-"))).toEqual([]);
  });

  test.each(SERVICES)("$service: the restart key still reaches its src/", ({ service }) => {
    const paths = fingerprint(service).split("\n");
    expect(paths.some((path) => path.startsWith(`packages/${service}/src/`))).toBe(true);
  });

  test("no apply leg is filed under packages/ at all", () => {
    // The first two tests only see the three services fingerprinted here. This
    // one holds the convention itself, so a leg for a service added later
    // cannot be filed into a package walk that nothing in this file inspects.
    const listed = spawnSync("git", ["ls-files", "-z", "--", "packages"], { cwd: root, encoding: "utf8" });
    expect(listed.status).toBe(0);
    const offenders = listed.stdout.split("\0").filter(Boolean)
      .filter((path) => (path.split("/").pop() ?? "").startsWith("apply-"));
    expect(offenders).toEqual([]);
  });
});

describe("leg invariants that travelled with the legs", () => {
  // These held in Token-Fleet against its copies of the same scripts. Their
  // subject moved here, so they move here — a deleted pin is lost coverage, and
  // a Token-Fleet test cannot read this repository (its CI has no checkout of
  // it).

  test("no leg re-implements the fleet Bun runtime pin", () => {
    // Exactly one thing links the pinned Bun onto the command PATH: Token-Fleet's
    // apply-fleet-runtime. A leg that did it too would silently take ownership of
    // the fleet-wide version.
    for (const { leg } of SERVICES) {
      expect(read(leg)).not.toContain('ln -sfn "$HOME/.bun/bin/bun"');
    }
  });
});
