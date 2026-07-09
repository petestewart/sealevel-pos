import type { Metadata } from "next";
import Link from "next/link";
import { ClerkProvider, UserButton } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sealevel Ops Console",
  description: "Operator console for the Sealevel Hot Yoga AI manager",
};

/**
 * Every view reads live operational data from Postgres, and ClerkProvider
 * needs runtime keys, so nothing in the console is statically prerendered.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <header className="site-header">
            <span className="brand">Sealevel Ops</span>
            <nav>
              <Link href="/">Dashboard</Link>
              <Link href="/approvals">Approvals</Link>
            </nav>
            <UserButton />
          </header>
          <main>{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
