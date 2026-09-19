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
 * T86 added the two things Pete asked for next: `groupOrder`, the order
 * the rail draws the pass sub-categories in, and `products`, one retail
 * product moved off Mindbody's own category onto another counter cell.
 * Both are optional, so a config stored before T86 reads exactly as it
 * did.
 *
 * This module is pure on purpose: the catalog route, the admin route and
 * a plain node test share one rule, and the dev drawer re-declares the
 * shape it needs (the codebase's convention for keeping server modules
 * out of the client bundle). Its one import, T86's, is categories.ts,
 * which is pure data with no imports of its own: the category ids a
 * product may be moved to are read off `counterCategories` rather than
 * repeated here, since a second copy would drift the day a Retail child
 * is added. Nothing else may be imported: a server module here would end
 * that.
 */

import { counterCategories } from "./categories";

export interface ShelfGroup {
  /** The sub-category label as the sale screen shows it. */
  label: string;
  /** Pricing option ids (the `Service` type's numeric id) as strings. */
  ids: string[];
}

/**
 * T86: one retail product moved off Mindbody's own category onto another
 * counter cell. Pete: "why can't i set categories on retail items in the
 * shelf? only passes?" A product's category is Mindbody's (T41 routes
 * rentals by name on top of it); this names the cell the counter files it
 * under instead, and nothing else about the item changes.
 */
export interface ShelfProductOverride {
  /** The product's hide-list key, `itemKey("Product", id)`. The same key
   *  the hide list uses, so one row can be both moved and hidden. */
  key: string;
  /** A Retail child's or Rentals' category id from categories.ts
   *  `counterCategories` (36, 26, 32, 49, -14). Any other id is refused:
   *  a product filed under a category the rail does not draw would
   *  simply vanish. */
  categoryId: number;
}

/**
 * T112: one refused pass and the pass to offer instead of it.
 *
 * Pete, 2026-09-19, having asked for an Override on a pass Mindbody's own
 * rules refuse: "if that doesn't work then we can use the 'Returning
 * Student 2-week unlimited' item and discount it to be at the standard
 * 2-week special price behind the scenes". On site 471 that is 555,
 * "Returning Student 2-wk Unlimited (1+ Years Away)" at $79.00, sold at
 * the New Student Intro's $59.00. The customer gets the same two weeks
 * for the same money and Mindbody records a different product.
 *
 * It is CONFIGURATION and not a constant in the code, for the reason
 * every other shelf decision is: the studio changes its passes, and a
 * mapping compiled into a deploy would be wrong the first time it did.
 * Ids only, as the T29 charter requires, with both prices read from the
 * live catalog at the moment of the offer (`resolveSubstitute` in
 * src/lib/substitute.ts): no price is ever stored here.
 */
export interface PassSubstitute {
  /** The pass Mindbody refused, as a Service id string. */
  refusedId: string;
  /** The pass to sell instead, as a Service id string. */
  substituteId: string;
  /** Discount the substitute to the refused pass's own live price. False
   *  sells the substitute at its own price, which is the honest shape for
   *  a mapping between two passes that already cost the same. */
  matchPrice: boolean;
}

export interface ShelfConfig {
  /** Items that never reach the shelf, as "<Type>:<id>" keys, the type
   *  being the catalog item's `type` ("Product" | "Service" | "Package"),
   *  "Contract" for a membership contract or, since T97, "GiftCard" for a
   *  gift card product, the id as a string. */
  hidden: string[];
  /** Pass sub-categories, in rail order. A pass in no group is
   *  ungrouped. */
  groups: ShelfGroup[];
  /** T86: the pass sub-categories in the order the rail draws them,
   *  fixed labels and custom ones together. Absent (a config from before
   *  T86) means the code order: the fixed PASS_GROUPS, then custom
   *  labels in config order. A label this does not name keeps that
   *  order, after the ones it does. Pete: "can i also change the order
   *  of subcategories easily". */
  groupOrder?: string[];
  /** T86: retail products moved to another counter category. */
  products?: ShelfProductOverride[];
  /** T112: the substitute a refused pass may be sold as. Absent (every
   *  config before T112) means no substitution is ever offered. */
  substitutes?: PassSubstitute[];
}

