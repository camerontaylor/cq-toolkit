// The registry of environment names the toolkit reads (config contract C2).
//
// One entry per `CQ_*` name the code reads, plus a denied prefix and the
// foreign (vendor/forge) names the drivers and selfhost read. Parsers are the
// existing ones, reused; this module only declares them. Nothing here reads
// `process.env`; `readCqEnv` (./env.ts) does the reading.
import {
  parseBackend,
  parseMode,
  parseModelSpec,
  parseNetwork,
  parsePassthrough,
  parseRunTool,
} from './parsers.js';
import { isSecretEnvName } from './secret.js';
import {
  ACCEPT_STATES,
  ASSOCIATIONS,
  BOT_ENTRY_RE,
  POSTURE_LIST,
  stripRefsHeads,
  isPosture,
} from './values.js';

/**
 * A git branch name in the conservative refname grammar the merge op schemas
 * use. A leading `refs/heads/` is stripped so the stored value is always the
 * bare name and every comparison sees one spelling.
 */
const branchName =
  (key: string) =>
  (raw: string): string => {
    const v = stripRefsHeads(raw.trim());
    if (
      v === '' ||
      v.length > 250 ||
      !/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(v) ||
      v.includes('..')
    ) {
      throw new Error(`${key} must be a branch name, got '${raw.slice(0, 80)}'`);
    }
    return v;
  };

export type CqEnvKind = 'config' | 'identity' | 'test';
/**
 * What a blank (unset, empty or whitespace) value means. `conservative`: the
 * built-in behaviour is the strictest safe one, so a missing or mistyped name
 * can only tighten. `neutral`: nothing safety-relevant depends on the value
 * (paths, aliases, identifiers). Trust keys must be `conservative`.
 */
export type CqEnvBlank = 'conservative' | 'neutral';
export type CqEnvStatus = 'live' | 'reserved' | 'denied';

/** Parses one non-blank raw value; throws an Error on an invalid value. */
export type CqEnvParser = (raw: string) => unknown;

export interface CqEnvEntry {
  readonly name: string;
  readonly kind: CqEnvKind;
  readonly parse: CqEnvParser;
  /** Derived from the name via SECRET_ENV_SUFFIXES; the value is never printed. */
  readonly secret: boolean;
  readonly blank: CqEnvBlank;
  /** Trust-boundary key: never taken from cq.json, plan data or op input. */
  readonly trust: boolean;
  readonly status: CqEnvStatus;
  readonly description: string;
}

/** A denied name prefix: any set name starting with it is an error. */
export interface CqEnvDeniedPrefix {
  readonly prefix: string;
  readonly description: string;
}

/** A non-`CQ_` name the toolkit reads; recorded for secret presence only. */
export interface ForeignEnvEntry {
  readonly name: string;
  readonly secret: boolean;
  readonly description: string;
}

export interface CqEnvRegistry {
  readonly entries: readonly CqEnvEntry[];
  readonly denied: readonly CqEnvDeniedPrefix[];
}

const text: CqEnvParser = (raw) => raw;

function list(parse: (entry: string) => boolean, expected: string, name: string): CqEnvParser {
  return (raw) => {
    const entries = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const bad = entries.find((entry) => !parse(entry));
    if (bad !== undefined) {
      throw new Error(
        `${name}: unrecognised entry ${JSON.stringify(bad)} (expected ${expected}; comma-separated)`,
      );
    }
    return entries;
  };
}

const posture: CqEnvParser = (raw) => {
  if (!isPosture(raw)) {
    throw new Error(`policy: CQ_MERGE_PROTECTED_PATHS must be ${POSTURE_LIST}, got '${raw}'`);
  }
  return raw;
};

const epochMs: CqEnvParser = (raw) => {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `selfhost-review-loop: CQ_SELFHOST_NOW_MS must be a non-negative safe integer epoch-ms — got ${JSON.stringify(raw)}`,
    );
  }
  return value;
};

/** One grammar and deny set for every path: see `parsePassthrough`. */
const passthrough: CqEnvParser = (raw) => parsePassthrough(raw);

function entry(
  name: string,
  kind: CqEnvKind,
  parse: CqEnvParser,
  blank: CqEnvBlank,
  trust: boolean,
  description: string,
  status: CqEnvStatus = 'live',
): CqEnvEntry {
  return { name, kind, parse, secret: isSecretEnvName(name), blank, trust, status, description };
}

