const BUS_RECEIPT = /^bus:(\d+)$/;

export function makeBusReceipt(eventSeq: number): string {
  return `bus:${eventSeq}`;
}

export function busEventSeqFromReceipt(receipt: string | null): number | null {
  const encoded = receipt?.match(BUS_RECEIPT)?.[1];
  return encoded === undefined ? null : Number(encoded);
}
