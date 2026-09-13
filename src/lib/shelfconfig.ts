/**
 * T74: shelf customization. Pete: "we need to be able to hide certain
 * items. for instance, Auto monthly grandfathered should never be
 * available to sell. same with expired specials", and "in passes we
 * should be able to have sub-categories. class packs, unlimited,
 * specials".
 *
 * The config is a hide list and a grouping, nothing else: which catalog
 * items never reach the shelf, and which pass sub-category each pricing
 * option files under. Since T76 the grouping is an OVERRIDE: every pass
 * is filed by rule (`passGroupByRule`, from its name and option fields)
 * into one of the fixed PASS_GROUPS, and a T74 group moves the passes
 * it names, to a fixed label or a custom one. It is exactly what the
 * T29 charter admits into the database (Mindbody has no home for
 * either), and it holds NO copy of the catalog: only keys and ids,
 * resolved against the live catalog at response time. A key that no
 * longer matches anything is harmless.
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

/**
 * T76: the Passes rail's fixed sub-categories, in rail order. Pete's list
 * ("Drop-in / Packs / Specials (new student, etc) / Teen/Child / Buddy
 * Pass / Guest Passes / Trainings / Workshops / Fees / Unlimited
 * Passes"), with Drop-in and Packs combined at his word and Buddy and
 * Guest passes on one cell. Each shows only when it has a visible pass.
 * Memberships (T30 contracts) and Packages (T30 packages) sit after
 * these on the screen; they are not pass groups and never appear here.
 */
export const PASS_GROUPS = [
  "Drop-in & Packs",
  "Specials",
  "Teen/Child",
  "Buddy/Guest",
  "Trainings",
  "Workshops",
  "Fees",
  "Unlimited",
] as const;

export type PassGroupLabel = (typeof PASS_GROUPS)[number];

/** The fields the rule reads off a pricing option: what /sale/services
 *  returns on site 471 (live, 2026-09-13) beyond the name. `Type` is
 *  DropIn | Series | Unlimited there; `Program` and `RevenueCategory`
 *  are names ("Classes"). Any of them may be missing. */
export interface PassRuleInput {
  name: string;
  serviceType?: string | null;
  isIntroOffer?: boolean | null;
  program?: string | null;
  revenueCategory?: string | null;
}

/**
 * T76: which fixed sub-category a pricing option files under when no
 * T74 group names it. First match wins, in this order: a name saying
 * teen, child, kid or youth; a name saying guest or buddy; training
 * anywhere in the name, program or revenue category; workshop or event
 * likewise; fee likewise; an intro offer; Type DropIn or Series;
 * Type Unlimited; and anything else is a Special, which is where an
 * option nobody can classify is least likely to be missed.
 *
 * "Teen/Child - add requirements" is open with Pete; the group is a
 * plain sub-category here (see `PassGroupSeam`).
 */
export function passGroupByRule(service: PassRuleInput): PassGroupLabel {
  const name = service.name;
  const anywhere = [name, service.program ?? "", service.revenueCategory ?? ""].join(
    "\n",
  );
  if (/teen|child|kid|youth/i.test(name)) return "Teen/Child";
  if (/guest|buddy/i.test(name)) return "Buddy/Guest";
  if (/training/i.test(anywhere)) return "Trainings";
  if (/workshop|event/i.test(anywhere)) return "Workshops";
  if (/\bfee\b|fees/i.test(anywhere)) return "Fees";
  if (service.isIntroOffer === true) return "Specials";
  const type = (service.serviceType ?? "").trim().toLowerCase();
  if (type === "dropin" || type === "series") return "Drop-in & Packs";
  if (type === "unlimited") return "Unlimited";
  return "Specials";
}

/** The seam for Pete's "Teen/Child - add requirements", unused until he
 *  says what the requirement is (a waiver? a guardian on file? an age
 *  field?). A pass group may one day carry one; nothing reads it. */
export interface PassGroupSeam {
  label: PassGroupLabel;
  requirement?: string;
}

/** A configured group label folded onto the fixed one it names, so a
 *  stored "specials" (any case) is the rail's Specials and not a second
 *  cell; a label naming no fixed group is a custom label, kept as is. */
export function canonicalGroupLabel(label: string): string {
  const folded = label.trim().toLowerCase();
  /* The label this group shipped with under T76, so an override stored
   * before the rename still lands on the fixed cell. */
  if (folded === "buddy / guest passes") return "Buddy/Guest";
  return PASS_GROUPS.find((g) => g.toLowerCase() === folded) ?? label.trim();
}

/** The least a shelf item needs to be filtered: its type and id. */
export interface Keyed {
  type: "Product" | "Service" | "Package";
  id: string | number;
}

/** What a pass needs beyond its key for the rule: its name and the
 *  option fields, and `categoryId` so a pass T41 routed off the Passes
 *  shelf (a rental) takes no group. */
export interface PassKeyed extends Keyed, PassRuleInput {
  categoryId?: number | null;
}

export interface ShelfInput<P extends Keyed, S extends PassKeyed, C extends { id: number }> {
  products: P[];
  passes: S[];
  packages: P[];
  contracts: C[];
}

export interface ShelfOutput<P extends Keyed, S extends PassKeyed, C extends { id: number }> {
  products: P[];
  /** Every pass gains `group`: its sub-category label. Since T76 a pass
   *  on the Passes shelf always has one (a T74 group's label when the
   *  config names it, else the rule's); null only for a pass T41 routed
   *  to another shelf, where sub-categories do not apply. */
  passes: (S & { group: string | null })[];
  packages: P[];
  contracts: C[];
  /** Group labels in rail order: the fixed PASS_GROUPS first, then any
   *  custom T74 label in config order, only those with at least one
   *  visible pass on the Passes shelf, so the screen never draws an
   *  empty cell. */
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
  S extends PassKeyed,
  C extends { id: number },
>(catalog: ShelfInput<P, S, C>, config: ShelfConfig): ShelfOutput<P, S, C> {
  const hidden = new Set(config.hidden);
  const visible = (item: Keyed) => !hidden.has(itemKey(item.type, item.id));
  /* T74's groups are the override: a pass a group names goes there,
   * under the fixed label when the group's label names one. */
  const groupOf = new Map<string, string>();
  for (const g of config.groups) {
    const label = canonicalGroupLabel(g.label);
    for (const id of g.ids) {
      if (!groupOf.has(id)) groupOf.set(id, label);
    }
  }
  const onPassesShelf = (p: PassKeyed) =>
    p.categoryId === undefined || p.categoryId === null;
  const passes = catalog.passes.filter(visible).map((p) => ({
    ...p,
    group: onPassesShelf(p)
      ? (groupOf.get(String(p.id)) ?? passGroupByRule(p))
      : null,
  }));
  const present = new Set(passes.filter(onPassesShelf).map((p) => p.group));
  const fixed: string[] = PASS_GROUPS.filter((label) => present.has(label));
  const custom = config.groups
    .map((g) => canonicalGroupLabel(g.label))
    .filter(
      (label, i, all) =>
        present.has(label) &&
        !fixed.includes(label) &&
        all.indexOf(label) === i,
    );
  return {
    products: catalog.products.filter(visible),
    passes,
    packages: catalog.packages.filter(visible),
    contracts: catalog.contracts.filter(
      (c) => !hidden.has(itemKey("Contract", c.id)),
    ),
    passGroups: [...fixed, ...custom],
  };
}
