import { vi } from 'vitest';

/**
 * Test-side drivers for the confirm gate (`src/tools/_confirm.ts`).
 *
 * A ServerContext for a caller that declares NO elicitation capability — the
 * claude.ai shape, measured — which under the default MCP_CONFIRM_MODE=ask-user
 * gets the two-phase confirm-token flow: phase 1 returns a preview plus a
 * token and performs no write; only the repeat call carrying the token acts.
 */
export const NO_ELICIT_CTX = {
  mcpReq: {
    envelope: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  },
};

/** A caller that CAN be prompted (form elicitation) — gets the real prompt. */
export const CAN_ASK_CTX = {
  mcpReq: {
    envelope: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
    },
  },
};

export interface ToolResultLike {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  resultType?: string;
}

export type GatedHandler = (args: Record<string, unknown>, ctx?: unknown) => Promise<ToolResultLike>;

export interface PhaseOne {
  status: 'confirmation-required';
  confirmToken: string;
  preview: Record<string, unknown>;
  action: string;
  instruction: string;
}

/** Phase 1 only: the preview a gated tool returns without writing. */
export async function callPreview(handler: GatedHandler, args: Record<string, unknown>): Promise<PhaseOne> {
  const result = await handler(args, NO_ELICIT_CTX);
  const text = result.content[0]?.text ?? '';
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(text) as { status?: string };
  } catch {
    throw new Error(`expected a confirmation preview, got non-JSON: ${text.slice(0, 300)}`);
  }
  if (parsed.status !== 'confirmation-required') {
    throw new Error(`expected a confirmation preview, got ${text.slice(0, 500)}`);
  }
  return parsed as PhaseOne;
}

/**
 * Drive a gated tool through both phases — preview, then the repeat call with
 * its confirmToken — and return the phase-2 result. Mock call HISTORY is
 * cleared between the phases (queued once-implementations are kept), so
 * assertions see only what the confirmed call did. Pass `clearMocks:false`
 * to keep the phase-1 history.
 */
export async function callConfirmed(
  handler: GatedHandler,
  args: Record<string, unknown>,
  opts: { clearMocks?: boolean } = {},
): Promise<ToolResultLike> {
  const { confirmToken } = await callPreview(handler, args);
  if (opts.clearMocks ?? true) vi.clearAllMocks();
  return handler({ ...args, confirmToken }, NO_ELICIT_CTX);
}
