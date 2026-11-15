/** Inactive binding of the enrollment association reads (`LocalReviewAssociateEffects`):
 * `local_review_runtime.facts` and `local_review_runtime.retained`. Both reuse existing
 * ports: `localReviewFactsEffects` resolves the pinned identity (git trees plus the
 * review capability resolver) and `receiptRetainsItem` is the receipt check the review
 * capability already applies. Nothing is written.
 */
import type { JsonObject } from '../../policy/crq/jsonValue.js';
import { adequate, ValueError } from '../../policy/crq/reviewAdmission.js';
import { GitUnavailable } from '../../policy/crq/reviewHistory.js';
import {
  receiptRetainsItem,
  reviewProfile,
  type ReviewCapabilityEffects,
} from '../../ops/crq/reviewCapability.js';
import type { LocalReviewAssociateEffects } from '../../queue-runner/localReviewAssociate.js';
import { localReviewFactsEffects } from './localReviewFacts.js';

export interface LocalReviewAssociateSourceOptions {
  readonly config: JsonObject;
  readonly effects: Pick<ReviewCapabilityEffects, 'historyGit' | 'resolveIdentity' | 'readReceipt'>;
}

/** Python's `except (OSError, RuntimeError, ValueError, SubprocessError)`: a failed read
 * is "no facts"; a programming error (TypeError and the like) still propagates. */
function expectedFailure(error: unknown): boolean {
  return (
    error instanceof ValueError ||
    error instanceof GitUnavailable ||
    (error instanceof Error && typeof (error as { code?: unknown }).code === 'string')
  );
}

export function fileLocalReviewAssociateEffects(
  options: LocalReviewAssociateSourceOptions,
): LocalReviewAssociateEffects {
  const resolver = localReviewFactsEffects(options.effects);
  return {
    async facts(repo, base, head) {
      try {
        return await resolver.resolveFacts(repo, base, head, reviewProfile(options.config, base));
      } catch (error) {
        if (expectedFailure(error)) return null;
        throw error;
      }
    },
    async retained(item) {
      return adequate(item) && (await receiptRetainsItem(item, options.effects.readReceipt));
    },
  };
}
