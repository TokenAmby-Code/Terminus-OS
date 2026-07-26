CREATE OR REPLACE TRIGGER replay_streams_no_delete
    BEFORE DELETE ON replay.streams
    FOR EACH ROW EXECUTE FUNCTION replay.immutable_row();
CREATE OR REPLACE TRIGGER replay_streams_no_truncate
    BEFORE TRUNCATE ON replay.streams
    FOR EACH STATEMENT EXECUTE FUNCTION replay.immutable_row();
CREATE OR REPLACE TRIGGER publication_intents_no_truncate
    BEFORE TRUNCATE ON replay.publication_intents
    FOR EACH STATEMENT EXECUTE FUNCTION replay.immutable_row();
CREATE OR REPLACE TRIGGER delivery_attempts_no_truncate
    BEFORE TRUNCATE ON replay.delivery_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION replay.immutable_row();