/** The code default: nothing hidden, no groups. What the shelf is
 *  without a database, and what a bad stored config falls back to. */
export const shelfConfigDefault: ShelfConfig = { hidden: [], groups: [] };

/** The app_settings key the config lives under. */
export const SHELF_SETTING_KEY = "shelf_config";

/** The kinds a hide key may name. Contracts are not CatalogItems
 *  (they sell through the Memberships dialog, T30), so the key carries
 *  its own type name for them. T97 added GiftCard: a gift card product
 *  comes from /sale/giftcards rather than the catalog (T95), which is the
 *  only reason it was not here, and Pete asked for exactly this config
 *  over it ("the app should only have these preset options + the custom
 *  amount one ... what is the best way to do that so we can edit what is
 *  available easily"). */
export type ShelfItemType =
  | "Product"
  | "Service"
  | "Package"
  | "Contract"
  | "GiftCard";

const ITEM_TYPES: readonly ShelfItemType[] = [
  "Product",
  "Service",
  "Package",
  "Contract",
  "GiftCard",
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
/** The two Passes children that are not pass groups (T30 packages from
 *  /sale/packages, T30 contracts from /sale/contracts) but sit in the
 *  same rail. Since Pete's 2026-09-14 "why isn't Memberships in the
 *  settings where i can change the order of subcategories?" they take
 *  part in `groupOrder` like any label; a custom group may not borrow
 *  either name, since the rail would draw two cells of it. */
export const PINNED_PASS_CHILDREN = ["Packages", "Memberships"] as const;
/** T86: a bound on `groupOrder`. The rail can hold the eight fixed labels
 *  plus MAX_GROUPS custom ones, so 64 is far more than a real config
 *  needs and small enough that a fault is refused rather than sorted on
 *  every catalog request. */
export const MAX_GROUP_ORDER = 64;

/**
 * T86: the category ids a product override may name, read off
 * `counterCategories` rather than repeated here, so adding a Retail child
 * to that list is the only edit needed. The Passes entry is excluded: it
 * carries no ids, and a retail product has no business on the Passes
 * shelf.
 */
export const PRODUCT_CATEGORY_IDS: readonly number[] = counterCategories
  .filter((c) => c.section !== "Passes")
  .flatMap((c) => c.categoryIds);

/** The hide-list key for an item: one rule for the route, the admin
 *  surface and the tests. Ids compare as strings, since a product's id
 *  is a barcode string and a pass's a number. */
export function itemKey(type: ShelfItemType, id: string | number): string {
  return `${type}:${String(id)}`;
}

/** T97: what a caller may tell the validator about the live gift card
 *  products. Only the admin PUT knows it (it reads /sale/giftcards), and
 *  it is optional so every other caller validates exactly as before. */
export interface ValidateShelfOptions {
  /** The id of the ONE editable gift card product (T96), when it is
   *  known. A `GiftCard:<that id>` hide key is refused in words. */
  editableGiftCardId?: number | null;
}

/**
 * The shape gate on the way IN (the admin PUT) and on the way OUT of the
 * table (a stored value nobody can trust blindly). Returns the cleaned
 * config, or `{ error }` naming the first rule broken. Labels are trimmed,
 * ids trimmed and de-duplicated, hidden keys de-duplicated.
 */
export function validateShelfConfig(
  input: unknown,
  opts: ValidateShelfOptions = {},
): ShelfConfig | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "config must be an object with hidden and groups" };
  }
  const { hidden, groups, groupOrder, products, substitutes } = input as Record<
    string,
    unknown
  >;

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
        error: `hidden key ${JSON.stringify(raw)} is not "<Product|Service|Package|Contract|GiftCard>:<id>"`,
      };
    }
    const clean = `${type}:${id}`;
    /* T97: the editable gift card product is the number pad's product,
     * and hiding it would turn the pad off with nothing on the screen to
     * say why. Refused in words, and only when the caller knows which
     * product that is: the way OUT of the table (parseShelfConfig) does
     * not, deliberately, so a stored key can never invalidate the whole
     * config and throw the rest of the hide list away with it. The filter
     * itself never hides an editable product either (`giftCardHidden`),
     * which is what actually protects the pad. */
    if (
      opts.editableGiftCardId !== undefined &&
      opts.editableGiftCardId !== null &&
      clean === itemKey("GiftCard", opts.editableGiftCardId)
    ) {
      return {
        error:
          "the custom amount gift card cannot be hidden: it is the product " +
          "the number pad sells any amount through",
      };
    }
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
    if (PINNED_PASS_CHILDREN.some((l) => l.toLowerCase() === folded)) {
      return {
        error: `group label ${JSON.stringify(label)} is the rail's own ${folded === "packages" ? "Packages" : "Memberships"} cell`,
      };
    }
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

  /* T86: the sub-category order. A label naming neither a fixed group
   * nor a group in this config is DROPPED rather than refused: removing
   * a custom group must not make the whole stored config invalid and
   * throw the hide list away with it. Duplicates fold the same way. */
  let cleanOrder: string[] | undefined;
  if (groupOrder !== undefined && groupOrder !== null) {
    if (!Array.isArray(groupOrder)) {
      return { error: "groupOrder must be an array of sub-category labels" };
    }
    if (groupOrder.length > MAX_GROUP_ORDER) {
      return { error: `at most ${MAX_GROUP_ORDER} groupOrder labels` };
    }
    const known = new Set<string>([
      ...PASS_GROUPS.map((g) => g.toLowerCase()),
      ...PINNED_PASS_CHILDREN.map((g) => g.toLowerCase()),
      ...cleanGroups.map((g) => canonicalGroupLabel(g.label).toLowerCase()),
    ]);
    const seenOrder = new Set<string>();
    cleanOrder = [];
    for (const raw of groupOrder) {
      if (typeof raw !== "string") {
        return { error: "every groupOrder entry must be a label string" };
      }
      const label = canonicalGroupLabel(raw);
      const folded = label.toLowerCase();
      if (!known.has(folded) || seenOrder.has(folded)) continue;
      seenOrder.add(folded);
      cleanOrder.push(label);
    }
  }

  /* T86: the retail product overrides. Strict, unlike the order above: a
   * category id the rail does not draw would make the product vanish, so
   * it is refused at the gate rather than dropped silently. */
  let cleanProducts: ShelfProductOverride[] | undefined;
  if (products !== undefined && products !== null) {
    if (!Array.isArray(products)) {
      return { error: "products must be an array of { key, categoryId }" };
    }
    if (products.length > MAX_ENTRIES) {
      return { error: `at most ${MAX_ENTRIES} product overrides` };
    }
    cleanProducts = [];
    const seenProducts = new Map<string, number>();
    for (const raw of products) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {
          error: "every product override must be { key, categoryId }",
        };
      }
      const { key, categoryId } = raw as Record<string, unknown>;
      if (typeof key !== "string") {
        return { error: 'every product override needs a "Product:<id>" key' };
      }
      const trimmed = key.trim();
      const colon = trimmed.indexOf(":");
      const type = colon > 0 ? trimmed.slice(0, colon) : "";
      const id = colon > 0 ? trimmed.slice(colon + 1).trim() : "";
      if (type !== "Product" || id.length === 0) {
        return {
          error: `product override key ${JSON.stringify(key)} is not "Product:<id>"`,
        };
      }
      if (typeof categoryId !== "number" || !Number.isInteger(categoryId)) {
        return {
          error: `product override ${JSON.stringify(`Product:${id}`)} needs an integer categoryId`,
        };
      }
      if (!PRODUCT_CATEGORY_IDS.includes(categoryId)) {
        return {
          error: `category ${categoryId} is not a counter category (${PRODUCT_CATEGORY_IDS.join(", ")})`,
        };
      }
      const clean = itemKey("Product", id);
      const already = seenProducts.get(clean);
      if (already !== undefined) {
        if (already === categoryId) continue;
        return {
          error: `product ${id} is moved to both category ${already} and category ${categoryId}`,
        };
      }
      seenProducts.set(clean, categoryId);
      cleanProducts.push({ key: clean, categoryId });
    }
  }

  /* T112: the pass substitutions. Strict like the product overrides
   * above and unlike the group order: a mapping whose two ids are the
   * same pass, or that sends one refused pass to two different
   * substitutes, is not a thing a teacher could have meant, and a
   * substitution offered on a guess is a sale of the wrong product. A
   * mapping naming a pass the site no longer sells is NOT refused here:
   * ids are resolved against the live catalog at the moment of the offer,
   * which is where a stale id is dropped and said so out loud
   * (resolveSubstitute). */
  let cleanSubs: PassSubstitute[] | undefined;
  if (substitutes !== undefined && substitutes !== null) {
    if (!Array.isArray(substitutes)) {
      return {
        error:
          "substitutes must be an array of { refusedId, substituteId, matchPrice }",
      };
    }
    if (substitutes.length > MAX_ENTRIES) {
      return { error: `at most ${MAX_ENTRIES} pass substitutions` };
    }
    cleanSubs = [];
    const seenRefused = new Set<string>();
    for (const raw of substitutes) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {
          error:
            "every substitution must be { refusedId, substituteId, matchPrice }",
        };
      }
      const { refusedId, substituteId, matchPrice } = raw as Record<
        string,
        unknown
      >;
      const from = typeof refusedId === "string" ? refusedId.trim() : "";
      const to = typeof substituteId === "string" ? substituteId.trim() : "";
      if (from.length === 0 || to.length === 0) {
        return {
          error: "every substitution needs a refusedId and a substituteId",
        };
      }
      if (from === to) {
        return {
          error: `substitution ${from} names itself as its own substitute`,
        };
      }
      if (typeof matchPrice !== "boolean") {
        return {
          error: `substitution ${from} needs matchPrice true or false`,
        };
      }
      if (seenRefused.has(from)) {
        return { error: `pass ${from} has two substitutes` };
      }
      seenRefused.add(from);
      cleanSubs.push({ refusedId: from, substituteId: to, matchPrice });
    }
  }

  /* The new fields are added only when they were sent, so a config
   * from before T86 or T112 round-trips through the table byte for
   * byte. */
  const clean: ShelfConfig = { hidden: cleanHidden, groups: cleanGroups };
  if (cleanOrder !== undefined) clean.groupOrder = cleanOrder;
  if (cleanProducts !== undefined) clean.products = cleanProducts;
  if (cleanSubs !== undefined) clean.substitutes = cleanSubs;
  return clean;
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

