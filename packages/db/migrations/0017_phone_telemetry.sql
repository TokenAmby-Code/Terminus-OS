-- Passive phone hooks admitted by telemetryd. This stream is append-only and
-- intentionally independent of the typed Windows desktop observation table.

CREATE TABLE IF NOT EXISTS telemetry.phone_hooks (
    seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hook_id      uuid        NOT NULL UNIQUE,
    occurred_at  timestamptz NOT NULL,
    recorded_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    event_type   text        NOT NULL CHECK (event_type IN (
        'phone.application',
        'phone.spotify',
        'phone.youtube',
        'phone.geofence',
        'phone.proxy_egress_macro_probe'
    )),
    source       text        NOT NULL CHECK (source = 'phone.macrodroid'),
    payload      jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_phone_hooks_occurred ON telemetry.phone_hooks (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_phone_hooks_type ON telemetry.phone_hooks (event_type, occurred_at DESC);

CREATE OR REPLACE FUNCTION telemetry.phone_hooks_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'telemetry.phone_hooks is append-only: % forbidden', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER phone_hooks_no_update
    BEFORE UPDATE ON telemetry.phone_hooks
    FOR EACH ROW EXECUTE FUNCTION telemetry.phone_hooks_immutable();

CREATE OR REPLACE TRIGGER phone_hooks_no_delete
    BEFORE DELETE ON telemetry.phone_hooks
    FOR EACH ROW EXECUTE FUNCTION telemetry.phone_hooks_immutable();

CREATE OR REPLACE TRIGGER phone_hooks_no_truncate
    BEFORE TRUNCATE ON telemetry.phone_hooks
    FOR EACH STATEMENT EXECUTE FUNCTION telemetry.phone_hooks_immutable();
