-- 0021: keep the txd seat lifecycle on its closed v12 vocabulary.
--
-- A seat whose history carries an unrecognized seat-level terminal is not a
-- partial current entity. Remove the entity's complete history so replay has
-- the same result as an estate in which that abandoned dynamic seat never
-- existed. Current seat terminals are cleared (binding survives as a bare
-- canonical pane) or abandoned (the dynamic pane and its history are absent).

ALTER TABLE txd.events DISABLE TRIGGER events_no_delete;

DELETE FROM txd.events
WHERE entity_type = 'seat'
  AND entity_id IN (
  SELECT DISTINCT entity_id
  FROM txd.events
  WHERE entity_type = 'seat'
    AND event_type LIKE 'reg.seat\_%' ESCAPE '\'
    AND event_type NOT IN ('reg.seat_cleared', 'reg.seat_abandoned')
);

ALTER TABLE txd.events ENABLE TRIGGER events_no_delete;
