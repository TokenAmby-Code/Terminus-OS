CREATE SCHEMA IF NOT EXISTS replay;

CREATE TABLE IF NOT EXISTS replay.streams (
    replay_id       uuid        PRIMARY KEY,
    request_hash    char(64)    NOT NULL,
    source          text        NOT NULL,
    next_sequence   bigint      NOT NULL DEFAULT 1,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT request_hash_sha256 CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS replay.events (
    journal_sequence   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id           uuid   NOT NULL UNIQUE,
    replay_id          uuid   NOT NULL REFERENCES replay.streams (replay_id),
    sequence           bigint NOT NULL,
    event_type         text   NOT NULL,
    schema_version     integer NOT NULL,
    source             text   NOT NULL,
    provenance         jsonb  NOT NULL,
    causation_event_id uuid   NULL REFERENCES replay.events (event_id),
    occurred_at        text   NOT NULL,
    recorded_at        text   NOT NULL,
    payload            jsonb  NOT NULL,
    UNIQUE (replay_id, sequence)
);

CREATE INDEX IF NOT EXISTS replay_events_unfinished
    ON replay.events (source, replay_id, sequence);
CREATE INDEX IF NOT EXISTS replay_events_delivery
    ON replay.events (event_type, journal_sequence);

CREATE TABLE IF NOT EXISTS replay.publication_intents (
    event_id   uuid        PRIMARY KEY REFERENCES replay.events (event_id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay.delivery_attempts (
    attempt_sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id         uuid        NOT NULL REFERENCES replay.events (event_id),
    subscription_name text       NOT NULL REFERENCES bus.subscriptions (name),
    succeeded        boolean     NOT NULL,
    error            text        NULL,
    attempted_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT delivered_has_no_error CHECK (NOT succeeded OR error IS NULL)
);

CREATE INDEX IF NOT EXISTS replay_delivery_attempts_latest
    ON replay.delivery_attempts (event_id, subscription_name, attempt_sequence DESC);

CREATE OR REPLACE FUNCTION replay.immutable_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'replay truth is append-only: % forbidden on %', TG_OP, TG_TABLE_NAME;
END;
$$;

CREATE OR REPLACE TRIGGER replay_events_no_update
    BEFORE UPDATE ON replay.events
    FOR EACH ROW EXECUTE FUNCTION replay.immutable_row();
CREATE OR REPLACE TRIGGER replay_events_no_delete
    BEFORE DELETE ON replay.events
    FOR EACH ROW EXECUTE FUNCTION replay.immutable_row();
CREATE OR REPLACE TRIGGER replay_events_no_truncate
    BEFORE TRUNCATE ON replay.events
    FOR EACH STATEMENT EXECUTE FUNCTION replay.immutable_row();
CREATE OR REPLACE TRIGGER publication_intents_no_update
    BEFORE UPDATE OR DELETE ON replay.publication_intents
    FOR EACH ROW EXECUTE FUNCTION replay.immutable_row();
CREATE OR REPLACE TRIGGER delivery_attempts_no_update
    BEFORE UPDATE OR DELETE ON replay.delivery_attempts
    FOR EACH ROW EXECUTE FUNCTION replay.immutable_row();

CREATE OR REPLACE FUNCTION replay.stream_binding_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.replay_id <> OLD.replay_id
       OR NEW.request_hash <> OLD.request_hash
       OR NEW.source <> OLD.source
       OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'replay request binding is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER stream_binding_no_update
    BEFORE UPDATE ON replay.streams
    FOR EACH ROW EXECUTE FUNCTION replay.stream_binding_immutable();

CREATE OR REPLACE FUNCTION replay.wake() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('replay_events', NEW.replay_id::text);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER replay_event_wakeup
    AFTER INSERT ON replay.events
    FOR EACH ROW EXECUTE FUNCTION replay.wake();
