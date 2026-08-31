// Adversarial lane: txd consumes the packaged journal foundation directly.
// Its deleted bespoke journal source tree must never be resurrected.
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

test('the bespoke txd journal source tree stays dead', () => {
  expect(existsSync(join(import.meta.dir, '../src/journal'))).toBe(false);
});
