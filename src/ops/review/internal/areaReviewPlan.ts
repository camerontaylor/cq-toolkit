import { createReviewPlan, type CreateReviewPlanInput, type ReviewPlan } from './reviewPlan.js';
import { planReviewAreas } from './reviewAreas.js';
import { REVIEW_SESSION_DEFAULTS } from '../../analyze/cqConfig.js';

/** Area sessions retain primary byte evidence; contract context never discharges it. */
export function createAreaReviewPlan(input: CreateReviewPlanInput): ReviewPlan {
  const original = createReviewPlan(input);
  const included = input.components.filter((component) =>
    original.coverage.pieces.some(
      (piece) => piece.component === component.component && piece.state !== 'excluded',
    ),
  );
  const areas = planReviewAreas({
    components: included,
    ...(input.intent === undefined ? {} : { intent: input.intent }),
  });
  if (areas.kind !== 'areas') {
    original.advisories.push(`area review fallback: ${areas.reason}`);
    return original;
  }
  const plans = areas.areas.map((area) => {
    const plan = createReviewPlan({
      ...input,
      components: area.files.map((index) => included[index - 1]!),
    });
    for (const session of plan.sessions) session.id = `${area.id}-${session.id}`;
    return plan;
  });
  const sessions = plans.flatMap((plan) => plan.sessions);
  if (areas.crossAreaPass.required) {
    const prompt = [
      'Review cross-area contracts and their consumers for this change. Use read-only tools to verify interactions.',
      'This is contract context, not primary diff coverage.',
      JSON.stringify({
        intent: areas.areas[0]?.intent,
        changedFiles: areas.changedFiles,
        areas: areas.areas,
      }),
      'Return ONLY JSON: {"findings":[{"file":"path","line":1,"severity":"high|medium|low","text":"evidence-based defect"}]}. Return {"findings":[]} if clean.',
    ].join('\n');
    if (prompt.length > (input.session?.maxInputChars ?? REVIEW_SESSION_DEFAULTS.maxInputChars)) {
      original.advisories.push(
        'area review fallback: cross-area context exceeds session prompt bound',
      );
      return original;
    }
    sessions.push({ id: 'cross-area', prompt, placements: [], tools: true, contextOnly: true });
  }
  original.sessions = sessions;
  original.coverage.mode = 'partitioned';
  original.coverage.modeReason = `area review: ${areas.areas.length} areas; cross-area pass ${areas.crossAreaPass.required ? 'required' : 'not required'}`;
  original.advisories.push(original.coverage.modeReason);
  return original;
}
