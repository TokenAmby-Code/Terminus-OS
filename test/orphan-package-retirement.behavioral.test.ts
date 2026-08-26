import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
const pathExists = async (path: string) => lstat(path).then(() => true, () => false);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("orphan Terminus package retirement", () => {
  test("removes installed artifacts only when their source package is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminus-retire-"));
    roots.push(root);
    const terminus = join(root, "checkout");
    const units = join(root, "units");
    const config = join(root, "config");
    const state = join(root, "state");
    const installs = join(root, "installs");
    const bin = join(root, "bin");
    await Promise.all([terminus, units, config, state, installs, bin].map((path) => mkdir(path, { recursive: true })));

    for (const name of ["orphan", "keeper"]) {
      await mkdir(join(units, `${name}.service.d`), { recursive: true });
      await writeFile(join(units, `${name}.service`), "[Service]\n");
      const workingDirectory = name === "orphan"
        ? join(installs, name, "packages", name)
        : join(terminus, "packages", name);
      await writeFile(join(units, `${name}.service.d`, "generation.conf"), `[Service]\nWorkingDirectory=${workingDirectory}\n`);
      await writeFile(join(config, `${name}.json`), "{}\n");
      await writeFile(join(state, `${name}.applied.sha256`), "digest\n");
      await mkdir(join(installs, "generations", name, "digest"), { recursive: true });
      await symlink(`generations/${name}/digest`, join(installs, name));
    }
    await writeFile(join(units, "orphan-postgres.path"), "[Path]\n");
    await mkdir(join(terminus, "packages", "keeper"), { recursive: true });
    await writeFile(join(terminus, "packages", "keeper", "package.json"), "{}\n");

    const systemctl = join(bin, "systemctl");
    const log = join(root, "systemctl.log");
    await writeFile(systemctl, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\n`);
    await chmod(systemctl, 0o755);

    const proc = Bun.spawn([join(import.meta.dir, "..", "bin", "retire-orphan-packages"), "k12-personal"], {
      env: {
        ...process.env,
        TERMINUS_CHECKOUT: terminus,
        TERMINUS_UNIT_DIR: units,
        TERMINUS_CONFIG_DIR: config,
        TERMINUS_STATE_DIR: state,
        TERMINUS_INSTALL_ROOT: installs,
        SYSTEMCTL: systemctl,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);

    expect(await Bun.file(log).text()).toContain("disable --now orphan.service orphan-postgres.path");
    for (const path of [
      join(units, "orphan.service"),
      join(units, "orphan.service.d"),
      join(units, "orphan-postgres.path"),
      join(config, "orphan.json"),
      join(state, "orphan.applied.sha256"),
      join(installs, "orphan"),
      join(installs, "generations", "orphan"),
    ]) expect(await pathExists(path)).toBe(false);

    for (const path of [
      join(units, "keeper.service"),
      join(config, "keeper.json"),
      join(state, "keeper.applied.sha256"),
      join(installs, "keeper"),
    ]) expect(await pathExists(path)).toBe(true);
  });
});
