-- 0006 was deployed to the integration PostgreSQL authority. Tighten it
-- forward-only: immutable history is never rewritten in place.
CREATE OR REPLACE FUNCTION replay.is_timestamptz(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
    PERFORM value::timestamptz;
    RETURN true;
EXCEPTION WHEN others THEN
    RETURN false;
END;
$$;

ALTER TABLE replay.streams
    ADD CONSTRAINT replay_source_nonempty CHECK (length(source) > 0),
    ADD CONSTRAINT replay_sequence_positive CHECK (next_sequence > 0);

ALTER TABLE replay.events
    ADD CONSTRAINT replay_event_type_canonical
        CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    ADD CONSTRAINT replay_schema_version_positive CHECK (schema_version > 0),
    ADD CONSTRAINT replay_event_source_nonempty CHECK (length(source) > 0),
    ADD CONSTRAINT replay_provenance_object CHECK (jsonb_typeof(provenance) = 'object'),
    ADD CONSTRAINT replay_payload_object CHECK (jsonb_typeof(payload) = 'object'),
    ADD CONSTRAINT replay_occurred_at_timestamp CHECK (replay.is_timestamptz(occurred_at)),
    ADD CONSTRAINT replay_recorded_at_timestamp CHECK (replay.is_timestamptz(recorded_at));

-- busd is the only replay writer and invokes its in-process wake after commit.
-- Startup and explicit reconciliation recover a lost wake. Bun.SQL has no
-- LISTEN support, so retaining a trigger nobody consumes would be false
-- operational signaling.
DROP TRIGGER IF EXISTS replay_event_wakeup ON replay.events;
DROP FUNCTION IF EXISTS replay.wake();
