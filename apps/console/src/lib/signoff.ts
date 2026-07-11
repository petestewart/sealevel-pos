import { auth, currentUser } from "@clerk/nextjs/server";
import { getUserSettings } from "@ai-manager/core";

/**
 * The signoff choice preselected on the approval card (GH-76): the
 * signed-in user's effective GLOBAL setting (GH-66). "name" when
 * sign_with_name is on, else "default". `name` is what "My name" would
 * sign with (signature_name, falling back to the Clerk first name), shown
 * in the option label so the choice is concrete; null when no usable name
 * exists. Any lookup failure degrades to the studio default; this helper
 * must never block rendering the card.
 */
export interface SignoffDefault {
  mode: "default" | "name";
  name: string | null;
}

export async function effectiveSignoffDefault(): Promise<SignoffDefault> {
  try {
    const { userId } = await auth();
    if (!userId) return { mode: "default", name: null };
    const [settings, user] = await Promise.all([
      getUserSettings(userId),
      currentUser(),
    ]);
    // Mirror the resolver order the decide action applies (signature_name,
    // then the first token of the decider display name: fullName, then
    // firstName, then email), so the option label always previews the
    // exact name an approval would insert.
    const displayName =
      user?.fullName ??
      user?.firstName ??
      user?.primaryEmailAddress?.emailAddress ??
      null;
    const name =
      settings.signature_name ?? displayName?.split(/\s+/)[0] ?? null;
    return { mode: settings.sign_with_name && name ? "name" : "default", name };
  } catch {
    return { mode: "default", name: null };
  }
}
