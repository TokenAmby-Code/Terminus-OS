// Vendor hook-type enumeration (`@terminus-os/contracts`).
//
// Vendor hook-type enumeration. Hooks are not events: consumers select the
// facts that matter and append those facts directly to the journal. This list
// pins only the vendor ingress vocabulary shared by wrappers and consumers.
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
// a vendor contract adds an event.

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

// The vendor `/ingress/hooks/<type>` route ids, snake_cased and enumerated
// literally so the type stays a narrow literal union.
export const VENDOR_HOOK_TYPES = [
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

// Fleet lifecycle sources enter through the same content-agnostic hook door.
// They are not vendor hooks and never pretend to be transcript events.
export const FLEET_HOOK_TYPES = [
  "wrapper_start",
  "wrapper_stop",
] as const;

export const HOOK_TYPES = [
  ...VENDOR_HOOK_TYPES,
  ...FLEET_HOOK_TYPES,
] as const;
export type HookType = (typeof HOOK_TYPES)[number];
export const HookTypeSchema = z.enum(HOOK_TYPES);
