// The environment for a `pnpm run build` child: the parent's minus every
// credential-bearing variable. Live workflows scope tokens to the live test;
// the build needs none of them. Shared by both build paths — the Vitest
// global setup (test/global-setup.ts) and the narrow runner
// (scripts/test-narrow.mjs) — so they can never scrub differently.

/** Names that carry credentials; the build needs none of them. */
const CREDENTIAL_NAME = /token|secret|password|passwd|credential|api_?key|private_?key|auth/i;

/**
 * Connection-string names (DATABASE_URL, REDIS_URL, SENTRY_DSN, ...) usually
 * embed a password or key inside the value, so the name filter above misses
 * them; the build needs none of them either.
 */
const CONNECTION_NAME = /(?:^|_)(?:database|db|redis|mongo(?:db)?|amqp|broker|dsn)(?:_|$)/i;

/** A URL whose userinfo carries a password (`scheme://user:pass@host`), whatever the variable is named. */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:[^\s/@]+@/i;

/** The parent environment minus credential-bearing variables. */
export function scrubbedBuildEnv(env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        !CREDENTIAL_NAME.test(name) &&
        !CONNECTION_NAME.test(name) &&
        !(value !== undefined && URL_WITH_PASSWORD.test(value)),
    ),
  );
}
