const JOURNAL_RECEIPT = /^journal:([1-9][0-9]*)$/;

export function makeJournalReceipt(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('invalid_journal_seq');
  return `journal:${seq}`;
}

export function journalEventSeqFromReceipt(receipt: string | null): number | null {
  if (receipt === null) return null;
  const matched = JOURNAL_RECEIPT.exec(receipt);
  if (!matched) return null;
  const seq = Number(matched[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}
