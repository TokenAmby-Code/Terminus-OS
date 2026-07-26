-- 0010: identify subscription rows reconciled from daemon configuration.
--
-- Operator-created subscriptions remain outside this table and are never
-- deactivated by configuration convergence.
CREATE TABLE IF NOT EXISTS bus.managed_subscriptions (
    subscription_name text PRIMARY KEY REFERENCES bus.subscriptions (name)
);
