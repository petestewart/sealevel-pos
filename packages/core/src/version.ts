/**
 * Deploy-version stamp (GH-122 first slice, run trace). Railway injects the
 * built commit as RAILWAY_GIT_COMMIT_SHA; every drafting run stamps this on
 * the item it creates (payload.generated_by) so "which code drafted this?"
 * is a lookup instead of a deploy-timeline reconstruction. Outside Railway
 * (local dev, smokes) it reads "dev".
 */
export function workerVersion(): string {
  return (process.env["RAILWAY_GIT_COMMIT_SHA"] ?? "dev").slice(0, 7);
}
