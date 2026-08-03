-- Purge the two per-tool hook event types from the bus journal.
-- The event sources no longer emit either type. The delete remains surgical:
-- adjacent hook events survive and sequence gaps are retained.

ALTER TABLE bus.events DISABLE TRIGGER events_no_delete;

DELETE FROM bus.events
 WHERE event_type IN (
   'hook.pre_tool_use',
   'hook.post_tool_use'
 );

ALTER TABLE bus.events ENABLE TRIGGER events_no_delete;
