import type { Metadata, Viewport } from "next";

import "./globals.css";

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
   * equal to --bg in the matching :root block in globals.css.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3ec" },
    { media: "(prefers-color-scheme: dark)", color: "#131311" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
