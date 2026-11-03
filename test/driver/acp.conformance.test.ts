// The acp driver instantiation — T1.8.
//
// Two layers, mirroring test/driver/subprocess.test.ts:
//   1. THE CONFORMANCE SUITE (test/driver/conformance.ts, verbatim) run
//      against the real AcpDriver spawning the FAKE ACP server
//      (test/fixtures/fake-acp-server.mjs) through the driver's spawn
//      seam — a REAL process speaking the REAL wire shapes (nested
//      session/update payloads, configOptions model reporting with the
//      lazy-vs-materialized split, kind-based permission options with
//      vendor-string optionIds, PromptResponse usage). No vendor binary,
//      no network, no @agentclientprotocol/sdk.
//   2. DRIVER-SPECIFIC tests: the absent-binary pre-dispatch throw (§3),
//      the unknown-endpoint + unknown-sessionRef throws, THE PERMISSION
//      ANSWER-TABLE legs (allow selects allow_once; the allow_always
//      fallback when only allow_always is offered; reject selects
//      reject_once by vendor-string optionId; a deny with no reject
//      option AND an allow with no allow option each fail the run,
//      narrating WHICH side failed — and the selection failure pins the
//      verdict 'error' even when a termination-tolerant vendor settles
//      end_turn past it), the never-asks tripwire, the probe-recorded
//      placeholder permission card (never mistaken for the tool
//      execution — the run stays a clean complete), the
//      replay window (bait-before-response discarded; a post-load frame
//      sharing the response's stdout flush FOLDS — the line-level gate),
//      the THREE-RUNG resume gate (session/load → unstable_resumeSession
//      → the honest partial, narrated), served-model surfacing + the
//      FAKE_ACP_SERVED_MODEL mismatch demonstration (the observed-model
//      check catches it — the subprocess remap test's framing), usage
//      mapping (fixed numbers → the DERIVED input, the wire's inputTokens
//      being INCLUSIVE of the cached tokens — no reasoning field), the
//      stdout frame-straddle leg (a ~20k-char frame split across flushes
//      survives the line buffer — frames are the data), the resume sidecar
//      discipline, cancel → 'aborted' over the governed signal, the
//      attach-time abort recheck (a deadline firing before the listener
//      attach still cancels the child — abort events are not replayed),
//      the mode-pin observability, the protocol-version mismatch verdict,
//      and the prompt-directed-JSON §2.3 verdict — plus the round-4 Codex
//      legs: a cancel write STALLED behind a wedged prompt cannot gate the
//      kill (the bounded grace starts the ladder — the decided kill never
//      depends on the cooperation of the thing being killed), and a tool
//      result reported via content blocks (no rawOutput) lands in the
//      record output and in the denial reason (textOfContent-style
//      extraction). Plus the review-debt sweep legs: the mode pin must be CONFIRMED by the
//      response echo (#39), the denied-execution tripwire (#45), a
//      structured rawOutput folds at the protocol boundary (#49), an
//      oversized frame fails the connection (#42), relative PATH entries
//      resolve absolute (#46), and win32 PATHEXT candidates (#40).

import { describe, expect, test } from 'vitest';
import { AcpDriver } from '../../src/driver/acp/index.js';
import { fakeAcpSpawn, runFakeTool } from '../helpers/transport-fakes.js';
import type { JsonLineFrame, JsonLinePeer } from '../helpers/transport-fakes.js';
import { runDriverConformance } from '../../src/driver/conformance.js';
import type { ConformanceSpec, ModelDirective } from '../../src/driver/conformance.js';
import { runGovernedAbortLeg } from './conformance-kernel.js';
import type { Driver } from '../../src/driver/types.js';
import { driverOptions } from './acp.helpers.js';

