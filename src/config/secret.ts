// Secret-bearing environment names. The one definition: driver error text
// redaction and the env registry both classify names by these suffixes, so a
// name is secret for one exactly when it is secret for the other.
export const SECRET_ENV_SUFFIXES: readonly string[] = [
  '_API_KEY',
  '_TOKEN',
  '_AUTH_TOKEN',
  '_SECRET',
  '_KEY',
  '_PASSWORD',
  '_CREDENTIALS',
  'PRIVATE_KEY',
];

/** True when `name` (case-folded) ends in a secret suffix. */
export function isSecretEnvName(name: string): boolean {
  const classified = name.toUpperCase();
  return SECRET_ENV_SUFFIXES.some((suffix) => classified.endsWith(suffix));
}
