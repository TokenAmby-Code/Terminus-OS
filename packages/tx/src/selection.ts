import {
  ClipboardSelectionRequestSchema,
  ClipboardSelectionResponseSchema,
  MAX_CLIPBOARD_BYTES,
  SCHEMA_VERSION,
} from '@terminus-os/contracts';
import { createClient, type TxdRequest } from './client.ts';

export type SelectionClientDependencies = {
  stdin: () => Promise<Uint8Array>;
  request: TxdRequest;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

export async function readBoundedSelection(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CLIPBOARD_BYTES) {
        await reader.cancel();
        throw new Error('clipboard payload exceeds 1 MiB');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeSelection(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('clipboard payload is not valid UTF-8');
  }
}

export async function runSelectionCommit(
  args: string[],
  dependencies: SelectionClientDependencies = {
    stdin: () => readBoundedSelection(Bun.stdin.stream()),
    request: createClient(),
    stdout: console.log,
    stderr: console.error,
  },
): Promise<number> {
  try {
    if (args.length !== 2 || args[0] !== '--tty' || !args[1]) {
      throw new Error('usage: tx-selection --tty <attached-client-tty>');
    }
    const bytes = await dependencies.stdin();
    if (bytes.byteLength > MAX_CLIPBOARD_BYTES) throw new Error('clipboard payload exceeds 1 MiB');
    const request = ClipboardSelectionRequestSchema.safeParse({
      schema_version: SCHEMA_VERSION,
      client_tty: args[1],
      content: decodeSelection(bytes),
    });
    if (!request.success) throw new Error('clipboard selection request is invalid');
    const raw = await dependencies.request(
      'POST',
      '/ctl/clipboard/selection',
      request.data,
      { sensitive: true, maxResponseBytes: 4096 },
    );
    const response = ClipboardSelectionResponseSchema.safeParse(raw);
    if (!response.success || response.data.bytes !== bytes.byteLength) {
      throw new Error('txd returned an invalid clipboard selection receipt');
    }
    dependencies.stdout(JSON.stringify({
      ok: true,
      target: response.data.target,
      direction: 'selection',
      bytes: response.data.bytes,
    }));
    return 0;
  } catch (error) {
    dependencies.stderr(`tx-selection: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