export const CQ_ENV_ENTRIES: readonly CqEnvEntry[] = [
  entry(
    'CQ_APPROVAL_SIGNERS',
    'config',
    text,
    'conservative',
    true,
    'Operator-ledger signers allowed to approve.',
  ),
  entry(
    'CQ_AUTHOR_REPO',
    'config',
    text,
    'neutral',
    false,
    'Repository path the review-transport author side works in.',
  ),
  entry(
    'CQ_REVIEW_NOTIFY_HOST',
    'config',
    text,
    'neutral',
    false,
    'Paseo host:port override for local-review completion notifications; defaults to the lowercase short OS hostname on port 6767, or null if unusable.',
  ),
  entry(
    'CQ_AUTHOR_SNAPSHOT_SCANNER',
    'config',
    text,
    'neutral',
    false,
    'Snapshot scanner command for the review transport and review.submit (an explicit scanner input wins).',
  ),
  entry(
    'CQ_AUTHOR_SSH_ALIAS',
    'config',
    text,
    'neutral',
    false,
    'SSH alias of the author host for the review transport.',
  ),
  entry(
    'CQ_AUTOMATION_TOKEN',
    'config',
    text,
    'conservative',
    true,
    'Automation credential mapped to GH_TOKEN for gh (no ambient fallback).',
  ),
  entry(
    'CQ_DIST_PREPARED',
    'test',
    text,
    'neutral',
    false,
    'Set to 1 by the repo test runners when dist is already fresh (read by test/global-setup.ts).',
  ),
  entry(
    'CQ_GH_BIN',
    'config',
    text,
    'neutral',
    false,
    'Path or name of the gh binary (default gh).',
  ),
  entry(
    'CQ_MERGE_ACCEPT_REVIEW_STATES',
    'config',
    list(
      (e) => ACCEPT_STATES.includes(e.toUpperCase()),
      ACCEPT_STATES.join(' or '),
      'CQ_MERGE_ACCEPT_REVIEW_STATES',
    ),
    'conservative',
    true,
    'Review states that count as acceptance (blank: APPROVED only).',
  ),
  entry(
    'CQ_MERGE_BASE_BRANCH',
    'config',
    branchName('CQ_MERGE_BASE_BRANCH'),
    'conservative',
    true,
    'Base branch the self-merge flow targets.',
  ),
  entry(
    'CQ_MERGE_PROTECTED_BRANCH',
    'config',
    branchName('CQ_MERGE_PROTECTED_BRANCH'),
    'conservative',
    true,
    'Branch merge pushes may never target; plan data cannot override it (blank: main).',
  ),
  entry(
    'CQ_MERGE_PROTECTED_PATHS',
    'config',
    posture,
    'conservative',
    true,
    'Protected-paths posture: human, diff-check or advisory (blank: human).',
  ),
  entry(
    'CQ_MERGE_TRUSTED_ASSOCIATIONS',
    'config',
    list(
      (e) => ASSOCIATIONS.includes(e.toUpperCase()),
      ASSOCIATIONS.join(', '),
      'CQ_MERGE_TRUSTED_ASSOCIATIONS',
    ),
    'conservative',
    true,
    'Trusted author associations (blank: OWNER, MEMBER, COLLABORATOR).',
  ),
  entry(
    'CQ_MERGE_TRUSTED_BOTS',
    'config',
    list((e) => BOT_ENTRY_RE.test(e), 'a login such as coderabbitai[bot]', 'CQ_MERGE_TRUSTED_BOTS'),
    'conservative',
    true,
    'Trusted bot logins (blank: none).',
  ),
  entry(
    'CQ_PARENT_WORK_ID',
    'identity',
    text,
    'neutral',
    false,
    'Parent work id stamped into child environments.',
  ),
  entry(
    'CQ_PRODUCER_VERSION',
    'config',
    text,
    'neutral',
    false,
    'Producer version stamped into run provenance (default: the toolkit package version).',
  ),
  entry(
    'CQ_QUEUE_SSH_ALIAS',
    'config',
    text,
    'neutral',
    false,
    'SSH alias of the review queue host.',
  ),
  entry(
    'CQ_ROLE',
    'identity',
    text,
    'neutral',
    false,
    'Role label stamped into child environments.',
  ),
  entry(
    'CQ_RUN_ENV_PASSTHROUGH',
    'config',
    passthrough,
    'conservative',
    true,
    'Extra env names copied into run children (blank: none).',
  ),
  entry(
    'CQ_RESOURCE_SCOPED',
    'test',
    text,
    'neutral',
    false,
    'Set to 1 by the repo scripts once they run inside a memory scope (scripts/lib/resource-scope.mjs).',
  ),
  entry('CQ_RUN_ID', 'identity', text, 'neutral', false, 'Run id stamped into child environments.'),
  entry(
    'CQ_RUN_TOOL',
    'config',
    parseRunTool,
    'conservative',
    true,
    'Run tool on or off (blank: on, still withheld under a required sandbox).',
  ),
  entry(
    'CQ_SANDBOX',
    'config',
    parseMode,
    'conservative',
    true,
    'Sandbox mode off or required (blank: required).',
  ),
  entry(
    'CQ_SANDBOX_BACKEND',
    'config',
    parseBackend,
    'conservative',
    true,
    'Sandbox backend (blank: auto).',
  ),
  entry(
    'CQ_SANDBOX_NETWORK',
    'config',
    parseNetwork,
    'conservative',
    true,
    'Requested egress posture model-only or allow (blank: model-only).',
  ),
  entry(
    'CQ_SELFHOST_DRIVER',
    'config',
    (raw) => parseModelSpec(raw, 'CQ_SELFHOST_DRIVER'),
    'neutral',
    false,
    'Off-peak selfhost driver as provider/model.',
  ),
  entry(
    'CQ_SELFHOST_NOW_MS',
    'test',
    epochMs,
    'neutral',
    false,
    'Pinned run-start epoch-ms for the selfhost review loop.',
  ),
  entry(
    'CQ_SELFHOST_PEAK_DRIVER',
    'config',
    (raw) => parseModelSpec(raw, 'CQ_SELFHOST_PEAK_DRIVER'),
    'neutral',
    false,
    'Peak-window selfhost driver as provider/model.',
  ),
  entry(
    'CQ_SESSION_LOGS',
    'config',
    text,
    'neutral',
    false,
    'Session-log destination for driver runs.',
  ),
  entry(
    'CQ_SESSIONS_DIR',
    'config',
    text,
    'neutral',
    false,
    'Directory driver session files are written to.',
  ),
  entry(
    'CQ_TASK',
    'identity',
    text,
    'neutral',
    false,
    'Task label stamped into child environments.',
  ),
  entry(
    'CQ_WORK_ID',
    'identity',
    text,
    'neutral',
    false,
    'Work id stamped into child environments.',
  ),
];

