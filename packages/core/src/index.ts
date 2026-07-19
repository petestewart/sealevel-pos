/**
 * @ai-manager/core — shared core (brain, queue, tools, jobs, db).
 * Remaining modules land in later Phase 0 tickets
 * (see ARCHITECTURE.md "Repo structure").
 */
export const CORE_PACKAGE = "@ai-manager/core";

export { loadEnv, requireEnv } from "./env.js";
export { workerVersion } from "./version.js";
export {
  bookingUrl,
  bookingConfigured,
  bookingLinkGuidance,
} from "./booking.js";
export { getPool, closePool } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export { createRedis } from "./redis.js";
export {
  DEFAULT_QUEUE_NAME,
  DEFAULT_JOB_OPTIONS,
  createQueue,
  enqueue,
  getSharedQueue,
  closeSharedQueue,
  enqueueEmailSend,
  emailSendJobId,
  EMAIL_SEND_JOB,
  DEFAULT_WORKER_CONCURRENCY,
  workerConcurrency,
  createQueueWorker,
  registerSchedules,
  cronSchedulesFromJobs,
  emailIngestSchedule,
  EMAIL_INGEST_JOB,
  type ScheduleSpec,
} from "./queue/index.js";
export type { Job, Trigger, JobContext, BrainModel } from "./jobs/types.js";
export { JOBS, jobById } from "./jobs/registry.js";
export type { InboundEmailPayload, EmailMeta } from "./jobs/emailDraft.js";
export {
  dispatchInboundEmail,
  jobsForInboundEmail,
  inboundEmailJobId,
  type DispatchResult,
} from "./jobs/dispatch.js";
export {
  gmailConfigured,
  gmailSendEnabled,
  gmailSendConfigured,
  gmailSendMode,
  gmailConfig,
  gmailPollCron,
  DEFAULT_INGEST_QUERY,
  DEFAULT_POLL_CRON,
  type GmailConfig,
} from "./gmail/config.js";
export { ingestInbound, type IngestResult } from "./gmail/ingest.js";
export { sendApprovedReply, type SendResult } from "./gmail/send.js";
export {
  gmailClient,
  GmailClient,
  GmailSendError,
  type SentMessage,
  type CreatedDraft,
} from "./gmail/client.js";
export {
  parseGmailMessage,
  buildRawReply,
  extractPlainBody,
  extractAddress,
  replySubject,
  type ParsedInboundEmail,
  type GmailMessageResource,
  type ReplyFields,
} from "./gmail/parse.js";
export {
  markDeliveryQueued,
  claimDeliveryForSend,
  recordDeliverySent,
  recordDeliveryDrafted,
  recordDeliveryFailed,
  type DeliveryRecord,
  type DeliveryStatus,
} from "./db/delivery.js";
export {
  ROUTING_REGISTRY,
  isKnownRoute,
  routeOwner,
  sanitizeSuggestion,
  type RouteDefinition,
  type AssigneeSuggestion,
} from "./routing.js";
export { suggestAssignee } from "./brain/suggestAssignee.js";
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
  assignItemAudited,
  resolveItem,
  reopenItem,
  ReopenConflictError,
  listItems,
  getItemById,
  countItemsByStatus,
  DEFAULT_PAGE_SIZE,
} from "./db/items.js";
export type {
  AssigneeRef,
  Item,
  ItemStatus,
  ItemStatusCounts,
  CreateItemInput,
  CreateItemResult,
  ListItemsFilter,
} from "./db/items.js";
export {
  DEFAULT_SIGNOFF,
  RULE_MAX_CHARS,
  listRules,
  getActiveRules,
  createRule,
  updateRule,
  deleteRule,
  getUserSettings,
  setUserSettings,
  studioRulesBlock,
  loadRulesBlock,
} from "./db/settings.js";
export type { Rule, UserSettings } from "./db/settings.js";
export {
  STUDIO_INFO_KEY_MAX_CHARS,
  STUDIO_INFO_VALUE_MAX_CHARS,
  STUDIO_INFO_MAX_ENTRIES,
  getStudioInfoEntries,
  addStudioInfoEntry,
  saveStudioInfoEntry,
  deleteStudioInfoEntry,
  studioInfoBlock,
  loadStudioInfoBlock,
} from "./db/studioInfo.js";
export type { StudioInfoEntry } from "./db/studioInfo.js";
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
export {
  TAG_REGISTRY,
  isKnownTag,
  sanitizeTags,
  tagLabel,
} from "./tags.js";
export type { TagDefinition, ItemTag } from "./tags.js";
