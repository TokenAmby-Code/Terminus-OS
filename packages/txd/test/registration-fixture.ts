import type { LaunchRequest } from '@terminus-os/contracts';

export function registration(seat_id: string, instance_id = 'i1', persona_id = 'salamander'): LaunchRequest {
  return {
    schema_version: 5,
    seat_id,
    instance_id,
    wrapper_id: `wrapper:${instance_id}`,
    engine: 'codex',
    persona_id,
    rank: 'astartes',
    commander_type: 'emperor',
    commander_id: null,
    singleton_authority: false,
    dispatch_authority: 'imperium',
    session_doc_id: 1,
    device_id: 'k12-personal',
    working_dir: '/srv/terminus-os',
    origin_type: 'dispatch',
    execution_placement: 'k12-personal:tmux',
  };
}

export function registrationTuple(instance_id = 'i1', persona_id = 'salamander'): Omit<LaunchRequest, 'seat_id'> {
  const { seat_id: _seat, ...tuple } = registration('fixture', instance_id, persona_id);
  return tuple;
}
