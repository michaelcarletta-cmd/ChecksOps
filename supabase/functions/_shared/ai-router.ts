/**
 * DEPRECATED — backward-compatible re-exports from the new central AI service.
 * All new code should import from "../_shared/ai/generate.ts" directly.
 */

export type { DarwinTaskType } from "./ai/modelRouter.ts";
export { routeTask as getModelForTask_v2 } from "./ai/modelRouter.ts";
export {
  runDarwinTask,
  callOpenAIText,
  callPerplexityResearch,
  getModelForTask,
  generate,
  type GenerateResult,
} from "./ai/generate.ts";
