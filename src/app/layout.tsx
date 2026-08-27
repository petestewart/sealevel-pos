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
