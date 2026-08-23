import { getPool } from "./client.js";

/**
 * Teacher -> QuickBooks vendor links (SEA-119), the data layer under the
 * console's vendor-link controls on the Teacher pay rates page and under
 * the payroll push job's payee lookup.
 *
 * Identity rules (migration 0020):
 * - Keyed on mb_staff_id, the same stable identity as pay rates, the
 *   payroll ledger, and the Bill DocNumber.
 * - Stores the QBO Vendor.Id, never a name: name matching is how a wrong
 *   payee happens silently. qbo_vendor_name is a display mirror only.
 * - A teacher without a link is a terminal, honest push failure — the
 *   same posture as a missing pay rate. Nothing here ever creates a
 *   vendor in QBO (policy 10).
 */

/** One qbo_vendor_map row as the console reads it. */
export interface QboVendorLink {
  mb_staff_id: number;
  qbo_vendor_id: string;
  qbo_vendor_name: string | null;
  updated_by: string | null;
  updated_at: string;
}

const LINK_COLUMNS = `mb_staff_id, qbo_vendor_id, qbo_vendor_name,
  updated_by, updated_at::text`;

/** Why a link change was refused; surfaced inline in the form. */
export class VendorLinkError extends Error {}

/**
 * Validate an operator-entered QBO Vendor Id. QBO ids are opaque strings,
 * in practice short digit runs ("58"); the guard exists to catch pasting
 * the wrong thing entirely (a name, a URL, an empty field), not to model
 * Intuit's id format. Returns the trimmed id.
 */
export function parseVendorId(raw: string): string {
  const id = raw.trim();
  if (id.length === 0) {
    throw new VendorLinkError("Enter the QuickBooks vendor id.");
  }
  if (!/^[0-9]+$/.test(id)) {
    throw new VendorLinkError(
      "That does not look like a QuickBooks vendor id (a number, e.g. 58). Open the vendor in QuickBooks and copy the number after nameId= in the address bar.",
    );
  }
  return id;
}

/** Every stored link, keyed by mb_staff_id, for the pay-rates page. */
export async function listVendorLinks(): Promise<Map<number, QboVendorLink>> {
  const { rows } = await getPool().query<QboVendorLink>(
    `SELECT ${LINK_COLUMNS} FROM qbo_vendor_map`,
  );
  return new Map(rows.map((r) => [r.mb_staff_id, r]));
}

/** The link for one teacher, or null — the push job's payee lookup. */
export async function vendorLinkFor(
  mbStaffId: number,
): Promise<QboVendorLink | null> {
  const { rows } = await getPool().query<QboVendorLink>(
    `SELECT ${LINK_COLUMNS} FROM qbo_vendor_map WHERE mb_staff_id = $1`,
    [mbStaffId],
  );
  return rows[0] ?? null;
}

/**
 * Set (or replace) one teacher's vendor link. An upsert: relinking a
 * teacher to a different vendor is an ordinary correction — unlike rates,
 * the link carries no history (the Bills in QBO are the audit trail).
 * The UNIQUE(qbo_vendor_id) constraint refuses pointing two teachers at
 * one vendor; that refusal surfaces as a VendorLinkError naming the
 * conflict so the operator clears the stale link deliberately.
 */
export async function setVendorLink(input: {
  mbStaffId: number;
  vendorId: string;
  vendorName: string | null;
  updatedBy: string;
}): Promise<QboVendorLink> {
  const vendorId = parseVendorId(input.vendorId);
  try {
    const { rows } = await getPool().query<QboVendorLink>(
      `INSERT INTO qbo_vendor_map
         (mb_staff_id, qbo_vendor_id, qbo_vendor_name, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (mb_staff_id) DO UPDATE SET
         qbo_vendor_id = EXCLUDED.qbo_vendor_id,
         qbo_vendor_name = EXCLUDED.qbo_vendor_name,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING ${LINK_COLUMNS}`,
      [input.mbStaffId, vendorId, input.vendorName, input.updatedBy],
    );
    const saved = rows[0];
    if (!saved) throw new Error("setVendorLink: upsert returned no row");
    return saved;
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === "23505") {
      throw new VendorLinkError(
        `QuickBooks vendor ${vendorId} is already linked to another teacher. Two teachers must never share a payee; unlink the other teacher first if this is a correction.`,
      );
    }
    throw err;
  }
}

/**
 * Remove one teacher's link (e.g. a teacher re-keyed upstream, or a link
 * entered in error). Returns whether a row was actually removed. Pushes
 * for the teacher fail terminally-but-honestly until relinked.
 */
export async function clearVendorLink(mbStaffId: number): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM qbo_vendor_map WHERE mb_staff_id = $1`,
    [mbStaffId],
  );
  return (result.rowCount ?? 0) > 0;
}
