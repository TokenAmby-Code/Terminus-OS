-- Bun.SQL binds JavaScript objects as jsonb directly. Refuse the historical
-- double-encoding idiom for every future hook while retaining the immutable
-- pre-constraint row as loud evidence of the defect that forced this guard.

ALTER TABLE telemetry.phone_hooks
    ADD CONSTRAINT phone_hooks_payload_object
    CHECK (jsonb_typeof(payload) = 'object') NOT VALID;
