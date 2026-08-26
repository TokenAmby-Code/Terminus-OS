import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "../../..");
const needle = "busd";

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("adversarial: the retired daemon stays absent", async () => {
  expect(await Bun.file(join(root, "packages", needle)).exists()).toBe(false);
  expect(await Bun.file(join(root, "bin", `apply-${needle}`)).exists()).toBe(false);

  const self = relative(root, import.meta.path);
  const offenders: string[] = [];
  for (const path of await filesBelow(root)) {
    const name = relative(root, path);
    if (name === self || /^packages\/db\/migrations\/00(?:04|05|08|14|22)_/.test(name)) continue;
    if ((await Bun.file(path).text()).toLowerCase().includes(needle)) offenders.push(name);
  }
  expect(offenders).toEqual([]);

  const migrations = (await readdir(join(root, "packages", "db", "migrations")))
    .sort()
    .map((name) => Bun.file(join(root, "packages", "db", "migrations", name)).text());
  const endState = (await Promise.all(migrations)).join("\n").toLowerCase();
  expect(endState.lastIndexOf("drop schema if exists bus cascade"))
    .toBeGreaterThan(endState.lastIndexOf("create schema if not exists bus"));

  for (const path of await filesBelow(root)) {
    if (!path.includes("/systemd/")) continue;
    expect((await Bun.file(path).text()).toLowerCase()).not.toContain(needle);
  }
});
