// The ONE comm frame template and its parser. comm() stages the frame and the
// prompt hook reads it back; a second copy of either string would let the two
// silently diverge and lose deliveries.
//
// The frame names its sender as persona AND canonical seat id. A persona alone
// is not a key — several seats may wear one — so the seat id is the part a
// reader can join back to the estate, and the compact token is the part txd
// joins back to its own accepted message.
export type CommFrameSource = {
  persona: string;
  seat_id: string;
};

const COMM_TOKEN = '[A-Za-z0-9_-]{22}';
const TX_COMM_FRAME = new RegExp(
  `^\\[tx comm from [^\\]\\r\\n]+ at [^\\]\\r\\n]+(?: agent [^\\]\\r\\n]+)? #(${COMM_TOKEN})\\]\\r?$`,
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

export function commanderEchoFrame(
  messageId: string,
  source: CommFrameSource,
  sourceAgentId: string,
  message: string,
): string {
  return `[tx comm from ${source.persona} at ${source.seat_id} agent ${sourceAgentId} #${commTokenForMessageId(messageId)}]\n${message}`;
}

// Every comm frame the flush carried, not just the one that happened to land
// first. A frame always begins its own line, so the line anchor still refuses
// a token quoted mid-sentence; `m` lets it find the second and third frame of
// a coalesced submission instead of stopping at character zero.
//
// Matching only the first frame cost real deliveries: on 2026-08-03, fourteen
// comms across eight stamped workers arrived in a coalesced flush, were read by
// their target, and were recorded by txd as never delivered.
export function commFrameTokens(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(TX_COMM_FRAME)) seen.add(match[1]!);
  return [...seen];
}
