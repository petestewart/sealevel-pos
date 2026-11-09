/**
 * Takes the screenshots for docs/training/front-desk-guide.html.
 *
 * Runs the REAL app against scripts/training/fake-mindbody.mjs, so every
 * picture is the app as built, with invented students. See
 * scripts/training/README.md for how to start both.
 *
 *   node scripts/training/capture.cjs [flow ...]     # default: all flows
 *
 * Each flow restarts the fake server first, so state from one flow (a
 * check-in, a sale) never leaks into the next picture.
 */

const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const APP = process.env.APP_URL ?? "http://localhost:3000";
const OUT = path.resolve(__dirname, "../../docs/training/img");
const STATE = path.resolve(__dirname, ".state");
const FAKE = path.resolve(__dirname, "fake-mindbody.mjs");
const COUNTER_PIN = process.env.POS_PIN ?? "2468";
const TEACHER = { user: "maya@sealevelhotyoga.com", pass: "namaste", pin: "1357" };

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(STATE, { recursive: true });

let fake = null;
async function resetFake() {
  if (fake) {
    fake.kill();
    await new Promise((r) => fake.once("exit", r));
  }
  fake = spawn(process.execPath, [FAKE], { stdio: ["ignore", "ignore", "inherit"] });
  await new Promise((r) => setTimeout(r, 700));
}

/* The sign-in flow starts from a teacher with no PIN; other flows keep
 * the PIN it set. Uses the app's own DATABASE_URL. */
async function clearTeacherState() {
  if (!process.env.DATABASE_URL) return;
  const { Client } = require("pg");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  for (const t of ["teacher_pins", "staff_sessions", "guest_visits", "waiver_receipts", "comp_receipts", "client_writes", "contract_receipts"]) {
    await db.query(`DELETE FROM ${t}`).catch(() => {});
  }
  await db.end();
}

