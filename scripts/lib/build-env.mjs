// The environment for a `pnpm run build` child: the parent's minus every
// credential-bearing variable. Live workflows scope tokens to the live test;
// the build needs none of them. Shared by the Vitest global setup
// (test/global-setup.ts), the narrow runner (scripts/test-narrow.mjs), and
// the ratchet engine build (scripts/ratchet-lib.mjs) so they scrub alike.

/**
 * Names that carry credentials; the build needs none of them. A bare `_KEY`
 * suffix is not enough on its own (BUILD_KEY, CACHE_KEY are not credentials),
 * so each key class is named: API, private, encryption and signing keys all
 * hold a secret.
 */
const CREDENTIAL_NAME =
  /token|secret|password|passwd|credential|(?:api|private|encryption|signing)_?key|auth/i;

/**
 * Connection-string names (DATABASE_URL, REDIS_URL, SENTRY_DSN, ...) usually
 * embed a password or key inside the value, so the name filter above misses
 * them; the build needs none of them either.
 */
const CONNECTION_NAME = /(?:^|_)(?:database|db|redis|mongo(?:db)?|amqp|broker|dsn)(?:_|$)/i;

/**
 * A URL whose userinfo carries a credential, whatever the variable is named:
 * `scheme://user:pass@host` and equally `scheme://credential@host`, since URL
 * userinfo can hold a token with no colon before the `@`. The userinfo must sit
 * at the start of the authority, so `@` in a path (`https://host/a@b`) stays.
 */
const URL_WITH_CREDENTIAL = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/i;

/** The parent environment minus credential-bearing variables. */
export function scrubbedBuildEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        !CREDENTIAL_NAME.test(name) &&
        !CONNECTION_NAME.test(name) &&
        !(value !== undefined && URL_WITH_CREDENTIAL.test(value)),
    ),
  );
}
