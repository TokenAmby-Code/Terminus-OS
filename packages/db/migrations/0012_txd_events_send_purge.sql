-- 0012: purge the act.send_* rows from txd.events.
--
-- The event vocabulary (`@terminus-os/contracts`) no longer contains the
-- act.send_* lifecycle or the `send` entity, and txd's replay boundary
-- (EventRecordSchema) refuses any row outside the pinned vocabulary — these
-- rows must not exist for the daemon to boot from its own store.
--
-- Surgical by construction: exactly the enumerated event types are deleted;
-- no other row is touched and `seq` values are never renumbered (identity
-- column — the gap is data). txd.events is STRUCTURALLY append-only (0002
-- triggers raise on DELETE), so the delete trigger is disabled for exactly
-- this statement — inside the migration transaction, re-enabled before it
-- commits, with the advisory migration lock held throughout (the 0005
-- precedent).
--
-- Idempotent: a re-run (or re-application over an already-purged store)
-- matches zero rows and is a no-op.

ALTER TABLE txd.events DISABLE TRIGGER events_no_delete;

DELETE FROM txd.events
 WHERE event_type IN (
   'act.send_enqueued',
   'act.send_gated',
   'act.send_submit_observed',
   'act.send_delivered',
   'act.send_cancelled'
 );

ALTER TABLE txd.events ENABLE TRIGGER events_no_delete;
