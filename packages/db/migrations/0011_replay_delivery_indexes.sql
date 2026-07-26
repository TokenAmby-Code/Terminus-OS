-- Replace the 0008 timestamp cast with an actually immutable lexical
-- validator. A text-to-timestamptz cast depends on session settings and cannot
-- truthfully back an IMMUTABLE check function.
CREATE OR REPLACE FUNCTION replay.is_timestamptz(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
    IF value !~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' THEN
        RETURN false;
    END IF;
    PERFORM make_date(
        substring(value FROM 1 FOR 4)::integer,
        substring(value FROM 6 FOR 2)::integer,
        substring(value FROM 9 FOR 2)::integer
    );
    RETURN true;
EXCEPTION WHEN datetime_field_overflow THEN
    RETURN false;
END;
$$;

-- Projection and delivery reconciliation ask whether an exact
-- event/subscription pair has ever succeeded. Failed attempts remain durable
-- history but do not belong in that existence index.
CREATE INDEX IF NOT EXISTS replay_delivery_attempts_success
    ON replay.delivery_attempts (event_id, subscription_name)
    WHERE succeeded;
