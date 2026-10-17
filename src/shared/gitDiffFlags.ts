/** Git diff flags shared by sweep path and content probes. Keep the parser's
 * a/ b/ prefixes and render text even under hostile repo diff attributes. */
export const SWEEP_DIFF_FLAGS: readonly string[] = [
  '--text',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];
