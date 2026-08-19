-- The txd event stream admits exactly the event types the contracts define.
-- Boot replay validates every stored row against that union, so a row whose
-- emitter no longer exists refuses the whole stream and the daemon cannot
-- start. Delete every row outside the admitted set. The append-only fence
-- drops only for this surgical delete, exactly as 0014 did for bus.events.

ALTER TABLE txd.events DISABLE TRIGGER events_no_delete;

DELETE FROM txd.events
 WHERE event_type NOT IN (
   'reg.dispatch_requested',
   'reg.launch_composed',
   'reg.transport_claimed',
   'reg.pane_created',
   'reg.wrapper_started',
   'reg.physical_declared',
   'reg.placement_attested',
   'reg.agent_registered',
   'reg.binding_prepared',
   'reg.binding_aborted',
   'reg.bound',
   'reg.comm_accepted',
   'reg.comm_target_snapshotted',
   'reg.composer_observation_prepared',
   'reg.contradiction_flagged',
   'reg.teardown_started',
   'reg.process_reaped',
   'reg.retired',
   'reg.seat_cleared',
   'reg.seat_abandoned',
   'act.prompt_submitted',
   'act.stop_reported',
   'act.receipt_deduped',
   'act.comm_bytes_sent',
   'act.agent_input_injected',
   'act.comm_delivery_asserted',
   'act.comm_delivery_confirmation_dead_lettered',
   'act.comm_delivery_failed',
   'act.comm_submit_driven',
   'act.comm_watch_unarmed',
   'act.composer_interactive_announced',
   'act.comm_callback_asserted',
   'act.mode_transition_requested',
   'act.mode_transition_attested',
   'act.mode_transition_failed',
   'estate.rotation_refused',
   'estate.rotation_requested',
   'estate.rotation_completed',
   'estate.scoped_reset_refused',
   'estate.scoped_reset_requested',
   'estate.scoped_reset_completed',
   'estate.scoped_reset_failed'
 );

ALTER TABLE txd.events ENABLE TRIGGER events_no_delete;
