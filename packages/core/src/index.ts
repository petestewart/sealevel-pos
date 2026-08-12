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
  OUTBOUND_ACTIONS,
  ITEM_TYPE_OUTBOUND,
  enqueueOutboundAction,
  enqueueItemOutbound,
  type OutboundAction,
  type OutboundActionName,
  enqueueEmailSend,
  emailSendJobId,
  EMAIL_SEND_JOB,
  enqueueGmailState,
  gmailStateJobId,
  EMAIL_GMAIL_STATE_JOB,
  enqueueKbWrite,
  kbWriteJobId,
  KB_WRITE_JOB,
  enqueueEvalCapture,
  evalCaptureJobId,
  EVAL_CAPTURE_JOB,
  enqueueLearningMine,
  learningMineJobId,
  learningThresholdKind,
  LEARNING_MINE_JOB,
  type GmailStateJobPayload,
  DEFAULT_WORKER_CONCURRENCY,
  workerConcurrency,
  createQueueWorker,
  registerSchedules,
  cronSchedulesFromJobs,
  emailIngestSchedule,
  EMAIL_INGEST_JOB,
  learningMineSchedule,
  LEARNING_MINE_SCHEDULE_ID,
  DEFAULT_LEARNING_MINE_CRON,
  campaignsSyncContactsSchedule,
  CAMPAIGNS_SYNC_CONTACTS_JOB,
  CAMPAIGNS_SYNC_SCHEDULE_ID,
  DEFAULT_CAMPAIGNS_SYNC_CRON,
  CAMPAIGNS_BUILD_AUDIENCE_JOB,
  campaignsMonitorSchedule,
  CAMPAIGNS_MONITOR_JOB,
  CAMPAIGNS_MONITOR_SCHEDULE_ID,
  DEFAULT_CAMPAIGNS_MONITOR_CRON,
  type ScheduleSpec,
} from "./queue/index.js";
export type { Job, Trigger, JobContext, BrainModel } from "./jobs/types.js";
export { JOBS, jobById, registerJobs } from "./jobs/registry.js";
export type { InboundEmailPayload, EmailMeta } from "./jobs/emailDraft.js";
export { suspectedSpamPayload } from "./jobs/emailDraft.js";
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
  applyGmailState,
  gmailStateActionForDecision,
  isGmailStateAction,
  GMAIL_STATE_ACTIONS,
  type GmailStateAction,
  type GmailStateClient,
  type GmailStateResult,
} from "./gmail/state.js";
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
  listStagedApprovedItems,
  countStagedApprovedItems,
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
export {
  trashItem,
  restoreTrashedItem,
  markGmailTrashed,
  listTrashedItems,
  countTrashedItems,
  NOT_TRASHED_SQL,
  type TrashReason,
  type TrashRecord,
  type TrashDecisionAction,
} from "./db/trash.js";
export {
  recordSpamSignal,
  matchesSpamSignal,
  listSpamSignals,
  deleteSpamSignal,
  type SpamSignal,
  type SpamSignalKind,
} from "./db/spamSignals.js";
export { suggestAssignee } from "./brain/suggestAssignee.js";
export {
  classifyNoReply,
  classifyNoReplyDeterministic,
  classifyNoReplyLlm,
  detectAutomatedHeaders,
  detectNoReplySender,
} from "./brain/noReply.js";
export type { NoReplyClassification, NoReplySignals } from "./brain/noReply.js";
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
  createNoReplyItem,
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
  RULES_MAX_INJECTED,
  listRules,
  getActiveRules,
  createRule,
  updateRule,
  deleteRule,
  getUserSettings,
  setUserSettings,
  setStageApprovals,
  studioRulesBlock,
  loadRulesBlock,
  renderRulesBlock,
  setEvalRulesFixture,
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
export {
  buildKbRevertPayload,
  buildKbUpdatePayload,
  createKbRevertProposal,
  createKbUpdateItem,
  isProtectedKbPageName,
  kbProposalOf,
  kbWriteOf,
  markKbWriteQueued,
  normalizeKbPageName,
  recordKbWrite,
  saveKbProposalEdits,
  sha256Hex,
} from "./db/kbItems.js";
export type {
  KbChangeKind,
  KbProposal,
  KbSourceRef,
  KbUpdatePayloadInput,
  KbWriteRecord,
  KbWriteStatus,
} from "./db/kbItems.js";
export {
  detectKbUpdateProposal,
  kbUpdateDetectionEnabled,
  maybeProposeKbUpdate,
  KB_DETECT_MIN_CONFIDENCE,
} from "./brain/kbUpdate.js";
export type { KbDetection, KbDetectorDeps } from "./brain/kbUpdate.js";
export {
  getLearningState,
  advanceLearningState,
  normalizeRuleFingerprint,
  recordRejectedRuleProposal,
  listRejectedRuleFingerprints,
  signalsFromDecidedItem,
  collectLearningSignals,
  countOperatorDecisionsSince,
  maybeEnqueueLearningMineOnThreshold,
  ruleProposalOf,
  buildRuleProposalPayload,
  createRuleProposalItem,
  saveRuleProposalEdits,
  insertRuleFromProposal,
  recordRuleInsert,
  ruleInsertOf,
  LEARNING_MIN_SIGNALS,
  LEARNING_MINE_THRESHOLD,
  LEARNING_SIGNAL_ROW_CAP,
  LEARNING_EVIDENCE_MAX_CHARS,
} from "./db/learning.js";
export type {
  LearningState,
  LearningSignal,
  LearningSignalKind,
  CollectedSignals,
  RuleEvidence,
  RuleProposal,
  RuleProposalInput,
  RuleInsertRecord,
} from "./db/learning.js";
export {
  mineOperatorLessons,
  buildSignalDigest,
  defaultMinerDeps,
  LEARNING_DIGEST_MAX_SIGNALS,
} from "./brain/learnRules.js";
export type { LearningMinerDeps, MineResult } from "./brain/learnRules.js";
export {
  kbWriterConfigured,
  writeApprovedKbUpdate,
} from "./kb/write.js";
export type { KbWriteDeps, KbWriteJobResult } from "./kb/write.js";
export {
  syncContacts,
  DUPLICATE_AMBIGUOUS_PREFIX,
  type SyncContactsDeps,
  type SyncContactsResult,
} from "./campaigns/syncContacts.js";
export {
  pgCampaignStore,
  type CampaignStore,
  type ContactUpsert,
  type LiveContact,
  type ConsentState,
  type ConsentSource,
} from "./db/campaignContacts.js";
export {
  buildAudience,
  DEFAULT_AUDIENCE_VIEW,
  EXCLUSION_REASONS,
  type BuildAudienceDeps,
  type BuildAudienceOptions,
  type BuildAudienceResult,
  type AudienceRecipient,
  type AudienceExclusion,
  type ExclusionReason,
} from "./campaigns/buildAudience.js";
export {
  FALL_ANNOUNCEMENT_CAMPAIGN_KEY,
  FALL_ANNOUNCEMENT_AUDIENCE_VIEW,
  FALL_ANNOUNCEMENT_SEGMENTS,
  FALL_2026_SCHEDULE_FACTS,
  fallAnnouncementDraftRequest,
  unverifiedFallFacts,
  type FallAnnouncementSegment,
  type CampaignFact,
  type FactStatus,
} from "./campaigns/fallAnnouncement.js";
export {
  planSegmentVariants,
  findEmDashes,
  type SegmentVariant,
  type SegmentedDraftRequest,
  type SegmentDraftJob,
  type VariantPlan,
} from "./campaigns/draftVariants.js";
export {
  pgAudienceStore,
  type AudienceStore,
  type AudienceCandidate,
  type AudienceEntry,
  type CampaignRow,
} from "./db/campaignAudience.js";
export {
  computeSendDiff,
  type SendDiffDeps,
} from "./campaigns/sendDiff.js";
export {
  SEND_DIFF_SAMPLE_LIMIT,
  type SendDiff,
  type RecipientDelta,
  type PriorSendInfo,
} from "./campaigns/sendDiffTypes.js";
export {
  pgSendDiffStore,
  type SendDiffStore,
  type PriorSendRow,
} from "./db/sendDiff.js";
export {
  AUDIENCE_PERSONAS,
  FIXTURE_SEGMENT,
  FixtureAudienceStore,
  fixtureViewRows,
  fixtureDeps,
  type AudiencePersona,
  type PersonaFate,
} from "./campaigns/audienceFixtures.js";
export {
  campaignOverviewCounts,
  listCampaignSummaries,
  CAMPAIGN_STATUSES,
  CAMPAIGN_EVENT_TYPES,
  type CampaignOverviewCounts,
  type CampaignSummary,
  type CampaignEventCounts,
  type CampaignStatus,
} from "./db/campaignStats.js";
export {
  reconcileIdMapping,
  normalizeSourceId,
  SYNC_AMBIGUOUS_PREFIX,
  type ReconcileDeps,
  type ReconciliationReport,
} from "./campaigns/reconcile.js";
export {
  processResendWebhook,
  verifyResendSignature,
  resendWebhookSecret,
  isHardBounce,
  RESEND_EVENT_TYPES,
  RESEND_WEBHOOK_SECRET_VAR,
  SIGNATURE_TOLERANCE_MS,
  type ResendWebhookRequest,
  type ResendWebhookResponse,
  type ResendWebhookDeps,
  type ResendWebhookPayload,
  type SvixHeaders,
} from "./campaigns/resendWebhook.js";
export {
  pgResendEventStore,
  findSendByProviderMessageId,
  insertCampaignEvent,
  upsertSuppression,
  appendConsentEventOnce,
  type ResendEventStore,
  type CampaignEventType,
  type CampaignSendRef,
  type SuppressionReason,
} from "./db/campaignEvents.js";
export {
  mindbodyConfigured,
  fetchAllClients,
  extractClientRecord,
  verifyClientFields,
  MINDBODY_OPT_IN_FIELD,
  MINDBODY_CONSENT_FIELDS,
  type MindbodyClientRecord,
} from "./campaigns/mindbody.js";
export { createItemTool, toolsByName, toolsForJob } from "./tools/registry.js";
export {
  PAYROLL_ANCHOR,
  PERIOD_DAYS,
  periodContaining,
  parsePeriodLabel,
  nextPeriodStart,
  isInOpenPeriod,
  isPeriodClosed,
  studioToday,
  type PayPeriod,
} from "./payroll/period.js";
export {
  listPayRates,
  ratesInEffectOn,
  changePayRate,
  PayRateChangeError,
  listUnpaidQuotas,
  type PayRate,
  type UnpaidQuota,
} from "./db/payRates.js";
export {
  analyticsConfigured,
  analyticsToolCall,
  analyticsBlackout,
  pageSelect,
} from "./tools/analytics.js";
export {
  replayQuota,
  type QuotaClass,
  type QuotaArrangement,
  type QuotaClassOutcome,
  type QuotaReplayResult,
} from "./payroll/quota.js";
export {
  TraceRecorder,
  TRACE_MAX_CALLS,
  TRACE_REF_MAX_CHARS,
  TRACE_ARGS_MAX_CHARS,
  TRACE_ERROR_MAX_CHARS,
} from "./tools/trace.js";
export {
  captureEvalCase,
  captureRecordForItem,
  recordEvalCapture,
  CAPTURE_FIXTURE_MAX_CHARS,
  CAPTURE_CASE_MAX_CHARS,
  CAPTURE_EXCLUDED_TOOLS,
} from "./evals/capture.js";
export type {
  EvalCaptureRecord,
  ReplayFn,
  CaptureItemLike,
} from "./evals/capture.js";
export type {
  RunTrace,
  TraceCall,
  TraceCallInput,
  TraceOutcome,
} from "./tools/trace.js";
export { emitItemEvent, emitCampaignAlert, WORKFLOW_IDS } from "./notifications/emit.js";
export type {
  ItemEventType,
  AlertEventType,
  EventType,
  ItemEventPayload,
  CampaignAlertPayload,
  EventPayload,
  EmitResult,
  TriggerFn,
} from "./notifications/emit.js";
export {
  runCampaignMonitor,
  monitorConfigFromEnv,
  pgMonitorStore,
  alertKey,
  DEFAULT_MONITOR_CONFIG,
  HARD_BOUNCE_PREDICATE,
} from "./campaigns/monitor.js";
export type {
  CampaignMonitorConfig,
  CampaignMonitorResult,
  MonitorDeps,
  MonitorStore,
  CampaignRateStats,
  RollingRateStats,
  StuckCampaign,
  ZeroRecipientCampaign,
} from "./campaigns/monitor.js";
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

