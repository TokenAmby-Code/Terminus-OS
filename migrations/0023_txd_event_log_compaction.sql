-- 0023: sanctioned txd event-log compaction audit and its narrow delete gate.
-- Ordinary UPDATE/DELETE/TRUNCATE remain structurally forbidden.  The daemon's
-- compaction transaction sets the local gate only after recording a verified
-- NAS restore attestation and an estate-generation checkpoint.

CREATE TABLE IF NOT EXISTS txd.event_compactions (
    reset_journal_head  bigint PRIMARY KEY,
    boundary_seq        bigint NOT NULL UNIQUE,
    boundary_entity_id text NOT NULL,
    archive_attestation text NOT NULL,
    archived_events     bigint NOT NULL,
    archived_digest     text NOT NULL,
    source_agent_id     text NOT NULL,
    compacted_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION txd.events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('txd.event_compaction', true) = 'archive-attested' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'txd.events is append-only: % forbidden', TG_OP;
END;
$$;
