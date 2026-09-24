import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { confirmationFromEnv, confirmTokenParam, requireConfirmationWithFallback } from '@chrischall/mcp-utils';

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
 * bound to this tool, the target, its revision and the exact payload, is
 * single-use and expires (`MCP_CONFIRM_TTL_SECONDS`).
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
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: opts.action,
      message: opts.message,
      details: opts.preview,
      unsupportedNote: 'Complete this action on ourfamilywizard.com instead.',
      tool: opts.tool,
      confirmToken: opts.confirmToken,
      subject: () => ({
        target: opts.target,
        ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
        payload: opts.payload,
        preview: opts.preview,
      }),
    }),
  );
}
