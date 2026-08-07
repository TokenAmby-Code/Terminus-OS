-- Remove event paths with no owner. Historical replay delivery attempts keep
-- their subscription-name evidence without retaining live routing rows.

DROP TRIGGER IF EXISTS desktop_events_publish ON telemetry.desktop_events;
DROP FUNCTION IF EXISTS telemetry.publish_desktop_event();

ALTER TABLE replay.delivery_attempts
    DROP CONSTRAINT IF EXISTS delivery_attempts_subscription_name_fkey;

DELETE FROM bus.managed_subscriptions
WHERE subscription_name IN (
    'daily-note-create-work',
    'deployment-personal-github-push',
    'deployment-work-github-push',
    'githubd-deployment',
    'githubd-fleet',
    'githubd-work-battlefield',
    'githubd-work-coderabbit',
    'githubd-work-deployment',
    'githubd-work-github',
    'githubd-work-policy',
    'probe',
    'txd-k12-personal-hook-session-start'
);

DELETE FROM bus.cursors
WHERE subscription_name IN (
    'daily-note-create-work',
    'deployment-personal-github-push',
    'deployment-work-github-push',
    'githubd-deployment',
    'githubd-fleet',
    'githubd-work-battlefield',
    'githubd-work-coderabbit',
    'githubd-work-deployment',
    'githubd-work-github',
    'githubd-work-policy',
    'probe',
    'txd-k12-personal-hook-session-start'
);

DELETE FROM bus.subscriptions
WHERE name IN (
    'daily-note-create-work',
    'deployment-personal-github-push',
    'deployment-work-github-push',
    'githubd-deployment',
    'githubd-fleet',
    'githubd-work-battlefield',
    'githubd-work-coderabbit',
    'githubd-work-deployment',
    'githubd-work-github',
    'githubd-work-policy',
    'probe',
    'txd-k12-personal-hook-session-start'
);