/**
 * T86: the product overrides as a map from item key to category id. One
 * reading for `applyShelfConfig` and for the shelf admin route's
 * placement line, so the drawer can never disagree with the shelf.
 */
export function productCategoryOverrides(
  config: ShelfConfig,
): Map<string, number> {
  return new Map((config.products ?? []).map((o) => [o.key, o.categoryId]));
}

/** The least a shelf item needs to be filtered: its type and id. */
export interface Keyed {
  type: "Product" | "Service" | "Package";
  id: string | number;
}

/** T86: what a retail product needs beyond its key, so a config can move
 *  it to another counter category. Packages ride the same generic and
 *  carry the field too (null on a package). */
export interface CategoryKeyed extends Keyed {
  categoryId?: number | null;
}

/** What a pass needs beyond its key for the rule: its name and the
 *  option fields, and `categoryId` so a pass T41 routed off the Passes
 *  shelf (a rental) takes no group. */
export interface PassKeyed extends Keyed, PassRuleInput {
  categoryId?: number | null;
}

export interface ShelfInput<
  P extends CategoryKeyed,
  S extends PassKeyed,
  C extends { id: number },
> {
  products: P[];
  passes: S[];
  packages: P[];
  contracts: C[];
}

export interface ShelfOutput<
  P extends CategoryKeyed,
  S extends PassKeyed,
  C extends { id: number },
