// A service's apply leg and the unit it installs are one artifact.
//
// Each leg owns the runtime root it realizes. The installed unit remains
// uniform while generation.conf supplies the leg's exact WorkingDirectory.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dir, "..");

// `proves` names how the leg observes the function rung after a restart.
// telemetryd's unit returns at fork, so the leg probes the daemon's declared
// function before stamping. txd is Type=notify: `systemctl restart` itself
// blocks on the daemon's READY=1, written only once the control plane serves,
// and the estate rung beneath it is deliberately a health verdict rather than
// a restart failure (a drifted estate must find txd up and red, never
// crash-looping) — so the restart returning IS the observed function edge.
const SERVICES = [
  { service: "txd", unit: "packages/txd/systemd/txd.service", leg: "bin/apply-txd", proves: "notify", root: '$install_root/txd/packages/txd' },
  { service: "telemetryd", unit: "packages/telemetryd/systemd/telemetryd.service", leg: "bin/apply-telemetryd", proves: "function-probe", root: '$install_root/telemetryd/packages/telemetryd' },
] as const;

// Services whose daemon executes from an installed generation: the leg's
// restart key is the generation digest terminus-install-generation prints, and
// the unit's WorkingDirectory is the current-generation pointer that installer
// maintains. The rest still fingerprint the checkout they execute from.
const INSTALLED = SERVICES.filter(({ service }) => service === "telemetryd" || service === "txd");
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
    if (proves === "function-probe") {
      // Promotion is the function rung, and the stamp is written only after it.
      expect(source.indexOf("prove-service-function-ready")).toBeGreaterThan(source.indexOf("systemctl --user restart"));
      expect(source.indexOf('echo "$new_hash" > "$stamp"')).toBeGreaterThan(source.indexOf("prove-service-function-ready"));
    } else {
      expect(proves).toBe("notify");
      expect(read(unit)).toContain("Type=notify");
      expect(source).not.toContain("prove-service-function-ready");
    }
  });

  test("txd: the tx CLI is its own generation, linked through the current pointer", () => {
    const source = read("bin/apply-txd");
    expect(source).toContain('"$terminus/bin/terminus-install-generation" "$terminus" tx src/main.ts');
    expect(source).toContain('tx_main="$install_root/tx/packages/tx/src/main.ts"');
    expect(source).toContain('ln -sfn "$tx_main" "$user_bin_dir/tx"');
    // The tmux estate loads the same generation's configuration; nothing the
    // estate or the CLI executes points back into the deploy checkout.
    expect(source).toContain('tmux_conf="$install_root/txd/packages/txd/tmux/tx.conf"');
    for (const surface of ["packages/txd/systemd/tx-estate.service", "packages/txd/tmux/tx.conf"]) {
      expect(read(surface)).not.toContain("runtimes/Terminus-OS/live");
    }
    expect(read("packages/txd/systemd/tx-estate.service")).toContain("-f %h/.local/lib/terminus-os/txd/packages/txd/tmux/tx.conf");
    expect(read("packages/txd/tmux/tx.conf")).toContain("$HOME/.local/lib/terminus-os/tx/packages/tx/bin/tx-selection");
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
  // installer would restart the daemon it installs. For txd that means
  // re-minting council identities and retiring every live overseer session to
  // deliver a change the running process cannot observe.
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
    // packages/tx/bin/ is a legitimate CLI helper directory: the rule is about
    // apply legs, not about bin/.
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

  test("txd's restart key includes the installed registration configuration", () => {
    // txd loads its allocation generation from the systemd EnvironmentFile.
    // Omitting it left txd serving a stale allocation digest after
    // registrationd restarted into a new one.
    const leg = read("bin/apply-txd");
    expect(leg).toContain('registration_env="$HOME/.config/token-fleet/txd-registration.env"');
    expect(leg).toContain('cat "$registration_env"');
    expect(leg).toContain(`printf 'generation=%s\\n' "$txd_generation"`);
  });
});
