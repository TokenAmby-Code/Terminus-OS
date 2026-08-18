export type CommFrameSource = {
  persona: string;
  seat_id: string;
};

const COMM_TOKEN = '[A-Za-z0-9_-]{22}';
const TX_COMM_FRAME = new RegExp(
  `^\\[tx comm from [^\\]\\r\\n]+ at [^\\]\\r\\n]+ #(${COMM_TOKEN})\\]\\r?$`,
  'gm',
);

export function commTokenForMessageId(messageId: string): string {
  const hex = messageId.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('invalid_comm_message_id');
  return Buffer.from(hex, 'hex').toString('base64url');
}

export function commFrame(
  messageId: string,
  source: CommFrameSource,
  message: string,
): string {
  return `[tx comm from ${source.persona} at ${source.seat_id} #${commTokenForMessageId(messageId)}]\n${message}`;
}

// A single engine submission may flush several queued comms. Preserve their
// order and collapse only exact repeats from the same submitted prompt.
export function commFrameTokens(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(TX_COMM_FRAME)) seen.add(match[1]!);
  return [...seen];
}
