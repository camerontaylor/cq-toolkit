/** Port of `repair_tick.own_range`: a commit range is "owned" when it is non-empty
 * and every commit in it was produced by repair (`repair_own_commits`). The commit
 * list (`git rev-list base..head`) is read by the caller.
 */
import { type JsonObject } from '../policy/crq/jsonValue.js';

export function repairOwnRange(queue: JsonObject, commits: readonly string[]): boolean {
  if (commits.length === 0) return false;
  const stored = queue.get('repair_own_commits');
  const list = stored === undefined ? [] : stored;
  if (!Array.isArray(list)) throw new Error('repair_own_commits must be an array');
  const owned = new Set(list);
  return commits.every((commit) => owned.has(commit));
}