// --- Campaign draft + approval (SEA-83) -------------------------------
// Kept in one block so merge-time conflicts with parallel campaign lanes
// (SEA-86, SEA-88) stay one-hunk.
export {
  campaignDraft,
  assembleCampaignDraft,
  createCampaignApproval,
  campaignApprovalOf,
  containsEmDash,
  renderMergeFields,
  serializeSendDiff,
  UnknownMergeFieldError,
  defaultDraftCampaignDeps,
  defaultSendDiffProvider,
  onCampaignApproved,
  MERGE_FIELDS,
  EXCLUSION_SAMPLES_PER_REASON,
} from "./campaigns/draftCampaign.js";
// NOTE: the canonical SendDiff type is exported above from
// campaigns/sendDiffTypes.ts (SEA-86); this block adds only the payload
// (JSON-serialized) form and the provider seam.
export type {
  CampaignApprovalPayload,
  CampaignDraftAssembly,
  CampaignDraftInput,
  CreateApprovalResult,
  DraftCampaignDeps,
  SendDiffPayload,
  SendDiffProvider,
} from "./campaigns/draftCampaign.js";
export {
  decideCampaignApproval,
  listSnapshotRecipients,
  markCampaignPendingApproval,
} from "./db/campaignApproval.js";
export type {
  CampaignDecision,
  CampaignDecisionOutcome,
  CampaignDecisionRecord,
  SnapshotRecipient,
  TransactionClient,
  TransactionPool,
} from "./db/campaignApproval.js";
export { hasPermission, isRole } from "./rbac.js";
export type { Role, Permission } from "./rbac.js";
