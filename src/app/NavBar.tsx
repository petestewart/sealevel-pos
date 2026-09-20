"use client";

import type { ReactNode } from "react";

/**
 * T85: the one nav bar (Pete, on the counter build: "navigation is
 * inconsistent and unclear. the screens are sign-in, buy, pay. the
 * buttons are in different spots and 'back' is unclear as to where it's
 * going ... maybe a nav bar at the bottom ... sign-in, buy, pay, profile,
 * and dev should all be in the nav bar"). T206 renamed the middle one to
 * Cart, on Pete's first drive of the counter build; `NavScreen`'s "buy"
 * key, the sale mode and the CSS keep their names.
 *
 * The same element on every screen, at the bottom, above the sale
 * overlay's z-order: the roster, the shelf and the payment step are three
 * screens of one app, and the way between them never moves. Five evenly
 * spaced items, an icon over a 16px label, 64px tall; the current screen
 * wears --accent and a 4px accent top edge, the rest --ink on --surface.
 * Settings (the drawer) renders only when devtools answered, so the
 * counter iPad sees four; Profile, last, carries the teacher's name.
 *
 * It carries no state of its own: page.tsx owns which screen is showing,
 * and the reasons an item is off come from the sale (SaleNavState). An
 * item that cannot be tapped is aria-disabled with the reason as its
 * title, never hidden and never silent, the same rule the shelf's Pay
 * follows.
 */
export type NavScreen = "signin" | "buy" | "pay";

export interface NavItem {
  key: NavScreen | "profile" | "dev";
  label: string;
  icon: ReactNode;
  /** Lit: the screen showing, or the drawer being open. */
  on: boolean;
  /** The reason a tap does nothing, or null. */
  why: string | null;
  onTap: () => void;
}

function Icon({
  d,
  extra,
  width = 2,
}: {
  d: string;
  extra?: ReactNode;
  width?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={26}
      height={26}
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="square"
      aria-hidden="true"
    >
      {extra}
      <path d={d} />
    </svg>
  );
}

/** A list with a check: the roster, and checking people in on it. */
export function SignInIcon() {
  return <Icon d="M4 6h9M4 12h7M4 18h5M13.5 16 16 18.5 20.5 14" />;
}

/** A shopping bag: the shelf. The roster's Sell icon is a dollar circle
 *  because a bag at arm's length read as a trash can in a row of icons
 *  (T70); here the word Cart is under it, so the bag is unambiguous.
 *  T206 renamed the word; the bag is the same bag. */
export function CartIcon() {
  return (
    <Icon
      d="M9 8V6.5a3 3 0 0 1 6 0V8"
      extra={<path d="M4.5 8h15l-1.2 12H5.7z" />}
    />
  );
}

/** A card: the payment step. */
export function PayIcon() {
  return (
    <Icon
      d="M2.5 10.5h19"
      extra={<rect x="2.5" y="5" width="19" height="14" />}
    />
  );
}

/** A person: the signed-in teacher (the header's account icon, T61). */
export function ProfileIcon() {
  return (
    <Icon d="M4 20.5c0-3.6 3.6-5.5 8-5.5s8 1.9 8 5.5" extra={<circle cx="12" cy="8" r="4" />} />
  );
}

/** A cog: the drawer, whose first tab is the settings (Pete: "change Dev
 *  to Settings and change the icon to a cog wheel"). */
export function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={26}
      height={26}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

/** Three of the five items ARE the screen; the other two open something
 *  over it. Only a screen can be the current one. */
function isScreen(key: NavItem["key"]): boolean {
  return key === "signin" || key === "buy" || key === "pay";
}

export default function NavBar({ items }: { items: NavItem[] }) {
  return (
    <nav className="nav-bar" aria-label="Screens">
      {items.map((item) => (
        <button
          key={item.key}
          className={item.on ? "nav-item on" : "nav-item"}
          /* aria-disabled, not disabled: a greyed item must be able to
             say why when a teacher asks it, and the tap guard below is
             what refuses the tap. */
          aria-disabled={item.why !== null}
          /* T85 review: aria-current says which SCREEN is showing, and
             there is exactly one. Profile and Dev open a modal and a
             drawer over whatever screen the teacher is on, so lighting
             them (which the accent rightly does) must not announce a
             second current page; they report open/shut instead. */
          aria-current={isScreen(item.key) && item.on ? "page" : undefined}
          aria-expanded={isScreen(item.key) ? undefined : item.on}
          aria-haspopup={item.key === "profile" ? "dialog" : undefined}
          title={item.why ?? undefined}
          onClick={() => {
            if (item.why !== null) return;
            item.onTap();
          }}
        >
          {item.icon}
          {/* The teacher's own name on Profile is a name, not a verb:
              regular weight, and clipped rather than wrapped. */}
          <span
            className={item.key === "profile" ? "nav-label nav-name" : "nav-label"}
          >
            {item.label}
          </span>
        </button>
      ))}
    </nav>
  );
}
