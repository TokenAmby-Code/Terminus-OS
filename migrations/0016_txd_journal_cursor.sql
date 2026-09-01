CREATE TABLE IF NOT EXISTS txd.journal_cursors (
  lane text PRIMARY KEY CHECK (lane <> ''),
  cursor_seq bigint NOT NULL CHECK (cursor_seq >= 0),
  predicate_hash text NOT NULL CHECK (predicate_hash <> ''),
  seed_kind text NOT NULL CHECK (seed_kind IN ('beginning', 'now', 'seq')),
  seed_seq bigint NOT NULL CHECK (seed_seq >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  advanced_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS txd.journal_poison (
  lane text NOT NULL REFERENCES txd.journal_cursors (lane),
  event_seq bigint NOT NULL CHECK (event_seq > 0),
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  error_code text NOT NULL CHECK (error_code <> ''),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disposition text,
  disposed_at timestamptz,
  PRIMARY KEY (lane, event_seq),
  UNIQUE (lane, event_id),
  CHECK ((disposition IS NULL) = (disposed_at IS NULL))
);
