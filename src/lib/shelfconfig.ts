/**
 * T74: shelf customization. Pete: "we need to be able to hide certain
 * items. for instance, Auto monthly grandfathered should never be
 * available to sell. same with expired specials", and "in passes we
 * should be able to have sub-categories. class packs, unlimited,
 * specials".
 *
 * The config is a hide list and a grouping, nothing else: which catalog
 * items never reach the shelf, and which pass sub-category each pricing
 * option files under. It is exactly what the T29 charter admits into the
 * database (Mindbody has no home for either), and it holds NO copy of
 * the catalog: only keys and ids, resolved against the live catalog at
 * response time. A key that no longer matches anything is harmless.
 *
 * This module is pure and dependency-free on purpose: the catalog route,
 * the admin route and a plain node test share one rule, and the dev
 * drawer re-declares the shape it needs (the codebase's convention for
 * keeping server modules out of the client bundle).
 */

export interface ShelfGroup {
  /** The sub-category label as the sale screen shows it. */
  label: string;
  /** Pricing option ids (the `Service` type's numeric id) as strings. */
  ids: string[];
}

export interface ShelfConfig {
  /** Items that never reach the shelf, as "<Type>:<id>" keys, the type
   *  being the catalog item's `type` ("Product" | "Service" | "Package")
   *  or "Contract" for a membership contract, the id as a string. */
  hidden: string[];
  /** Pass sub-categories, in rail order. A pass in no group is
   *  ungrouped. */
  groups: ShelfGroup[];
}

/** The code default: nothing hidden, no groups. What the shelf is
 *  without a database, and what a bad stored config falls back to. */
export const shelfConfigDefault: ShelfConfig = { hidden: [], groups: [] };

/** The app_settings key the config lives under. */
export const SHELF_SETTING_KEY = "shelf_config";

/** The four kinds a hide key may name. Contracts are not CatalogItems
 *  (they sell through the Memberships dialog, T30), so the key carries
 *  its own type name for them. */
export type ShelfItemType = "Product" | "Service" | "Package" | "Contract";

const ITEM_TYPES: readonly ShelfItemType[] = [
  "Product",
  "Service",
  "Package",
  "Contract",
];

export const MAX_GROUPS = 12;
export const MAX_GROUP_LABEL = 40;
/** A bound on the hide list and on one group's ids. The whole catalog
 *  is a few dozen items; a stored row with thousands of entries is not
 *  a config, it is a fault, and it is refused rather than applied on
 *  every catalog request. */
export const MAX_ENTRIES = 1000;
/** The sale screen's own label for the passes in no group (SaleScreen
 *  OTHER_GROUP_LABEL). A group so named would draw two "Other" chips
 *  and two "Other" sections, so it is refused here, case-insensitively. */
export const RESERVED_GROUP_LABEL = "Other";

/** The hide-list key for an item: one rule for the route, the admin
 *  surface and the tests. Ids compare as strings, since a product's id
 *  is a barcode string and a pass's a number. */
export function itemKey(type: ShelfItemType, id: string | number): string {
  return `${type}:${String(id)}`;
}

/**
 * The shape gate on the way IN (the admin PUT) and on the way OUT of the
 * table (a stored value nobody can trust blindly). Returns the cleaned
 * config, or `{ error }` naming the first rule broken. Labels are trimmed,
 * ids trimmed and de-duplicated, hidden keys de-duplicated.
 */
