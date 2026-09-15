// Canonical Palace geometry — behavioral-pin lane.

import { describe, expect, test } from 'bun:test';
import { palaceGeometry } from '../src/estate.ts';

describe('palaceGeometry', () => {
  test('projects W full-height left, N/S center, and E full-height right', () => {
    const geometry = palaceGeometry(347, 58);

    expect(geometry.shape).toBe('columns');
    const [west, north, south, east] = geometry.panes;
    expect(west).toMatchObject({ left: 0, top: 0, height: 58 });
    expect(north.left).toBe(west.width + 1);
    expect(south).toMatchObject({ left: north.left, top: north.height + 1, width: north.width });
    expect(north.height + south.height + 1).toBe(58);
    expect(east).toMatchObject({ left: north.left + north.width + 1, top: 0, height: 58 });
    expect(west.width + north.width + east.width + 2).toBe(347);
  });

  test('derives the same bounded split at smaller dimensions', () => {
    const [west, north, south, east] = palaceGeometry(120, 24).panes;

    expect([west.width, north.width, east.width]).toEqual([35, 47, 36]);
    expect([north.height, south.height]).toEqual([11, 12]);
    expect([west.left, north.left, east.left]).toEqual([0, 36, 84]);
  });
});
