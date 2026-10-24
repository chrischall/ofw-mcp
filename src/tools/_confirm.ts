import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { confirmationFromEnv, confirmTokenParam, requireConfirmationWithFallback } from '@chrischall/mcp-utils';
import { fnv1a64 } from './draft-freshness.js';

export { confirmTokenParam };

/** The sentence every confirm-gated tool's description ends with. */
export const CONFIRM_NOTE =
  'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call '
  + 'performs NO write and returns a preview of exactly what would happen plus a confirmToken, and only a repeat '
  + 'call with that token proceeds (see MCP_CONFIRM_MODE).';

export interface ConfirmWriteOptions {
  /** The tool name the token is bound to; a token never crosses tools. */
  tool: string;
  /** `ofw.<entity>.<verb>` action id. */
  action: string;
  /** Prompt text shown above the preview on a client that can be asked. */
  message: string;
  /** The primary id acted on (`draft:42`, `event:7`, `expense:new`). */
  target: string;
  /**
   * A version of the target that rotates when it is edited — a draft's content
   * revision, a hash of the event as last read. Bound into the token so a
   * phase-2 call against a target the co-parent changed in between is refused
   * as DRAFT_CHANGED instead of acting on a version nobody approved. Omit when
   * the target has no prior state (a create).
   */
  revision?: string;
  /** Exactly what the write will send; its hash is bound into the token. */
  payload: unknown;
  /**
   * What the user sees. Human-readable: names, subjects, amounts, dates —
   * never only numeric ids. Included in the elicitation prompt too.
   */
  preview: Record<string, unknown>;
  /**
   * The tool's validated arguments exactly as the handler received them
   * (`confirmToken` is dropped before hashing). Bound into both the token and
   * the elicitation acceptance, so an approval for one set of arguments cannot
   * authorise another.
   */
  args: object;
  /** The phase-2 token from the tool's input, or undefined on phase 1. */
  confirmToken: string | undefined;
}

/**
 * Confirm-gate for a write that reaches the co-parent or the court-visible
 * record. A client that can show a confirmation prompt is asked; one that
 * cannot (claude.ai, Claude Desktop — measured in mcp-utils
 * docs/CLIENT-BEHAVIOUR.md) gets the two-phase token flow governed by
 * `MCP_CONFIRM_MODE`: phase 1 performs no write and returns the preview plus a
 * `confirmToken`; only a repeat call with that token proceeds. The token is
 * bound to this tool/action, the target, its revision, exact payload, preview
 * and caller arguments on BOTH rails. The fallback token is single-use and
 * expires (`MCP_CONFIRM_TTL_SECONDS`); elicitation state uses the same TTL.
 * Outstanding approvals minted before this binding change must be renewed.
 *
 * Call it on EVERY invocation with the freshly-built payload and a freshly
 * read revision — the caller's own re-read is what makes a stale token fail.
 * `OFW_WRITE_MODE` stays the structural layer underneath: a tool this gate
 * protects is still not registered at all below its write mode.
 *
 * Returns `undefined` to proceed with the write, otherwise the result to
 * return unchanged.
 */
export function confirmWrite(
  ctx: ServerContext,
  opts: ConfirmWriteOptions,
): Promise<InputRequiredResult | CallToolResult | undefined> {
  // mcp-utils binds elicitation acceptance to args, NOT subject(). Carry the
  // effective approval state into both rails; caller args alone omit fields
  // inherited from fresh reads. Strip the phase-2 token before nesting args
  // (the helper only strips a top-level confirmToken).
  const { confirmToken: _confirmToken, ...args } = opts.args as { confirmToken?: unknown };
  const subject = {
    target: opts.target,
    ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
    payload: opts.payload,
    preview: opts.preview,
  };
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: opts.action,
      message: opts.message,
      details: opts.preview,
      unsupportedNote: 'Complete this action on ourfamilywizard.com instead.',
      tool: opts.tool,
      // One OFW account per process (OFW_USERNAME / the captured session), so
      // there is no principal to distinguish; mcp-utils 3 makes saying so explicit.
      account: undefined,
      args: { tool: opts.tool, action: opts.action, args, ...subject },
      confirmToken: opts.confirmToken,
      subject: () => subject,
    }),
  );
}

/**
 * A revision string for a target as just read from OFW (an event detail), for
 * `ConfirmWriteOptions.revision`. Any change to the value rotates it, so a
 * token minted against one state cannot act on another.
 */
export function stateRevision(value: unknown): string {
  return `s1:${fnv1a64(JSON.stringify(value))}`;
}
