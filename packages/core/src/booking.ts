/**
 * Studio booking link.
 *
 * The one canonical URL customers use to book a class, configured entirely
 * in the environment (SEALEVEL_BOOKING_URL) so the drafting model can never
 * invent, shorten, or paraphrase it. When a drafted reply is about
 * attending a specific class, the EXACT configured link is interpolated
 * into the drafting prompt for the model to copy verbatim (see
 * jobs/emailDraft.ts) rather than being generated.
 *
 * Optional, exactly like the KB connection (tools/kb.ts): when unset the
 * booking rule is simply absent from the prompt and drafting behaves as
 * before, so local dev, tests, and a not-yet-provisioned deploy never
 * require it.
 */

/** The configured studio booking URL, or undefined when unset or blank. */
export function bookingUrl(): string | undefined {
  const url = process.env["SEALEVEL_BOOKING_URL"]?.trim();
  return url ? url : undefined;
}

/** Whether a studio booking URL is configured in the environment. */
export function bookingConfigured(): boolean {
  return bookingUrl() !== undefined;
}

/**
 * Drafting guidance appended to the drafting prompt when a booking URL is
 * configured. It tells the model to close a class-attendance reply with a
 * brief invitation for the customer to book their OWN spot and the EXACT
 * configured link, and NOT to add a link to replies that are not about
 * attending a class. The URL is interpolated verbatim so the model copies
 * it rather than inventing one.
 *
 * Booking is self-service: customers book their own classes at the link, and
 * the studio never books on their behalf. The guidance forbids the model
 * from saying the studio will book/reserve for the customer or offering to
 * "get them booked in" (a real draft did exactly this), and tells it to
 * point a customer who asks to be booked back to the self-serve link. This
 * framing applies whenever the class-attendance condition triggers the rule.
 *
 * Kept em-dash-free: this text becomes part of outgoing customer emails
 * (the booking invitation), which must follow the CLAUDE.md no-em-dash rule.
 */
export function bookingLinkGuidance(url: string): string {
  return `
When your reply tells the customer about a specific class, time, teacher, or availability, close with a brief invitation for the customer to book their own spot and include the studio booking link exactly as given: ${url}. Never invent, shorten, or modify the link. Do not add a booking link to replies that are not about attending a class (for example billing or general questions).
Booking is self-service: the customer books their own class at the link. Never say or imply that the studio will book, reserve, hold, or sign the customer up, and never offer to get them booked in or ask which day so we can book them for it. If the customer asks us to book a class for them, politely explain that they can reserve their own spot at the booking link and point them to it.`;
}
