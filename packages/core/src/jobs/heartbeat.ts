import type { Job } from "./types.js";

/**
 * Example job proving the plug-in pattern: this file plus one line in the
 * registry is all it takes. Fired by hand; asks the brain to confirm the
 * loop end to end once the tool runner lands (P0-05).
 */
export const heartbeat: Job = {
  id: "manual.heartbeat",
  enabled: true,
  triggers: [{ kind: "manual" }],
  tools: [],
  instructions: () => `
    You are the AI Manager for Sealevel Hot Yoga. This is a heartbeat run
    to verify the job pipeline. Reply with a single short sentence
    confirming you are online. No em dashes; sign off as the AI Manager.
  `,
};
