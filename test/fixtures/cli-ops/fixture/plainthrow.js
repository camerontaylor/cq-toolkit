// Pure-op fixture: plainthrow — a deliberate throw with NO usage carrier: the
// thrown error artifact must stay byte-shaped as before (#1195 no-regression
// twin of spendthrow).
export default async function plainthrow() {
  throw new Error('plainthrow: deliberate bare throw');
}
