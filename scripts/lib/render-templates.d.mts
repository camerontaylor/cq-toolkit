/** Type boundary for the standalone JavaScript template-render helper. */
export const TOKEN_PATTERN: RegExp;
export const TEMPLATES_DIR: string;
export const WORKFLOWS_DIR: string;
export const TABLE_PATH: string;
export const WORKFLOW_NAME: RegExp;
export const TEMPLATE_NAME: RegExp;
export function provenanceHeader(template: string): string;
export function templateTokens(text: string): string[];
export function renderTemplate(
  text: string,
  template: string,
  tokens: Readonly<Record<string, string>>,
): string;
export function validateTable(
  table: unknown,
  workflows: readonly string[],
  templates: readonly string[],
): string[];
export function listYaml(dir: string, recursive: boolean): string[];
export interface RenderResult {
  workflow: string;
  template: string;
  expected: string | null;
  actual: string | null;
}
export function writeBlockers(
  errors: readonly string[],
  results: readonly RenderResult[],
): string[];
export function collectRenders(root: string): { errors: string[]; results: RenderResult[] };
export function firstDifference(expected: string, actual: string): string | null;
