/**
 * @ai-manager/features — vertical feature slices (email, social, analytics, expenses).
 *
 * Feature modules export brain jobs here; the worker entry point passes
 * featureJobs to core's registerJobs() before the schedule sweep runs
 * (SEA-101), so a feature contributes a job without core importing this
 * package (which would be a dependency cycle).
 */
import type { Job } from "@ai-manager/core";

export const FEATURES_PACKAGE = "@ai-manager/features";

/** Every job contributed by feature modules. Payroll et al. land here. */
export const featureJobs: Job[] = [];
