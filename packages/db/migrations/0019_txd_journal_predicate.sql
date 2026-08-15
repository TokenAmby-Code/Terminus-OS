UPDATE txd.journal_cursors
SET predicate_hash = 'sha256:txd-events:journal-v2'
WHERE lane = 'txd-events'
  AND predicate_hash = 'sha256:txd-events:journal-v1';
