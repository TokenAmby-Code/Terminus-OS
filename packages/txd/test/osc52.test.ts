// One-shot OSC 52 bridge — behavioral-pin lane.

import { describe, expect, test } from 'bun:test';
import { MAX_CLIPBOARD_BYTES } from '@terminus-os/contracts';
import {
  osc52Sequence,
  validateAttachedClientTty,
  validateClipboardBytes,
} from '../src/osc52.ts';

describe('OSC 52 encoding', () => {
  test('preserves empty, Unicode, emoji, and newlines exactly', () => {
    for (const text of ['', 'plain', 'line 1\nline 2\n', '雪 😀\t']) {
      const bytes = new TextEncoder().encode(text);
      expect(new TextDecoder().decode(osc52Sequence(bytes)))
        .toBe(`\u001b]52;c;${Buffer.from(bytes).toString('base64')}\u0007`);
    }
  });

  test('accepts 1 MiB and rejects oversize or invalid UTF-8', () => {
    expect(validateClipboardBytes(new Uint8Array(MAX_CLIPBOARD_BYTES))).toHaveLength(MAX_CLIPBOARD_BYTES);
    expect(() => validateClipboardBytes(new Uint8Array(MAX_CLIPBOARD_BYTES + 1))).toThrow('exceeds');
    expect(() => validateClipboardBytes(Uint8Array.from([0xc3, 0x28]))).toThrow('valid UTF-8');
  });

});

describe('client-scoped delivery', () => {
  test('validates against the attached-client set', () => {
    expect(validateAttachedClientTty('/dev/pts/7', ['/dev/pts/7', '/dev/pts/8'])).toBe('/dev/pts/7');
    expect(() => validateAttachedClientTty('/dev/pts/9', ['/dev/pts/7'])).toThrow('not attached');
    expect(() => validateAttachedClientTty('/tmp/fake', ['/tmp/fake'])).toThrow('invalid');
  });
});
