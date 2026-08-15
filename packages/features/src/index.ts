/**
 * @ai-manager/features — vertical feature slices (email, social, analytics, expenses).
 *
 * Feature modules export brain jobs here; the worker entry point passes
 * featureJobs to core's registerJobs() before the schedule sweep runs
 * (SEA-101), so a feature contributes a job without core importing this
 * package (which would be a dependency cycle).
 */
import type { Job } from "@ai-manager/core";

import { payrollPrepare } from "./payroll/prepare.js";

export const FEATURES_PACKAGE = "@ai-manager/features";

/** Every job contributed by feature modules. */
export const featureJobs: Job[] = [payrollPrepare];

export { payrollPrepare, type PayrollPreparePayload } from "./payroll/prepare.js";
export {
  computePayroll,
  type PayrollComputation,
  type TeacherInvoice,
  type TeacherPeriodInput,
  type InvoiceClassLine,
  type PeriodClass,
  type QuotaInput,
  type RunBlocker,
} from "./payroll/compute.js";
export {
  checkFreshness,
  readPeriodTeachers,
  readQuotaHistory,
  rateForClassDate,
} from "./payroll/reads.js";
export {
  dispatchSyncAndWait,
  syncDispatchConfigured,
  type SyncDispatchResult,
} from "./payroll/sync.js";
