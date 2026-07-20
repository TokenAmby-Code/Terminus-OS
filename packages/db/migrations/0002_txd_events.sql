-- 0002: txd's event stream — the estate daemon's single source of truth.
--
-- One append-only events table, ONE writer (txd). Truth is the stream; every
-- displayed status is a projection rebuilt by replay — nobody writes them.
-- The 8 columns are exactly the ruled shape (spec §2); payload/provenance are
-- structured facts (jsonb), occurred_at/recorded_at are stored VERBATIM as the
-- attested ISO-8601 strings (replay equality over normalization).
--
-- Append-only is STRUCTURAL, not conventional: triggers raise on UPDATE,
-- DELETE, and TRUNCATE, so a stray writer cannot silently rewrite history.
--
-- Idempotent DDL throughout: integration lanes reset the migration ledger, so
-- re-application over an existing schema must converge, not collide.

CREATE SCHEMA IF NOT EXISTS txd;

CREATE TABLE IF NOT EXISTS txd.events (
    seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type  text   NOT NULL,
    entity_id    text   NOT NULL,
    event_type   text   NOT NULL,
    payload      jsonb  NOT NULL,
    provenance   jsonb  NOT NULL,
    occurred_at  text   NOT NULL,
    recorded_at  text   NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txd_events_entity ON txd.events (entity_id, seq);

CREATE OR REPLACE FUNCTION txd.events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'txd.events is append-only: % forbidden', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER events_no_update
    BEFORE UPDATE ON txd.events
    FOR EACH ROW EXECUTE FUNCTION txd.events_immutable();

CREATE OR REPLACE TRIGGER events_no_delete
    BEFORE DELETE ON txd.events
    FOR EACH ROW EXECUTE FUNCTION txd.events_immutable();

CREATE OR REPLACE TRIGGER events_no_truncate
    BEFORE TRUNCATE ON txd.events
    FOR EACH STATEMENT EXECUTE FUNCTION txd.events_immutable();
