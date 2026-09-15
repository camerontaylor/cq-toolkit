// Pure-op fixture: indet — could not produce a verdict (neither success nor
// failure is claimed).
export default async function indet() {
  return { status: 'indeterminate', detail: 'fixture could not decide' };
}