let browser;
let current = null;
async function page(state = "signedin") {
  const file = path.join(STATE, `${state}.json`);
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    hasTouch: true,
    ...(state && fs.existsSync(file) ? { storageState: file } : {}),
  });
  const p = await ctx.newPage();
  current = p;
  await p.goto(APP, { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  return p;
}
const shot = async (p, name, opts = {}) => {
  await p.waitForTimeout(opts.wait ?? 400);
  await p.screenshot({ path: path.join(OUT, `${name}.png`), ...opts.clip ? { clip: opts.clip } : {} });
  console.log("  shot", name);
};
const keypad = async (p, digits) => {
  for (const d of digits) await p.getByRole("button", { name: d, exact: true }).last().click();
};
const close = async (p) => {
  await p.getByRole("button", { name: /^close( search results| profile)?$/i }).last().click();
  await p.waitForTimeout(300);
};

/* ------------------------------------------------------------------ */

const flows = {
  async signin() {
    await clearTeacherState();
    const p = await page(null);
    await shot(p, "01-lock");
    await keypad(p, COUNTER_PIN.slice(0, 2));
    await keypad(p, COUNTER_PIN.slice(2));
    await p.getByRole("button", { name: "Unlock" }).click();
    await p.waitForTimeout(1500);
    await p.context().storageState({ path: path.join(STATE, "unlocked.json") });
    await p.getByPlaceholder("Mindbody username (email)").fill(TEACHER.user);
    await p.getByPlaceholder("Mindbody password").fill(TEACHER.pass);
    await shot(p, "02-signin");
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.waitForTimeout(2500);
    await shot(p, "03-pin-setup");
    await keypad(p, TEACHER.pin);
    await p.getByRole("button", { name: "Next" }).click();
    /* The PIN saves itself on the last digit of the second entry. */
    await keypad(p, TEACHER.pin.slice(0, -1));
    await shot(p, "04-pin-confirm");
    await keypad(p, TEACHER.pin.slice(-1));
    await p.waitForTimeout(2500);
    await p.context().storageState({ path: path.join(STATE, "signedin.json") });
    await shot(p, "05-roster");
    await p.context().close();
  },

  async roster() {
    const p = await page();
    await shot(p, "05-roster");
    await p.getByLabel("Change class").click();
    await shot(p, "06-class-picker", { wait: 800 });
    await p.keyboard.press("Escape");
    await p.goto(APP, { waitUntil: "networkidle" });
    await p.waitForTimeout(1200);
    await p.getByLabel("Change day").click();
    await shot(p, "07-calendar", { wait: 800 });
    await p.getByRole("button", { name: "Cancel" }).click();
    await p.getByLabel("Alerts and notes for Jamie Ortiz").click();
    await shot(p, "08-alerts", { wait: 800 });
    await close(p);
    await p.getByLabel("Profile for Dana Whitfield").click();
    await shot(p, "09-profile", { wait: 2000 });
    await p.goto(APP, { waitUntil: "networkidle" });
    await p.waitForTimeout(1200);
    await p.getByLabel(/Member .* Dana Whitfield/).click();
    await shot(p, "10-membership", { wait: 1500 });
    await p.context().close();
  },

  async checkin() {
    const p = await page();
    /* Slow the check-in answer a little so the spinner can be photographed. */
    await p.route("**/api/checkin", async (r) => {
      await new Promise((res) => setTimeout(res, 1500));
      await r.continue();
    });
    await p.getByLabel("Check in Jamie Ortiz").click();
    await shot(p, "11-checking-in", { wait: 300 });
    await p.waitForTimeout(2500);
    await shot(p, "12-checked-in");
    await p.getByLabel("Check out Jamie Ortiz").click();
    await shot(p, "13-check-out", { wait: 600 });
    await p.getByRole("button", { name: "Cancel" }).click();
    await p.getByLabel("Remove Dana Whitfield from this class").click();
    await shot(p, "14-remove", { wait: 600 });
    await p.getByRole("button", { name: "Cancel" }).click();
    /* Riley's check-in uses the last session on the pass. */
    await p.getByLabel("Check in Riley Thompson").click();
    await shot(p, "15-last-session", { wait: 3000 });
    await p.context().close();
  },

  async waiver() {
    const p = await page();
    await p.getByLabel("Check in Chris Albright").click();
    await shot(p, "16-waiver-needed", { wait: 1000 });
    await p.getByRole("button", { name: "Read the waiver" }).click();
    await shot(p, "17-waiver-read", { wait: 1200 });
    await p.locator(".waiver-text, [class*=waiver] [class*=scroll], .modal-scroll").last().evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => {});
    await p.getByRole("button", { name: /without a waiver/ }).click();
    await p.getByPlaceholder("Why are you going ahead without it?").fill("Signing on the Mindbody app after class, phone was dead");
    await keypad(p, "135");
    await shot(p, "19-waiver-override", { wait: 500 });
    await p.context().close();
  },

  async unpaid() {
    const p = await page();
    await p.getByLabel("Check in Taylor Brooks").click();
    await shot(p, "20-pay-and-check-in", { wait: 3000 });
    await p.context().close();
  },

  async walkin() {
    const p = await page();
    await p.getByPlaceholder("Search for a walk-in").fill("den");
    await shot(p, "21-search-results", { wait: 2500 });
    /* Tapping a result adds them to the class on screen. */
    await p.getByText("Dennis Carver").first().click();
    await p.waitForTimeout(2500);
    await p.mouse.move(590, 500);
    await p.mouse.wheel(0, 2000);
    await shot(p, "22-walkin-added", { wait: 800 });
    await p.getByRole("button", { name: "New client" }).first().click();
    await p.waitForTimeout(800);
    await p.getByRole("textbox", { name: /First name/ }).fill("Robin");
    await p.getByRole("textbox", { name: /Last name/ }).fill("Castillo");
    await p.getByRole("textbox", { name: /Email/ }).fill("robin.castillo@example.com");
    await p.getByRole("textbox", { name: /Phone/ }).fill("(206) 555-0187");
    await shot(p, "23-new-client");
    await p.context().close();
  },

  async guest() {
    const p = await page();
    await p.getByLabel("Check in a guest on Morgan Lee's guest pass").click();
    await p.waitForTimeout(1000);
    await p.getByPlaceholder(/Who is the guest/).fill("Elena");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(2000);
    await p.getByText("Elena Petrova").last().click();
    await shot(p, "24-guest", { wait: 1000 });
    await p.context().close();
  },

  async waitlist() {
    const p = await page();
    await p.getByLabel("Change class").click();
    await p.waitForTimeout(600);
    await p.getByText("Hot Flow").first().click();
    await p.waitForTimeout(2000);
    await p.getByPlaceholder("Search for a walk-in").fill("noah");
    await p.waitForTimeout(2500);
    await shot(p, "25-full-search");
    await p.getByText("Noah Bennett").first().click();
    await shot(p, "26-waitlist-confirm", { wait: 1200 });
    await p.getByRole("button", { name: "Add to waiting list" }).click();
    await p.waitForTimeout(2500);
    await close(p);
    await p.mouse.move(590, 500);
    await p.mouse.wheel(0, 2000);
    await shot(p, "27-waitlist-row", { wait: 800 });
    await p.context().close();
  },

  async sale() {
    const p = await page();
    await p.getByLabel("Cart for Jordan Kim").click();
    await shot(p, "28-cart-shelf", { wait: 2500 });
    await p.getByLabel("Add 10 Class Series, $210.00").click();
    await p.getByText("Retail", { exact: true }).first().click();
    await p.getByText("Food/Drink", { exact: true }).first().click();
    await p.waitForTimeout(800);
    await p.getByLabel(/^Add Coconut Water/).click();
    await shot(p, "29-cart-ticket", { wait: 2500 });
    await p.locator("button.t-foot-pay").click();
    await shot(p, "30-pay", { wait: 1500 });
    await p.getByRole("button", { name: /^Card/ }).first().click();
    await shot(p, "31-pay-card", { wait: 1000 });
    await p.getByText("Finalize Sale", { exact: true }).click();
    await shot(p, "32-sale-complete", { wait: 4000 });
    await p.context().close();
  },

  async cash() {
    const p = await page();
    await p.getByRole("button", { name: "Cart", exact: true }).click();
    await p.waitForTimeout(2000);
    await shot(p, "33-cart-nobody");
    await p.getByRole("button", { name: /^Walk-in/ }).click();
    await p.getByText("Retail", { exact: true }).first().click();
    await p.getByText("Food/Drink", { exact: true }).first().click();
    await p.waitForTimeout(600);
    await p.getByLabel(/^Add Kombucha/).click();
    await p.getByLabel(/^Add Electrolyte Packet/).click();
    await p.waitForTimeout(2000);
    await p.locator("button.t-foot-pay").click();
    await p.waitForTimeout(1500);
    await p.getByRole("button", { name: /^Cash/ }).first().click();
    await p.waitForTimeout(600);
    await shot(p, "34a-cash-line");
    /* Cash goes in at the exact amount; tapping the amount opens the keypad. */
    await p.getByRole("button", { name: /\$7\.72/ }).first().click();
    await p.waitForTimeout(600);
    await p.getByRole("button", { name: "$20", exact: true }).click();
    await shot(p, "34-cash-keypad");
    await p.getByRole("button", { name: "Done", exact: true }).click();
    await p.waitForTimeout(600);
    await p.getByText("Finalize Sale", { exact: true }).click();
    await shot(p, "35-cash-complete", { wait: 4000 });
    await p.context().close();
  },

  async discount() {
    const p = await page();
    await p.getByLabel("Cart for Sam Okafor").click();
    await p.waitForTimeout(2000);
    await p.getByText("Retail", { exact: true }).first().click();
    await p.getByText("Clothing", { exact: true }).first().click();
    await p.waitForTimeout(600);
    await p.getByLabel(/^Add Sealevel Tank Top/).click();
    await p.waitForTimeout(2000);
    await p.locator("button.t-foot-pay").click();
    await p.waitForTimeout(1500);
    await p.getByRole("button", { name: "Discount", exact: true }).click();
    await p.waitForTimeout(600);
    await p.getByText("20%", { exact: true }).click();
    await p.getByText("Damaged item", { exact: true }).click();
    await shot(p, "37-discount-reason");
    await p.getByRole("button", { name: "Next", exact: true }).click();
    await p.waitForTimeout(500);
    await keypad(p, TEACHER.pin.slice(0, -1));
    await shot(p, "38-discount-pin");
    await keypad(p, TEACHER.pin.slice(-1));
    await p.getByRole("button", { name: "Done", exact: true }).click().catch(() => {});
    await shot(p, "39-discount-confirm", { wait: 1500 });
    await p.getByRole("button", { name: "Discount", exact: true }).last().click();
    await shot(p, "40-discount-applied", { wait: 2500 });
    await p.context().close();
  },

  async membership() {
    const p = await page();
    await p.getByLabel("Cart for Jamie Ortiz").click();
    await p.waitForTimeout(2000);
    await p.getByLabel("Start the Monthly Committed Membership membership").click();
    await shot(p, "41-membership", { wait: 3000 });
    await p.locator(".modal button, [role=dialog] button").filter({ hasText: /^Charge/ }).first().click();
    await p.waitForTimeout(1000);
    await p.getByText("The customer screen is not connected.").first().evaluate((el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 4 && getComputedStyle(n).overflowY !== "visible") {
          n.scrollTop = n.scrollHeight;
          return;
        }
      }
    });
    await shot(p, "42-membership-no-screen", { wait: 500 });
    await p.getByRole("button", { name: "Sell without a signature" }).click();
    await p.waitForTimeout(500);
    await keypad(p, TEACHER.pin.slice(0, -1));
    await shot(p, "43-membership-pin");
    await p.context().close();
  },

  async giftcard() {
    const p = await page();
    await p.getByRole("button", { name: "Cart", exact: true }).click();
    await p.waitForTimeout(2000);
    await p.getByRole("button", { name: /^Walk-in/ }).click();
    await p.getByText("Retail", { exact: true }).first().click();
    await p.getByText("Gift cards", { exact: true }).first().click();
    await p.waitForTimeout(1000);
    await shot(p, "44-giftcard-shelf");
    await p.getByText("Single Class", { exact: true }).first().click();
    await p.waitForTimeout(2000);
    await p.locator("button.t-foot-pay").click();
    await p.waitForTimeout(1500);
    await p.getByRole("button", { name: /^Cash/ }).first().click();
    await p.waitForTimeout(600);
    await p.getByText("Finalize Sale", { exact: true }).click();
    await shot(p, "45-giftcard-write", { wait: 5000 });
    await p.context().close();
  },

  async account() {
    const p = await page();
    await p.getByRole("button", { name: "Maya Chen" }).click();
    await shot(p, "46-signed-in", { wait: 2500 });
    await p.context().close();
  },
};

(async () => {
  browser = await chromium.launch();
  const wanted = process.argv.slice(2);
  try {
    for (const [name, run] of Object.entries(flows)) {
      if (wanted.length && !wanted.includes(name)) continue;
      console.log(name);
      await resetFake();
      try {
        await run();
      } catch (e) {
        if (current) await current.screenshot({ path: path.join(STATE, `FAILED-${name}.png`) }).catch(() => {});
        console.error(`  FAILED ${name}: ${String(e.message).split("\n")[0]} (screenshot in .state/)`);
        process.exitCode = 1;
      }
    }
  } finally {
    await browser.close();
    if (fake) fake.kill();
  }
})();
