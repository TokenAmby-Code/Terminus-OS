-- 0004: the central event bus — journal + subscriptions + cursors (`bus` schema).
--
-- Postgres-as-bus, transactional-outbox shape: ONE append-only journal
-- (`bus.events`, single writer: busd), a config table deciding who receives
-- what (`bus.subscriptions`, SQL LIKE pattern over event_type), and one durable
-- delivery cursor per subscriber (`bus.cursors`). DB triggers do NOT deliver;
-- busd reads `seq > acked_seq` per subscription and fans out over HTTP.
--
-- The journal is `txd.events`'s sibling idiom (0002): seq identity PK, jsonb
-- facts, occurred_at/recorded_at stored VERBATIM as attested ISO-8601 strings,
-- and append-only STRUCTURALLY — triggers raise on UPDATE/DELETE/TRUNCATE.
--
-- Cursors are deliberately NOT auto-seeded: a new subscriber's first cursor row
-- is an explicit runbook step (0 = full replay, max(seq) = from-now). busd
-- skips-loud any active subscription without a cursor.
--
-- Idempotent DDL throughout: integration lanes reset the migration ledger, so
-- re-application over an existing schema must converge, not collide.

CREATE SCHEMA IF NOT EXISTS bus;

CREATE TABLE IF NOT EXISTS bus.events (
    seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type   text   NOT NULL,
    source       text   NOT NULL,
    payload      jsonb  NOT NULL,
    provenance   jsonb  NOT NULL,
    occurred_at  text   NOT NULL,
    recorded_at  text   NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bus_events_type ON bus.events (event_type, seq);

CREATE OR REPLACE FUNCTION bus.events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'bus.events is append-only: % forbidden', TG_OP;
END;
$$;

CREATE OR REPLACE TRIGGER events_no_update
    BEFORE UPDATE ON bus.events
    FOR EACH ROW EXECUTE FUNCTION bus.events_immutable();

CREATE OR REPLACE TRIGGER events_no_delete
    BEFORE DELETE ON bus.events
    FOR EACH ROW EXECUTE FUNCTION bus.events_immutable();

CREATE OR REPLACE TRIGGER events_no_truncate
    BEFORE TRUNCATE ON bus.events
    FOR EACH STATEMENT EXECUTE FUNCTION bus.events_immutable();

-- Who receives what. `event_pattern` is a SQL LIKE pattern over event_type —
-- matching lives in busd's delivery query, so psql behaves identically.
CREATE TABLE IF NOT EXISTS bus.subscriptions (
    name          text    PRIMARY KEY,
    delivery_url  text    NOT NULL,
    event_pattern text    NOT NULL,
    active        boolean NOT NULL DEFAULT true
);

-- Durable per-subscriber delivery progress. `acked_seq` only ever advances
-- (busd upserts with a monotonic guard); restart = retry from here.
CREATE TABLE IF NOT EXISTS bus.cursors (
    subscription_name text        PRIMARY KEY REFERENCES bus.subscriptions (name),
    acked_seq         bigint      NOT NULL,
    advanced_at       timestamptz NOT NULL DEFAULT now()
);

-- Operational lag per subscription — served by busd /ctl/health AND readable
-- directly in psql. An unseeded cursor shows its full matching backlog.
CREATE OR REPLACE VIEW bus.lag AS
SELECT s.name,
       s.active,
       s.event_pattern,
       c.acked_seq,
       (SELECT count(*)
          FROM bus.events e
         WHERE e.seq > coalesce(c.acked_seq, 0)
           AND e.event_type LIKE s.event_pattern) AS lag
  FROM bus.subscriptions s
  LEFT JOIN bus.cursors c ON c.subscription_name = s.name;