> {
  products: P[];
  /** Every pass gains `group`: its sub-category label. Since T76 a pass
   *  on the Passes shelf always has one (a T74 group's label when the
   *  config names it, else the rule's); null only for a pass T41 routed
   *  to another shelf, where sub-categories do not apply. */
  passes: (S & { group: string | null })[];
  packages: P[];
  contracts: C[];
  /** Group labels in rail order: since T86 the labels `config.groupOrder`
   *  names, in its order, then every other label in the code order (the
   *  fixed PASS_GROUPS first, then any custom T74 label in config order,
   *  then Packages and Memberships, which are orderable too since
   *  2026-09-14). Only labels with something visible to show, so the
   *  screen never draws an empty cell. */
  passGroups: string[];
}

/**
 * The config over a catalog: hidden items dropped from all four arrays,
 * every pass labelled with its group, and the list of groups that have
 * something to show. Pure, so /api/catalog applies it at response time
 * over the cached raw catalog and the test applies it over a fixture.
 */
export function applyShelfConfig<
  P extends CategoryKeyed,
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
  /* T86: a moved retail product takes its new category BEFORE the hide
   * filter runs, so a product can be both moved and hidden, and the
   * admin route's placement line agrees with what the rail draws. */
  const moved = productCategoryOverrides(config);
  const products = catalog.products.map((p) => {
    const to = moved.get(itemKey("Product", p.id));
    /* The spread widens P, and the one field it changes is a field P
     * declares; the cast asserts only that. */
    return to === undefined ? p : ({ ...p, categoryId: to } as P);
  });
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
  /* T86: the configured order first, for the labels it names that have
   * something to show; every other label keeps the code order after
   * them. An order entry is matched the way the validator accepts one,
   * case-insensitively (T86 review): the validator keeps "my label" for
   * a group called "My Label", so matching it case-sensitively here
   * would silently drop the label to the end of a shelf someone
   * arranged by hand. The label that goes out is the catalog's own, so
   * `rest` below still subtracts it. */
  /* Packages and Memberships ride the same order (Pete, 2026-09-14) and
   * are listed only when they have something to sell, like a group. */
  const pinned: string[] = [
    ...(catalog.packages.filter(visible).length > 0 ? ["Packages"] : []),
    ...(catalog.contracts.some((c) => !hidden.has(itemKey("Contract", c.id)))
      ? ["Memberships"]
      : []),
  ];
  const orderable = new Map(
    [...fixed, ...custom, ...pinned].map((label) => [label.toLowerCase(), label]),
  );
  const named: string[] = [];
  for (const raw of config.groupOrder ?? []) {
    const label = orderable.get(canonicalGroupLabel(raw).toLowerCase());
    if (label === undefined || named.includes(label)) continue;
    named.push(label);
  }
  const rest = [...fixed, ...custom, ...pinned].filter(
    (label) => !named.includes(label),
  );
  return {
    products: products.filter(visible),
    passes,
    packages: catalog.packages.filter(visible),
    contracts: catalog.contracts.filter(
      (c) => !hidden.has(itemKey("Contract", c.id)),
    ),
    passGroups: [...named, ...rest],
  };
}