export function validateShelfConfig(
  input: unknown,
): ShelfConfig | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "config must be an object with hidden and groups" };
  }
  const { hidden, groups } = input as Record<string, unknown>;

  if (!Array.isArray(hidden)) {
    return { error: "hidden must be an array of \"<Type>:<id>\" keys" };
  }
  if (hidden.length > MAX_ENTRIES) {
    return { error: `at most ${MAX_ENTRIES} hidden keys` };
  }
  const cleanHidden: string[] = [];
  const seenHidden = new Set<string>();
  for (const raw of hidden) {
    if (typeof raw !== "string") {
      return { error: "every hidden entry must be a string key" };
    }
    const key = raw.trim();
    const colon = key.indexOf(":");
    const type = colon > 0 ? key.slice(0, colon) : "";
    const id = colon > 0 ? key.slice(colon + 1).trim() : "";
    if (!ITEM_TYPES.includes(type as ShelfItemType) || id.length === 0) {
      return {
        error: `hidden key ${JSON.stringify(raw)} is not "<Product|Service|Package|Contract>:<id>"`,
      };
    }
    const clean = `${type}:${id}`;
    if (seenHidden.has(clean)) continue;
    seenHidden.add(clean);
    cleanHidden.push(clean);
  }

  if (!Array.isArray(groups)) {
    return { error: "groups must be an array of { label, ids }" };
  }
  if (groups.length > MAX_GROUPS) {
    return { error: `at most ${MAX_GROUPS} groups` };
  }
  const cleanGroups: ShelfGroup[] = [];
  const seenLabels = new Set<string>();
  const seenIds = new Map<string, string>();
  for (const raw of groups) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: "every group must be an object with label and ids" };
    }
    const { label, ids } = raw as Record<string, unknown>;
    if (typeof label !== "string") {
      return { error: "every group needs a label" };
    }
    const cleanLabel = label.trim();
    if (cleanLabel.length === 0 || cleanLabel.length > MAX_GROUP_LABEL) {
      return {
        error: `group label must be 1 to ${MAX_GROUP_LABEL} characters`,
      };
    }
    if (cleanLabel.includes("—")) {
      return { error: `group label ${JSON.stringify(cleanLabel)} must not contain an em dash` };
    }
    const folded = cleanLabel.toLowerCase();
    if (folded === RESERVED_GROUP_LABEL.toLowerCase()) {
      return {
        error: `group label ${JSON.stringify(RESERVED_GROUP_LABEL)} is reserved for the passes in no group`,
      };
    }
    if (seenLabels.has(folded)) {
      return { error: `group label ${JSON.stringify(cleanLabel)} is used twice` };
    }
    seenLabels.add(folded);
    if (!Array.isArray(ids)) {
      return { error: `group ${JSON.stringify(cleanLabel)} needs an ids array` };
    }
    if (ids.length > MAX_ENTRIES) {
      return {
        error: `group ${JSON.stringify(cleanLabel)}: at most ${MAX_ENTRIES} ids`,
      };
    }
    const cleanIds: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || id.trim().length === 0) {
        return {
          error: `group ${JSON.stringify(cleanLabel)}: every id must be a non-empty string`,
        };
      }
      const cleanId = id.trim();
      const already = seenIds.get(cleanId);
      if (already !== undefined && already !== cleanLabel) {
        return {
          error: `pass ${cleanId} is in both ${JSON.stringify(already)} and ${JSON.stringify(cleanLabel)}`,
        };
      }
      /* Seen already in THIS group (the other case returned above). */
      if (already !== undefined) continue;
      seenIds.set(cleanId, cleanLabel);
      cleanIds.push(cleanId);
    }
    cleanGroups.push({ label: cleanLabel, ids: cleanIds });
  }

  return { hidden: cleanHidden, groups: cleanGroups };
}

/**
 * A stored value into a config. Anything that is not valid JSON of a
 * valid config yields the default plus the reason, and the caller logs
 * it once; the shelf never breaks over a bad row.
 */
export function parseShelfConfig(
  raw: string | null,
): { config: ShelfConfig; stored: boolean; error: string | null } {
  if (raw === null) {
    return { config: shelfConfigDefault, stored: false, error: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      config: shelfConfigDefault,
      stored: false,
      error: `not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = validateShelfConfig(parsed);
  if ("error" in result) {
    /* Keys only, and a few of them: the log line must never carry the
     * blob, nor ten thousand array indices. */
    const keys = Array.isArray(parsed)
      ? `an array of ${parsed.length}`
      : typeof parsed === "object" && parsed !== null
        ? Object.keys(parsed).slice(0, 10).join(", ")
        : typeof parsed;
    return {
      config: shelfConfigDefault,
      stored: false,
      error: `${result.error} (keys: ${keys || "none"})`,
    };
  }
  return { config: result, stored: true, error: null };
}

/** The least a shelf item needs to be filtered: its type and id. */
export interface Keyed {
  type: "Product" | "Service" | "Package";
  id: string | number;
}

export interface ShelfInput<P extends Keyed, S extends Keyed, C extends { id: number }> {
  products: P[];
  passes: S[];
  packages: P[];
  contracts: C[];
}

export interface ShelfOutput<P extends Keyed, S extends Keyed, C extends { id: number }> {
  products: P[];
  /** Every pass gains `group`: its sub-category label, or null. */
  passes: (S & { group: string | null })[];
  packages: P[];
  contracts: C[];
  /** Group labels in rail order, only those with at least one visible
   *  pass, so the screen never draws an empty chip. */
  passGroups: string[];
}

/**
 * The config over a catalog: hidden items dropped from all four arrays,
 * every pass labelled with its group, and the list of groups that have
 * something to show. Pure, so /api/catalog applies it at response time
 * over the cached raw catalog and the test applies it over a fixture.
 */
export function applyShelfConfig<
  P extends Keyed,
  S extends Keyed,
  C extends { id: number },
>(catalog: ShelfInput<P, S, C>, config: ShelfConfig): ShelfOutput<P, S, C> {
  const hidden = new Set(config.hidden);
  const visible = (item: Keyed) => !hidden.has(itemKey(item.type, item.id));
  const groupOf = new Map<string, string>();
  for (const g of config.groups) {
    for (const id of g.ids) {
      if (!groupOf.has(id)) groupOf.set(id, g.label);
    }
  }
  const passes = catalog.passes.filter(visible).map((p) => ({
    ...p,
    group: groupOf.get(String(p.id)) ?? null,
  }));
  const present = new Set(passes.map((p) => p.group));
  return {
    products: catalog.products.filter(visible),
    passes,
    packages: catalog.packages.filter(visible),
    contracts: catalog.contracts.filter(
      (c) => !hidden.has(itemKey("Contract", c.id)),
    ),
    passGroups: config.groups
      .map((g) => g.label)
      .filter((label) => present.has(label)),
  };
}