function fakeAcpScript(
  opts: { cwd: string; env: Record<string, string> },
  directive: ModelDirective | undefined,
): (frame: JsonLineFrame, peer: JsonLinePeer) => void {
  const sessionId = 'fake-acp-transport';
  const model = opts.env['FAKE_ACP_MODEL'] ?? 'conformance-1';
  const toolKind = (tool: string): string => {
    if (tool === 'read') return 'read';
    if (tool === 'edit') return 'edit';
    if (tool === 'run') return 'execute';
    return 'other';
  };
  const toolSummary = (input: unknown): string => {
    const value = input as { path?: unknown; command?: unknown };
    if (typeof value.path === 'string') return value.path;
    if (typeof value.command === 'string') return value.command;
    return '(input)';
  };
  let promptId: number | string | undefined;
  let pendingPermission:
    | { id: number; promptId: number | string; tool: string; input: unknown }
    | undefined;
  const update = (peer: JsonLinePeer, value: Record<string, unknown>): void => {
    peer.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
  };
  const respond = (
    peer: JsonLinePeer,
    id: number | string,
    result: Record<string, unknown>,
  ): void => {
    peer.send({ jsonrpc: '2.0', id, result });
  };
  return (frame, peer) => {
    if (
      frame['id'] !== undefined &&
      (frame['result'] !== undefined || frame['error'] !== undefined)
    ) {
      if (pendingPermission?.id === frame['id']) {
        const pending = pendingPermission;
        pendingPermission = undefined;
        const result = frame['result'] as
          | { outcome?: { outcome?: string; optionId?: string } }
          | undefined;
        if (result?.outcome?.outcome !== 'selected' || result.outcome.optionId !== 'allow_once') {
          const optionId = result?.outcome?.optionId ?? 'cancelled';
          update(peer, {
            sessionUpdate: 'tool_call',
            toolCallId: 'fake-transport-tool',
            title: `${pending.tool}: ${toolSummary(pending.input)}`,
            kind: toolKind(pending.tool),
            status: 'in_progress',
            content: [],
            locations: [],
            rawInput: pending.input,
          });
          const rejection = `rejected (${optionId})`;
          update(peer, {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'fake-transport-tool',
            status: 'failed',
            content: [{ type: 'text', text: rejection }],
            rawOutput: rejection,
          });
          update(peer, {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `${directive?.kind === 'tool-then-reply' ? directive.reply : 'done'} [permission:${optionId}]`,
            },
          });
          respond(peer, pending.promptId, {
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 3 },
          });
          peer.finish();
          return;
        }
        void runFakeTool(opts.cwd, pending.tool, pending.input)
          .then((outcome) => {
            update(peer, {
              sessionUpdate: 'tool_call',
              toolCallId: 'fake-transport-tool',
              title: `${pending.tool}: ${toolSummary(pending.input)}`,
              kind: toolKind(pending.tool),
              status: 'in_progress',
              content: [],
              locations: [],
              rawInput: pending.input,
            });
            update(peer, {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'fake-transport-tool',
              status: outcome.ok ? 'completed' : 'failed',
              content: [{ type: 'text', text: outcome.text }],
              ...(outcome.ok ? {} : { rawOutput: outcome.text }),
            });
            update(peer, {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: directive?.kind === 'tool-then-reply' ? directive.reply : 'done',
              },
            });
            respond(peer, pending.promptId, {
              stopReason: 'end_turn',
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                cachedReadTokens: 2,
                cachedWriteTokens: 3,
              },
            });
            peer.finish();
          })
          .catch((error: unknown) => {
            peer.stderr(`fake tool error: ${String(error)}`);
            peer.finish(1);
          });
      }
      return;
    }
    switch (frame['method']) {
      case 'initialize':
        respond(peer, frame['id'] as number, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true },
        });
        return;
      case 'session/new':
        respond(peer, frame['id'] as number, {
          sessionId,
          modes: { currentModeId: 'yolo', availableModes: [{ id: 'build', name: 'Build' }] },
          configOptions: [],
        });
        return;
      case 'session/load':
        respond(peer, frame['id'] as number, {
          sessionId:
            (frame['params'] as { sessionId?: string } | undefined)?.sessionId ?? sessionId,
          modes: { currentModeId: 'build' },
        });
        return;
      case 'session/set_config_option':
        respond(peer, frame['id'] as number, { modes: { currentModeId: 'build' } });
        return;
      case 'session/prompt':
        promptId = frame['id'] as number;
        if (directive?.kind === 'block-until-abort') return;
        if (directive?.kind === 'fail') {
          peer.stderr('simulated hard failure');
          peer.finish(1);
          return;
        }
        // The materialization update rides the prompt flow, as in the real
        // fixture, so the observed-model legs verify response-side folding
        // rather than a pre-prompt echo of the requested model.
        update(peer, {
          sessionUpdate: 'config_option_update',
          configOptions: [
            { id: 'model', category: 'model', type: 'select', currentValue: model, options: [] },
          ],
        });
        if (directive?.kind === 'tool-then-reply') {
          const requestId = 100;
          pendingPermission = {
            id: requestId,
            promptId,
            tool: directive.tool,
            input: directive.input,
          };
          peer.send({
            jsonrpc: '2.0',
            id: requestId,
            method: 'session/request_permission',
            params: {
              sessionId,
              toolCall: {
                toolCallId: 'fake-transport-tool',
                title: `${directive.tool}: conformance`,
                ...(directive.toolIdentity !== undefined ? { kind: directive.toolIdentity } : {}),
                content: [],
                locations: [],
                rawInput: directive.input,
              },
              options: [
                { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
              ],
            },
          });
          return;
        }
        update(peer, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: directive?.kind === 'reply' ? directive.text : 'ok' },
        });
        respond(peer, promptId, {
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 2, cachedWriteTokens: 3 },
        });
        peer.finish();
        return;
      case 'session/cancel':
        if (promptId !== undefined) {
          respond(peer, promptId, { stopReason: 'cancelled', usage: null });
          promptId = undefined;
        }
        return;
      default:
        if (frame['id'] !== undefined) {
          peer.send({
            jsonrpc: '2.0',
            id: frame['id'],
            error: { code: -32601, message: 'fake transport method not found' },
          });
        }
    }
  };
}

/** Fresh AcpDriver honoring the ConformanceSpec contract. */
function makeDriver(spec: ConformanceSpec): Driver {
  return new AcpDriver({
    ...driverOptions(spec.scratchDir, {}, []),
    spawn: fakeAcpSpawn((opts) => fakeAcpScript(opts, spec.directive)),
    // The priced handle flows through the price lookup so the conformance
    // suite can assert a derived costUSD; everything else stays unpriced.
    ...(spec.pricedModel !== undefined
      ? {
          pricing: (modelSpec: { provider: string; model: string }) =>
            modelSpec.provider === spec.pricedModel?.provider
              ? { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }
              : undefined,
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. The conformance suite, fake-ACP-server-backed
// ---------------------------------------------------------------------------

runDriverConformance(
  makeDriver,
  { describe, test, expect },
  { label: 'acp driver (fake ACP server)' },
);
runGovernedAbortLeg(makeDriver, { describe, test, expect });