/* ===================================================================
 * T97: gift cards on the shelf
 * =================================================================== */

/** The least a gift card product needs to be filtered: its id and
 *  whether Mindbody prices it from the payment (T96 `editable`). */
export interface GiftCardKeyed {
  id: number;
  editable: boolean;
}

/**
 * T97: is this gift card product turned off at the counter?
 *
 * The EDITABLE product never is, whatever the config says: it is the one
 * the number pad sells any amount through, so hiding it would take the
 * pad away silently. The admin PUT refuses that key in words, and this is
 * the second guard, for a row stored before the product became editable
 * or by a hand outside the drawer.
 */
export function giftCardHidden(
  config: ShelfConfig,
  card: GiftCardKeyed,
): boolean {
  if (card.editable) return false;
  return config.hidden.includes(itemKey("GiftCard", card.id));
}

/**
 * The gift card products the counter may sell: the hide list applied,
 * order untouched. Applied server-side in /api/gift-cards, so a stale
 * browser cannot show a preset the studio turned off, and again in
 * /api/checkout, so it cannot sell one either.
 */
export function visibleGiftCards<T extends GiftCardKeyed>(
  cards: readonly T[],
  config: ShelfConfig,
): T[] {
  return cards.filter((c) => !giftCardHidden(config, c));
}
