import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Clerk protects the entire console except the healthcheck. Anyone not
 * signed in is redirected to the Clerk sign-in flow. Requires
 * NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY (see .env.example).
 *
 * /api/healthz is public so Railway's healthcheck (which has no session)
 * can reach it; the route is dependency-free and leaks nothing.
 */
const isPublicRoute = createRouteMatcher(["/api/healthz"]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  await auth.protect();
});

export const config = {
  matcher: [
    // Run on everything except Next internals and static assets.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
