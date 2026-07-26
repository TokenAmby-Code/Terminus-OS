-- Rows admitted by PostgreSQL must remain readable by the versioned runtime
-- contract forever; immutable malformed truth cannot be repaired afterward.
ALTER TABLE replay.events
    ADD CONSTRAINT replay_sequence_positive CHECK (sequence > 0),
    ADD CONSTRAINT replay_schema_version_v1 CHECK (schema_version = 1);
