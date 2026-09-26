/** Type boundary for the standalone JavaScript settings-drift helper. */
export interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface BypassActor {
  actor_id: number | null;
  actor_type: string;
  bypass_mode: string;
}

/** A repository ruleset or an Actions policy (same REST shape). */
export interface RuleObject {
  name: string;
  target?: string;
  enforcement: string;
  conditions: Record<string, { include: string[]; exclude: string[] }>;
  rules: Rule[];
  bypass_actors?: BypassActor[];
}

export interface Reviewer {
  type: string;
  login?: string;
  slug?: string;
  id?: number;
}

export interface DeploymentBranchPolicy {
  protected_branches: boolean;
  custom_branch_policies: boolean;
}

export interface EnvironmentTarget {
  deployment_branch_policy: DeploymentBranchPolicy;
  branch_policies: { name: string; type: string }[];
  can_admins_bypass: boolean;
  /** `"any"` = not compared (drill: the owner may be a required reviewer). */
  reviewers: Reviewer[] | 'any';
  /** Pinned: the `required_reviewers` rule's self-review ban. */
  prevent_self_review: boolean;
  /** Pinned: the `wait_timer` rule's minutes. */
  wait_timer: number;
  secrets: string[];
  interimSecrets: string[];
}

export interface ActionsSettings {
  default_workflow_permissions?: string;
  can_approve_pull_request_reviews?: boolean;
}

/** The rendered policy/templates/github-settings.json. */
export interface GithubSettings {
  _doc?: string;
  schemaVersion: 1;
  rulesets: RuleObject[];
  classicBranchProtection: Record<string, null>;
  environments: Record<string, EnvironmentTarget>;
  repositorySecrets: string[];
  actions: ActionsSettings;
  actionsEventPolicy: RuleObject;
}

export interface LiveEnvironment {
  deployment_branch_policy: DeploymentBranchPolicy | null;
  branch_policies: { name: string; type: string }[];
  can_admins_bypass: boolean;
  reviewers: Reviewer[];
  prevent_self_review: boolean;
  wait_timer: number;
  /** Protection-rule types other than required_reviewers/wait_timer/branch_policy (drift). */
  other_rules: string[];
  secrets: string[];
}

/** The live settings the CLI assembles from its `gh api` reads. */
export interface LiveSettings {
  rulesets: RuleObject[];
  classicBranchProtection: Record<string, Record<string, unknown> | null>;
  environments: Record<string, LiveEnvironment>;
  repositorySecrets: string[];
  actions: ActionsSettings;
  actionsEventPolicies: RuleObject[];
}

export function renderSettings(
  templateText: string,
  ids: { verdictAppId: unknown; promoterAppId: unknown },
): GithubSettings;

export function environmentFromApi(
  env: Record<string, unknown>,
  branchPolicies: Record<string, unknown>[],
  secretNames: string[],
): LiveEnvironment;

export function compareSettings(
  expected: GithubSettings,
  actual: LiveSettings,
): { drift: string[]; notices: string[] };
