-- Current-authority repair: classify the immutable first event once and keep
-- terminal state beside the stream so startup work is an indexed local query,
-- never a correlated scan over all replay history.
ALTER TABLE replay.streams
    ADD COLUMN first_event_type text,
    ADD COLUMN machine text,
    ADD COLUMN terminal boolean NOT NULL DEFAULT false;

UPDATE replay.streams AS s
SET first_event_type = first.event_type,
    machine = first.provenance->>'machine',
    terminal = EXISTS (
      SELECT 1 FROM replay.events AS terminal
      WHERE terminal.replay_id = s.replay_id
        AND terminal.payload @> '{"terminal":true}'::jsonb
    )
FROM replay.events AS first
WHERE first.replay_id = s.replay_id
  AND first.sequence = 1;

ALTER TABLE replay.streams
    ALTER COLUMN first_event_type SET NOT NULL,
    ALTER COLUMN machine SET NOT NULL,
    ADD CONSTRAINT replay_first_event_type_nonempty CHECK (first_event_type <> ''),
    ADD CONSTRAINT replay_machine_nonempty CHECK (machine <> '');

CREATE INDEX replay_open_commands_by_machine
    ON replay.streams (source, machine, replay_id)
    WHERE terminal = false
      AND first_event_type LIKE '%.command_accepted';

CREATE INDEX replay_open_non_operations_by_machine
    ON replay.streams (source, machine, replay_id)
    WHERE terminal = false
      AND first_event_type NOT LIKE '%.command_accepted';

CREATE OR REPLACE FUNCTION replay.stream_binding_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.replay_id <> OLD.replay_id
       OR NEW.request_hash <> OLD.request_hash
       OR NEW.source <> OLD.source
       OR NEW.first_event_type <> OLD.first_event_type
       OR NEW.machine <> OLD.machine
       OR NEW.created_at <> OLD.created_at
       OR (OLD.terminal AND NOT NEW.terminal) THEN
        RAISE EXCEPTION 'replay request binding is immutable';
    END IF;
    RETURN NEW;
END;
$$;
