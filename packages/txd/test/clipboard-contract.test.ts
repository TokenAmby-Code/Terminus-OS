// Clipboard service contract — behavioral-pin lane.

import { describe, expect, test } from 'bun:test';
import {
  ClipboardPullRequestSchema,
  ClipboardPushResponseSchema,
  ClipboardPushRequestSchema,
  MAX_CLIPBOARD_BYTES,
} from '@terminus-os/contracts';

describe('clipboard payload contract', () => {
  test('accepts exact UTF-8 through the 1 MiB boundary', () => {
    expect(ClipboardPullRequestSchema.safeParse({
      schema_version: 7,
      content: '😀\n',
    }).success).toBe(true);
    expect(ClipboardPullRequestSchema.safeParse({
      schema_version: 7,
      content: 'a'.repeat(MAX_CLIPBOARD_BYTES),
    }).success).toBe(true);
  });

  test('rejects oversized and invalid Unicode input', () => {
    expect(ClipboardPullRequestSchema.safeParse({
      schema_version: 7,
      content: 'a'.repeat(MAX_CLIPBOARD_BYTES + 1),
    }).success).toBe(false);
    expect(ClipboardPullRequestSchema.safeParse({
      schema_version: 7,
      content: '\ud800',
    }).success).toBe(false);
  });

  test('push can name only the transient tx clipboard buffer', () => {
    expect(ClipboardPushRequestSchema.safeParse({
      schema_version: 7,
      buffer_name: 'tx-clipboard',
    }).success).toBe(true);
    expect(ClipboardPushRequestSchema.safeParse({
      schema_version: 7,
      buffer_name: 'other',
    }).success).toBe(false);
  });

  test('push response rejects base64 larger than the 1 MiB ceiling before decode', () => {
    expect(ClipboardPushResponseSchema.safeParse({
      ok: true,
      target: 'test',
      buffer_name: 'tx-clipboard',
      bytes: 1,
      content_base64: 'A'.repeat((Math.ceil(MAX_CLIPBOARD_BYTES / 3) * 4) + 1),
    }).success).toBe(false);
  });
});
