// Adversarial lane: Phase 0's false event paths must stay absent.

import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

test('adversarial: the retired production deployment workflow stays absent', () => {
  expect(existsSync(join(root, '.github/workflows/deploy-production.yml'))).toBeFalse();
});

test('adversarial: the retired database workspace package stays absent', () => {
  expect(existsSync(join(root, 'packages/db'))).toBeFalse();
});
