-- Typed desktop observations from the WSL operator-input machine. The table is
-- append-only event truth; enforcement consumers subscribe to the PostgreSQL
-- notification emitted by each first-seen event.

CREATE SCHEMA IF NOT EXISTS telemetry;

CREATE TABLE IF NOT EXISTS telemetry.desktop_events (
    seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id     uuid        NOT NULL UNIQUE,
    observed_at  timestamptz NOT NULL,
    recorded_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    machine      text        NOT NULL CHECK (machine = 'wsl'),
    activity     text        NOT NULL CHECK (activity IN ('silence', 'music', 'video', 'gaming', 'meeting')),
    application  text        NOT NULL CHECK (application IN ('none', 'spotify', 'brave', 'steam', 'zoom')),
    payload      jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_desktop_events_observed ON telemetry.desktop_events (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_desktop_events_activity ON telemetry.desktop_events (activity, observed_at DESC);

CREATE OR REPLACE FUNCTION telemetry.desktop_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'telemetry.desktop_events is append-only: % forbidden', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER desktop_events_no_update
    BEFORE UPDATE ON telemetry.desktop_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.desktop_events_immutable();

CREATE OR REPLACE TRIGGER desktop_events_no_delete
    BEFORE DELETE ON telemetry.desktop_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.desktop_events_immutable();

CREATE OR REPLACE TRIGGER desktop_events_no_truncate
    BEFORE TRUNCATE ON telemetry.desktop_events
    FOR EACH STATEMENT EXECUTE FUNCTION telemetry.desktop_events_immutable();

CREATE OR REPLACE FUNCTION telemetry.publish_desktop_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('desktop_telemetry', NEW.payload::text);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER desktop_events_publish
    AFTER INSERT ON telemetry.desktop_events
    FOR EACH ROW EXECUTE FUNCTION telemetry.publish_desktop_event();
