import type { Metadata } from "next";
import { Hanken_Grotesk, IBM_Plex_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { ClerkProvider, UserButton } from "@clerk/nextjs";
import { currentUser } from "@clerk/nextjs/server";
import { NavLinks } from "../components/NavLinks";
import { ThemeToggle, type Theme } from "../components/ThemeToggle";
import { pendingApprovals } from "../lib/approvals";
import "./globals.css";

const hankenGrotesk = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Sealevel Ops Console",
  description: "Operator console for the Sealevel Hot Yoga AI manager",
};

/**
 * Every view reads live operational data from Postgres, and ClerkProvider
 * needs runtime keys, so nothing in the console is statically prerendered.
 */
export const dynamic = "force-dynamic";

/** Nav pill count; the shell must render even if Postgres is briefly down. */
async function pendingCount(): Promise<number> {
  try {
    return (await pendingApprovals()).length;
  } catch {
    return 0;
  }
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .slice(0, 2)
    .join("");
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const theme: Theme =
    cookieStore.get("theme")?.value === "light" ? "light" : "dark";

  const user = await currentUser();
  const displayName = user?.firstName ?? user?.username ?? null;
  const initialsSource = user?.fullName ?? displayName;
  const count = await pendingCount();

  return (
    <ClerkProvider>
      <html
        lang="en"
        data-theme={theme}
        className={`${hankenGrotesk.variable} ${plexMono.variable}`}
      >
        <body>
          <nav className="nav">
            <div className="nav-brand">
              <div className="nav-brand-mark" aria-hidden="true">
                {"≈"}
              </div>
              <span className="nav-brand-name">Sealevel</span>
              <span className="nav-brand-tag">Ops</span>
            </div>
            <NavLinks pendingCount={count} />
            <div className="nav-right">
              <ThemeToggle initialTheme={theme} />
              <div className="nav-divider" />
              <div className="nav-user">
                {displayName ? (
                  <span className="nav-user-name">{displayName}</span>
                ) : null}
                <div className="nav-avatar" title={displayName ?? undefined}>
                  <UserButton
                    fallback={
                      initialsSource ? (
                        <span>{initialsOf(initialsSource)}</span>
                      ) : null
                    }
                  />
                </div>
              </div>
            </div>
          </nav>
          <main>{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
