-- Start the registrationd-owned agent generation with a fresh canonical txd
-- stream. The prior append-only stream remains sealed and queryable; no row is
-- rewritten or deleted. Runtime replay sees only facts admitted under the
-- current contract, so removed identity and persona-launch vocabulary cannot
-- become compatibility policy.

ALTER TABLE txd.events RENAME TO prior_events;
ALTER INDEX txd.idx_txd_events_entity RENAME TO idx_txd_prior_events_entity;

CREATE TABLE txd.events (
    seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_type  text   NOT NULL,
    entity_id    text   NOT NULL,
    event_type   text   NOT NULL,
    payload      jsonb  NOT NULL,
    provenance   jsonb  NOT NULL,
    occurred_at  text   NOT NULL,
    recorded_at  text   NOT NULL
);

CREATE INDEX idx_txd_events_entity ON txd.events (entity_id, seq);

CREATE TRIGGER events_no_update
    BEFORE UPDATE ON txd.events
    FOR EACH ROW EXECUTE FUNCTION txd.events_immutable();

CREATE TRIGGER events_no_delete
    BEFORE DELETE ON txd.events
    FOR EACH ROW EXECUTE FUNCTION txd.events_immutable();

CREATE TRIGGER events_no_truncate
    BEFORE TRUNCATE ON txd.events
    FOR EACH STATEMENT EXECUTE FUNCTION txd.events_immutable();
