import { MAX_CLIPBOARD_BYTES } from '@terminus-os/contracts';

export function validateClipboardBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_CLIPBOARD_BYTES) {
    throw new Error(`clipboard payload exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('clipboard payload is not valid UTF-8');
  }
}

export function osc52Sequence(bytes: Uint8Array): Uint8Array {
  validateClipboardBytes(bytes);
  return new TextEncoder().encode(`\u001b]52;c;${Buffer.from(bytes).toString('base64')}\u0007`);
}

export function validateAttachedClientTty(requested: string, attached: readonly string[]): string {
  if (!/^\/dev\/(?:pts\/[0-9]+|tty[A-Za-z0-9._-]*)$/.test(requested)) {
    throw new Error('invoking client tty is invalid');
  }
  if (!attached.includes(requested)) throw new Error('invoking client tty is not attached');
  return requested;
}
