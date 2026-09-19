import DisplayScreen from "./DisplayScreen";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sealevel",
};

/**
 * The customer-facing iPad (T113, docs/design/customer-display.md).
 *
 * Deliberately its own route and its own tree: no POS, no roster, no
 * search, no dev drawer, no lock screen, no teacher session. A student
 * holds this device, so if someone walks off with it they hold a
 * signed-in nothing. The theme boot script in layout.tsx applies here
 * unchanged, which is how the screen follows the iPad's own setting.
 *
 * Item 1 builds the idle screen and the pairing only. The scenes (the
 * waiver, the ticket, the sign-up, the contract) are items 2 to 6.
 */
export default function DisplayPage() {
  return <DisplayScreen />;
}
