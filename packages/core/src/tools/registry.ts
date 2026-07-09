import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";

import { createItem } from "../db/items.js";

/**
 * Tool registry (ARCHITECTURE.md "Tools and outbound guardrails").
 *
 * Tools use the SDK's betaZodTool shape (Zod schema + run) and are looked
 * up by name so each job scopes to exactly the capabilities it declares
 * in Job.tools. Adding a tool = define it here (or in a feature module)
 * and add it to TOOLS. Outbound/destructive tools must be idempotent and
 * may be approval-gated; the starter tool below is local and safe.
 */

/**
 * Starter tool: write a row to the items backbone. Safe and local; it is
 * how a job surfaces work for a human (an email to answer, a draft
 * pending approval, an anomaly to look at) without acting outward.
 */
export const createItemTool = betaZodTool({
  name: "create_item",
  description:
    "Create an item in the operational backbone: a unit of work for a human, such as an email to answer, a draft pending approval, or an anomaly to review. Returns the created item's id and status.",
  inputSchema: z.object({
    type: z
      .string()
      .min(1)
      .describe(
        'Item type, e.g. "email.inbound", "social.draft", "anomaly.attendance".',
      ),
    domain: z
      .string()
      .optional()
      .describe('Business domain, e.g. "email", "social", "analytics".'),
    status: z
      .enum(["open", "unassigned", "pending_approval"])
      .optional()
      .describe(
        'Initial status. Defaults to "open". Use "unassigned" when a human owner is not yet known, "pending_approval" for drafts awaiting approval.',
      ),
    audience: z.string().optional().describe("Intended audience, if any."),
    assignee: z
      .string()
      .optional()
      .describe("Human owner, if already known."),
    payload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Item body: the draft, the parsed email, the anomaly details."),
  }),
  run: async (input) => {
    const item = await createItem(input);
    return JSON.stringify({ id: item.id, status: item.status });
  },
});

const TOOLS = [createItemTool];

// BetaRunnableTool<any>: the registry is heterogeneous and each tool's input
// type appears both contravariantly (run) and covariantly (parse), so no
// single non-any type parameter admits every tool. Inputs are still validated
// at runtime by each tool's own Zod schema.
/** All registered tools, looked up by name for per-job scoping. */
export const toolsByName: Record<string, BetaRunnableTool<any>> =
  Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/** Resolve a job's declared tool names to runnable tools; unknown names throw. */
export function toolsForJob(names: string[]): BetaRunnableTool<any>[] {
  return names.map((name) => {
    const tool = toolsByName[name];
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  });
}
