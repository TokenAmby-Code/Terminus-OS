-- 0005: normalize double-encoded jsonb rows in txd.events.
--
-- txd-store used to bind `JSON.stringify(x)::jsonb`, handing Bun.SQL an
-- already-JSON-encoded parameter: the cast stored payload/provenance as jsonb
-- *strings*, so the ruled psql surface (payload->>'k') returned nothing on
-- those rows. The store now binds objects directly (mirroring the busd #34
-- fix, af8088e9); this migration casts the historical string rows to real
-- objects in place.
--
-- txd.events is STRUCTURALLY append-only (0002 triggers raise on UPDATE), so
-- the update trigger is disabled for exactly these statements — inside the
-- migration transaction, re-enabled before it commits, with the advisory
-- migration lock held throughout.
--
-- Idempotent: the jsonb_typeof(...) = 'string' guards make a re-run (or
-- re-application over an already-normalized schema) a no-op.

ALTER TABLE txd.events DISABLE TRIGGER events_no_update;

UPDATE txd.events
   SET payload = (payload #>> '{}')::jsonb
 WHERE jsonb_typeof(payload) = 'string';

UPDATE txd.events
   SET provenance = (provenance #>> '{}')::jsonb
 WHERE jsonb_typeof(provenance) = 'string';

ALTER TABLE txd.events ENABLE TRIGGER events_no_update;
