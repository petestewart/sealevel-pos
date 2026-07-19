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
    // Run on every request except Next.js's own internals (_next/static,
    // _next/image, etc). GH-134: the previous matcher also excluded common
    // static-file extensions (css, js, png, ico, ...) so Clerk's middleware
    // would skip requests for those paths. This app ships no /public
    // directory, so nothing actually serves those extensions as static
    // files: a request for a nonexistent path like the browser's automatic
    // /favicon.ico, or a bot probing /foo.js, fell through to Next's
    // not-found rendering, which still goes through the root layout
    // (apps/console/src/app/layout.tsx) and calls currentUser()/auth().
    // Because clerkMiddleware never ran for that request, auth() threw
    // "can't detect usage of clerkMiddleware()" on a loop of automated
    // requests. Covering every non-_next path (all real pages here are
    // rendered by the app router, not served from static files) puts every
    // request that can reach auth() inside clerkMiddleware's context; only
    // /api/healthz is carved back out as public above.
    "/((?!_next).*)",
    // Always run for API routes too (kept for clarity/robustness; already
    // covered by the pattern above).
    "/(api|trpc)(.*)",
  ],
};
