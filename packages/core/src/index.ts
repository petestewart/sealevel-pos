/**
 * @ai-manager/core — shared core (brain, queue, tools, jobs, db).
 * Remaining modules land in later Phase 0 tickets
 * (see ARCHITECTURE.md "Repo structure").
 */
export const CORE_PACKAGE = "@ai-manager/core";

export { loadEnv, requireEnv } from "./env.js";
export { getPool, closePool } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export { createRedis } from "./redis.js";
export {
  DEFAULT_QUEUE_NAME,
  DEFAULT_JOB_OPTIONS,
  createQueue,
  enqueue,
  DEFAULT_WORKER_CONCURRENCY,
  workerConcurrency,
  createQueueWorker,
  registerSchedules,
  type ScheduleSpec,
} from "./queue/index.js";
export type { Job, Trigger, JobContext, BrainModel } from "./jobs/types.js";
export { JOBS, jobById } from "./jobs/registry.js";
export type { InboundEmailPayload } from "./jobs/emailDraft.js";
export { reviseJobId } from "./jobs/itemRevise.js";
export type { ItemRevisePayload } from "./jobs/itemRevise.js";
export {
  DRAFT_REVISION_LIMIT,
  DraftNotRevisableError,
  getPendingEmailReplyItem,
  reviseEmailReplyDraft,
  recordDraftAnswer,
  recordItemUsage,
} from "./db/itemDrafts.js";
export {
  createItem,
  assignItem,
  resolveItem,
  reopenItem,
  ReopenConflictError,
  listItems,
  getItemById,
  countItemsByStatus,
  DEFAULT_PAGE_SIZE,
} from "./db/items.js";
export type {
  Item,
  ItemStatus,
  ItemStatusCounts,
  CreateItemInput,
  CreateItemResult,
  ListItemsFilter,
} from "./db/items.js";
export { createItemTool, toolsByName, toolsForJob } from "./tools/registry.js";
export { emitItemEvent } from "./notifications/emit.js";
export type {
  ItemEventType,
  ItemEventPayload,
  EmitResult,
  TriggerFn,
} from "./notifications/emit.js";
export { runJob, DEFAULT_BRAIN_MODEL } from "./brain/run.js";
export { SYSTEM_PROMPT } from "./brain/prompts.js";
export type { UsageTotals } from "./brain/budget.js";
