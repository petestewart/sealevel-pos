import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";

import "./globals.css";
import { BOOT_SCRIPT } from "./theme";

/* T70: one family for headings and body, self-hosted at build time so the
 * counter iPad never waits on a font CDN. globals.css reads the variable. */
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "600", "800"],
  variable: "--font-archivo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sealevel Front Desk",
  // Add to Home Screen makes this full-screen on the counter iPad.
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Front Desk" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The counter is not a place to accidentally pinch-zoom mid-check-in.
  maximumScale: 1,
  userScalable: false,
  /**
   * Browser chrome follows the theme too, so an Add to Home Screen install
   * does not frame a dark screen in a light status bar. These two must stay
   * equal to --bg in the matching palette block in globals.css.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f0efee" },
    { media: "(prefers-color-scheme: dark)", color: "#121313" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // data-theme is set by the boot script before paint (src/app/theme.ts);
    // suppressHydrationWarning because the server cannot know the iPad's
    // setting and the attribute is the one thing that differs.
    <html lang="en" className={archivo.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
