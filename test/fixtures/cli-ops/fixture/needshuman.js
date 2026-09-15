// Pure-op fixture: needshuman — stops for a human decision.
export default async function needshuman() {
  return { status: 'needs-human', reason: 'fixture needs a human decision' };
}
