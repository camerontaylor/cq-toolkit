// dev.cycle's red-final-gate fallback (#536, Giles D2/D2b): the pure parts.
//
// When the final gates are red at the addressed head T after at least one
// verified fix, dev.cycle may publish a DRAFT at the newest commit G on the
// linear verified-fix chain that passes ALL final gates. Gate success is not
// monotonic along the chain (a later fix can repair a gate an earlier fix
// broke), so the scan probes candidates newest to oldest and stops at the
// first green one: that commit is the newest green commit by construction,
// with no ordering assumption. The probes run in an isolated worktree (the
// cycle owns the git side); this module validates the chain, runs the scan
// loop over an injected probe, and renders the evidence.
import type { AddressFix } from '../../review/addressWorker.js';
import type { ReviewAddressReport } from '../../review/address.js';

/** One probe of one candidate commit. */
export interface GreenPrefixProbe {
  commit: string;
  verdict: 'green' | 'red' | 'fault';
  /** The probe's dev.check record id, when one was written at the candidate. */
  checkId?: string;
  /** The gates that failed at the candidate (red verdicts). */
  redGates?: string[];
  /** The refusal text (red/fault verdicts), bounded by the caller. */
  detail?: string;
}

/** The scan's outcome: the selected commit, or why the scan ended without one. */
export interface GreenPrefixScan {
  selected?: string;
  probes: GreenPrefixProbe[];
  /** Why no commit was selected (absent when one was). */
  stopped?: string;
}

/**
 * The verified-fix chain behind the addressed head: the admitted head A (the
 * first round's record head) and the fix commits in the order review.address
 * recorded them. A fix's commit order is its commit order: remember() appends
 * each verified fix and advances verifiedHead to its commit in one step. The
 * caller must still compare this list with git's own first-parent history —
 * commit presence alone is never provenance.
 */
export function recordedFixChain(
  report: ReviewAddressReport,
): { admitted: string; commits: string[] } | { fault: string } {
  const admitted = report.rounds[0]?.record.head;
  if (admitted === undefined) return { fault: 'the address report records no admitted head' };
  const commits: string[] = [];
  for (const fix of report.fixes) {
    if (fix.commit === undefined) continue;
    if (commits.at(-1) === fix.commit) continue;
    if (commits.includes(fix.commit))
      return { fault: `fix commit ${fix.commit} recurs out of order in the address report` };
    commits.push(fix.commit);
  }
  if (commits.length === 0) return { fault: 'the address report records no verified fix commit' };
  return { admitted, commits };
}

/**
 * Probe `candidates` (newest first) until one is green. `canProbe` is asked
 * before every probe and returns a reason to stop (the reserve no longer
 * covers another probe plus publication); a fault stops the scan too, since
 * an environmental failure says nothing about the commit's gates.
 */
export async function scanNewestFirst(
  candidates: readonly string[],
  probe: (commit: string) => Promise<GreenPrefixProbe>,
  canProbe: () => string | undefined,
): Promise<GreenPrefixScan> {
  const probes: GreenPrefixProbe[] = [];
  for (const commit of candidates) {
    const stop = canProbe();
    if (stop !== undefined)
      return {
        probes,
        stopped: `${stop} after probing ${String(probes.length)} of ${String(candidates.length)} candidate(s)`,
      };
    const result = await probe(commit);
    probes.push(result);
    if (result.verdict === 'green') return { selected: commit, probes };
    if (result.verdict === 'fault')
      return { probes, stopped: `probe of ${commit} faulted: ${result.detail ?? 'no detail'}` };
  }
  return {
    probes,
    stopped: `no candidate passed all final gates (${String(candidates.length)} probed)`,
  };
}

/** The fixes whose commits the selected head drops: those after it on the chain. */
export function droppedFixes(
  report: ReviewAddressReport,
  chain: readonly string[],
  selected: string,
): AddressFix[] {
  const kept = new Set(chain.slice(0, chain.indexOf(selected) + 1));
  return report.fixes.filter((fix) => fix.commit !== undefined && !kept.has(fix.commit));
}

/** One line per probe: commit, verdict, check record and red gates. */
export function probeLines(probes: readonly GreenPrefixProbe[]): string[] {
  return probes.map(
    (probe) =>
      `${probe.commit} ${probe.verdict}${probe.checkId === undefined ? '' : ` (${probe.checkId})`}${
        probe.redGates === undefined || probe.redGates.length === 0
          ? ''
          : `: ${probe.redGates.join(', ')}`
      }${probe.verdict === 'fault' && probe.detail !== undefined ? `: ${probe.detail}` : ''}`,
  );
}
