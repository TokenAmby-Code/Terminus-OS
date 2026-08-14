// Adversarial: the removed page name must never regain runtime resolution.

import { expect, test } from 'bun:test';
import { isTxdPage, TXD_ESTATE } from '../src/estate.ts';

test('adversarial: the legacy page name resolves nowhere in the estate', () => {
  expect(isTxdPage('reservists')).toBe(false);
  expect(TXD_ESTATE.some((seat) => seat.startsWith('reservists:'))).toBe(false);
});
