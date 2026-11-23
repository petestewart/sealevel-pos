import type { Metadata } from "next";

/**
 * T290: the customer screen's own name on the Home Screen, so its icon is
 * not a second "Front Desk". Full screen as the root layout sets it, the
 * old Apple tag included (repeated here, since `other` is not inherited
 * once a child sets metadata of its own).
 */
export const metadata: Metadata = {
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Customer Screen" },
  other: { "apple-mobile-web-app-capable": "yes" },
};

export default function DisplayLayout({ children }: { children: React.ReactNode }) {
  return children;
}
