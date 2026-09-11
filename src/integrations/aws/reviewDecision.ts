/** Review console expects `{ new_stage }`; AWS transitions return `toStage`. */
export const mapReviewDecisionResult = (body: Record<string, unknown> = {}) => {
  const payload = body.data && typeof body.data === "object"
    ? body.data as Record<string, unknown>
    : body;
  const newStage = body.toStage
    || payload.toStage
    || payload.check_stage
    || payload.new_stage
    || null;
  return { ...payload, new_stage: newStage };
};
