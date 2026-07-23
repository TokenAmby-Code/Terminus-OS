// Vendor hook-type enumeration (`@terminus-os/contracts`).
//
// RULED cross-service architecture invariant (central-bus ruling, supersedes
// [[txd-extraction-spec]] §6's per-consumer fan-out): hook fan-in TERMINATES at
// busd. The per-box proxy broadcasts every inbound `/ingress/hooks/*` POST to
// its declared hook consumers — on the ruled topology exactly one, busd — and
// busd journals EVERY pinned vendor hook type as a `hook.<type>` bus event
// (see bus.ts). No hook type evaporates: there is no 410 tail anywhere, so the
// old HookNotConsumed vocabulary is dead. Services that care about a hook
// (txd: stop / user_prompt_submit) consume it as a normal bus subscriber and
// MUST 2xx-ack delivered events they do not consume (ack ≠ consume).
//
// The enumeration below is PINNED from the actual vendor hook contracts — not
// invented. Sources (verbatim enum extractions from the shipped binaries):
//   - claude-code 2.1.215 — 30 hook events:
//     PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification,
//     UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop,
//     StopFailure, SubagentStart, SubagentStop, PreCompact, PostCompact,
//     PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated,
//     TaskCompleted, Elicitation, ElicitationResult, ConfigChange,
//     WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged,
//     FileChanged, MessageDisplay
//   - codex-cli 0.144.6 — 10 hook events (a strict SUBSET of the claude set):
//     PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact,
//     SessionStart, UserPromptSubmit, SubagentStart, SubagentStop, Stop
//
// Route ids are the snake_case forms (codex's own wire encoding; lowercase URL
// segments). The union is therefore the 30 claude events. Re-pin this list when
// a vendor contract adds an event: additions here are additive (a new busd
// shim endpoint + `hook.<type>` journal id), never breaking.

import { z } from "zod";

export const CLAUDE_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "MessageDisplay",
] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

export const CODEX_HOOK_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
] as const;
export type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];

// The `/ingress/hooks/<type>` route ids — the vendor union, snake_cased,
// enumerated literally so the type stays a narrow literal union and stays
// greppable (the EVENT_TYPES pattern).
export const HOOK_TYPES = [
  "pre_tool_use",
  "post_tool_use",
  "post_tool_use_failure",
  "post_tool_batch",
  "notification",
  "user_prompt_submit",
  "user_prompt_expansion",
  "session_start",
  "session_end",
  "stop",
  "stop_failure",
  "subagent_start",
  "subagent_stop",
  "pre_compact",
  "post_compact",
  "permission_request",
  "permission_denied",
  "setup",
  "teammate_idle",
  "task_created",
  "task_completed",
  "elicitation",
  "elicitation_result",
  "config_change",
  "worktree_create",
  "worktree_remove",
  "instructions_loaded",
  "cwd_changed",
  "file_changed",
  "message_display",
] as const;
export type HookType = (typeof HOOK_TYPES)[number];
export const HookTypeSchema = z.enum(HOOK_TYPES);
