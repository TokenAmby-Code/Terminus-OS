-- 0001: the migration ledger itself. Forward-only; rows are append-only facts.
-- The runner records each applied migration inside the same transaction that
-- applied it, so 0001's own ledger row lands atomically with this CREATE.
CREATE TABLE schema_migrations (
    id         integer     PRIMARY KEY,
    name       text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