export const CQ_ENV_DENIED_PREFIXES: readonly CqEnvDeniedPrefix[] = [
  {
    prefix: 'CQ_APPROVAL_KEY',
    description: 'Approval keys never come from the environment.',
  },
];

export const CQ_ENV_REGISTRY: CqEnvRegistry = {
  entries: CQ_ENV_ENTRIES,
  denied: CQ_ENV_DENIED_PREFIXES,
};

function foreign(name: string, description: string): ForeignEnvEntry {
  return { name, secret: isSecretEnvName(name), description };
}

/** Foreign names the drivers, forge adapters and selfhost read (not warned on). */
export const FOREIGN_ENV_ENTRIES: readonly ForeignEnvEntry[] = [
  foreign('ANTHROPIC_API_KEY', 'Anthropic API key (claude-code and ai-sdk drivers).'),
  foreign('ANTHROPIC_AUTH_TOKEN', 'Anthropic auth token injected into claude-code children.'),
  foreign('ANTHROPIC_BASE_URL', 'Anthropic endpoint override.'),
  foreign('DEEPSEEK_ANTHROPIC_BASE_URL', 'DeepSeek Anthropic-compatible endpoint override.'),
  foreign('DEEPSEEK_API_KEY', 'DeepSeek API key.'),
  foreign('GH_REPOSITORY', 'Repository slug default for selfhost entries.'),
  foreign('GH_TOKEN', 'GitHub token read by gh.'),
  foreign('GITHUB_REPOSITORY', 'Repository slug set by GitHub Actions.'),
  foreign('GITHUB_TOKEN', 'GitHub Actions token (removed from gh children).'),
  foreign('NPM_TOKEN', 'npm publish token (kept out of child environments).'),
  foreign('PASEO_AGENT_ID', 'Current Paseo agent notification destination.'),
  foreign('OPENAI_API_KEY', 'OpenAI API key.'),
  foreign('OPENCODE_GO_API_KEY', 'OpenCode Go API key.'),
  foreign('OPENCODE_GO_BASE_URL', 'OpenCode Go endpoint (required, no default).'),
  foreign('ZAI_ANTHROPIC_BASE_URL', 'Z.ai Anthropic-compatible endpoint override.'),
  foreign('ZAI_API_KEY', 'Z.ai API key.'),
  foreign('ZAI_BASE_URL', 'Z.ai ai-sdk endpoint override.'),
];
