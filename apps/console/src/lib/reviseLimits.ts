/**
 * Instruction length cap for the revise / Q&A box (GH-37), shared by the
 * client textarea (maxLength + counter) and the server action (the
 * authoritative check). Lives outside the "use server" module because
 * such modules may only export async functions.
 */
export const INSTRUCTION_MAX_LENGTH = 500;
