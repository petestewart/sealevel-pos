/**
 * T76: shared favorites. Pete: "Favorites should pull from Mindbody
 * favorites". The Public API v6 has no favorites endpoint (every
 * vendored spec file was grepped), so the starred items became shared
 * APP DATA: one list per target in `app_settings`, which the T29
 * charter admits (Mindbody has no home for it) and which holds NO copy
 * of the catalog, only `{ type, id }` pairs resolved against the live
 * catalog on the screen. Before T76 the stars lived in each iPad's
 * localStorage (`pos.favorites.<target>`), which is still the fallback
 * when there is no database.
 *
 * Pure and dependency-free, like shelfconfig.ts: the catalog route, the
 * favorites route and a plain node test share one validator.
 */

/** One starred item. Ids are STRINGS here (a product's is a barcode
 *  string, a pass's a number on the catalog; the screen compares them
 *  as strings either way), so the stored row has one shape. */
export interface FavoritePair {
  type: "Product" | "Service" | "Package";
  id: string;
}

const PAIR_TYPES: readonly FavoritePair["type"][] = [
  "Product",
  "Service",
  "Package",
];

/** More stars than a shelf can hold is a fault, not a list. */
export const MAX_FAVORITES = 60;

/** An id is a product's barcode string or a pass's number; anything
 *  longer than this is not one, and the row must not hold it. */
export const MAX_FAVORITE_ID = 64;

/** The app_settings key, PER TARGET, for the reason the localStorage
 *  key was: sandbox stars must never render on the studio's shelf. */
export function favoritesSettingKey(target: string): string {
  return `favorites_${target}`;
}

/**
 * The shape gate on the way IN (the PUT body) and OUT of the table.
 * Returns the cleaned list, or `{ error }` naming the first rule broken.
 * Ids are trimmed, numbers accepted and stringified (the screen's own
 * list carries a pass's numeric id), duplicates dropped.
 */
export function validateFavorites(
  input: unknown,
): FavoritePair[] | { error: string } {
  if (!Array.isArray(input)) {
    return { error: "favorites must be an array of { type, id } pairs" };
  }
  if (input.length > MAX_FAVORITES) {
    return { error: `at most ${MAX_FAVORITES} favorites` };
  }
  const out: FavoritePair[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { error: "every favorite must be an object with type and id" };
    }
    const { type, id } = raw as Record<string, unknown>;
    if (!PAIR_TYPES.includes(type as FavoritePair["type"])) {
      return {
        error: `favorite type ${JSON.stringify(type)} is not Product, Service or Package`,
      };
    }
    const cleanId =
      typeof id === "string"
        ? id.trim()
        : typeof id === "number" && Number.isFinite(id)
          ? String(id)
          : "";
    if (cleanId.length === 0) {
      return { error: "every favorite needs a non-empty id" };
    }
    if (cleanId.length > MAX_FAVORITE_ID) {
      return { error: `a favorite id is at most ${MAX_FAVORITE_ID} characters` };
    }
    const key = `${type}:${cleanId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: type as FavoritePair["type"], id: cleanId });
  }
  return out;
}

/**
 * A stored value into a list. `null` (no row) is "nothing stored", which
 * the screen reads as "the device's own list applies"; a stored row,
 * even an empty list, wins over the device. A row that is not valid JSON
 * of a valid list reads as nothing stored plus the reason, and the
 * caller logs it once; the shelf never breaks over a bad row.
 */
export function parseFavorites(raw: string | null): {
  favorites: FavoritePair[] | null;
  error: string | null;
} {
  if (raw === null) return { favorites: null, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      favorites: null,
      error: `not JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = validateFavorites(parsed);
  if ("error" in result) {
    const shape = Array.isArray(parsed)
      ? `an array of ${parsed.length}`
      : typeof parsed;
    return { favorites: null, error: `${result.error} (${shape})` };
  }
  return { favorites: result, error: null };
}
