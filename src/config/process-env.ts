// The shared accessor for the ambient process environment (config contract C7). A reader that has no snapshot from its
// caller (a registry-composed op, a driver constructor default) goes through
// `processEnv()` instead of naming `process.env`, so the lint rule
// `cq/no-process-env` can confine direct reads to src/config and the driver
// child-env builders. The value is read at call time, exactly as the direct
// `process.env` access it replaces did.

/** The live ambient environment (call-time view; never cached). */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}
