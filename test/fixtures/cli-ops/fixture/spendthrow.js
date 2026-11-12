// Pure-op fixture: spendthrow — a deliberate THROW carrying the usage carrier
// an op may attach to its rejection (the review op's usageSummary carrier,
// #1195): the CLI's error artifact must carry the throw's settled spend
// instead of dropping it.
export default async function spendthrow() {
  const error = new Error('spendthrow: deliberate throw after settled spend');
  error.usageSummary = {
    usage: { input: 120, output: 40, cacheRead: 8, cacheWrite: 0 },
    knownCount: 1,
    unknownCount: 0,
    unpricedCount: 1,
  };
  throw error;
}
