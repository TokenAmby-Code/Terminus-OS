-- replay.events.causation_event_id carries a self-referencing foreign key, and
-- PostgreSQL verifies that reference on every delete from the table: for each
-- removed row it must prove no surviving row still cites it. Unindexed, that
-- proof is a sequential scan of the whole table, once per deleted row.
--
-- Terminal-stream pruning is the path that pays it. On the estate this index
-- was written for, a prune deletes ~193k events out of ~288k, and one such
-- scan measures ~28ms — about an hour and a half of integrity checking for a
-- single sanctioned prune, which is why the verb could not complete at all.
--
-- The index is partial because roughly a third of the table has no causation
-- at all, and a NULL never satisfies the check that forces the scan.
CREATE INDEX IF NOT EXISTS replay_events_causation
    ON replay.events (causation_event_id)
    WHERE causation_event_id IS NOT NULL;
