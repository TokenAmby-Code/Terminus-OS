import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../..");
describe("adversarial: Discord executable ownership stays outside Terminus-OS", () => {
  test("no executable package or deployment unit can reappear", () => {
    expect(existsSync(resolve(root, "packages/discord"))).toBe(false);
    expect(existsSync(resolve(root, "deploy/systemd/terminus-discord.service"))).toBe(false);
    expect(existsSync(resolve(root, "deploy/env/terminus-discord.env.example"))).toBe(false);
  });
});
