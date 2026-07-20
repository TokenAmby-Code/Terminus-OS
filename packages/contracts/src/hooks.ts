// Vendor hook-type enumeration (`@terminus-os/contracts`).
//
// RULED cross-service architecture invariant ([[txd-extraction-spec]] §6): any
// service that accepts hooks accepts them through `/ingress/hooks/*`, and any
// service exposing that path MUST have an endpoint for every single hook type —
// unused ones quick-return 410 Gone. The per-box proxy broadcasts every inbound
// hook to ALL declared hook consumers and ignores 410s (§3.6); the 410
// invariant is what makes unconditional broadcast safe.
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
// a vendor contract adds an event: additions here are additive (new 410
// endpoints), never breaking.

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

// The exact quick-return body for a hook type a service does not consume.
// Status is 410 Gone; the handler MUST be side-effect-free by construction.
export const HookNotConsumedSchema = z.object({
  ok: z.literal(false),
  error: z.literal("hook_not_consumed"),
  hook_type: HookTypeSchema,
});
export type HookNotConsumed = z.infer<typeof HookNotConsumedSchema>;
