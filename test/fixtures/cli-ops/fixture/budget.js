// Pure-op fixture: budget — returns the budget-exhausted verdict itself
// (an op-returned row, NOT a governor trip).
export default async function budget() {
  return { status: 'budget-exhausted' };
}
