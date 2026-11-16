import { JsonObject } from '../../policy/crq/jsonValue.js';
import type { ReviewCapabilityEffects } from '../../ops/crq/reviewCapability.js';

/** Resolve missing historical trees before calling the existing pinned identity resolver. */
export function localReviewFactsEffects(
  effects: Pick<ReviewCapabilityEffects, 'historyGit' | 'resolveIdentity'>,
) {
  return {
    async ensureObjects(repo: string, base: string, head: string): Promise<void> {
      const git = effects.historyGit(repo);
      let present = true;
      for (const commit of [base, head]) {
        try {
          await git('cat-file', '-e', `${commit}^{commit}`);
        } catch {
          present = false;
          break;
        }
      }
      if (!present) await git('fetch', '--prune', '--quiet', 'origin');
    },
    async resolveFacts(
      repo: string,
      base: string,
      head: string,
      profile: JsonObject,
    ): Promise<JsonObject> {
      const git = effects.historyGit(repo);
      const tree = async (commit: string): Promise<string> =>
        Buffer.from(await git('rev-parse', `${commit}^{tree}`))
          .toString('utf8')
          .trim();
      const inputs = new JsonObject([
        ['repo', repo],
        ['base_commit', base],
        ['base_tree', await tree(base)],
        ['head_commit', head],
        ['head_tree', await tree(head)],
        ['projection', 'full-diff'],
        ['target', 'main'],
      ]);
      return effects.resolveIdentity(repo, inputs, profile);
    },
  };
}
