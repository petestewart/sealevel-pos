/**
 * A FAKE Mindbody Public API v6, for training screenshots only.
 *
 * Serves invented classes, students, passes and products so the real app
 * can be run and photographed without touching the studio's account. It
 * holds its state in memory: a check-in flips a visit, a booking adds
 * one, a new client is appended, and a restart puts everything back.
 *
 * Nothing here is a model of Mindbody's behaviour beyond what the app
 * reads. It is NOT a test double and nothing should rely on it.
 *
 *   node scripts/training/fake-mindbody.mjs        # listens on :4010
 *   MINDBODY_API_BASE_URL=http://localhost:4010/public/v6 npm run dev
 */

import http from "node:http";

const PORT = Number(process.env.FAKE_MB_PORT ?? 4010);
const TZ = "America/Los_Angeles";
const TAX = 0.1035;

/* ---------- time ---------------------------------------------------- */

function wall(d) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}`;
}
const MIN = 60_000;
const now = new Date();
/* The "current" class starts at the next quarter hour, at least 10 min out. */
const anchor = new Date(Math.ceil((now.getTime() + 10 * MIN) / (15 * MIN)) * 15 * MIN);
const at = (mins) => wall(new Date(anchor.getTime() + mins * MIN));
const day = (offsetDays) => wall(new Date(now.getTime() + offsetDays * 86_400_000)).slice(0, 10);

/* ---------- staff ---------------------------------------------------- */

const staff = [
  { Id: 100000140, FirstName: "Sealevel", LastName: "API", Active: true, ClassTeacher: false },
  { Id: 100000201, FirstName: "Maya", LastName: "Chen", Active: true, ClassTeacher: true },
  { Id: 100000202, FirstName: "Jordan", LastName: "Reyes", Active: true, ClassTeacher: true },
  { Id: 100000203, FirstName: "Priya", LastName: "Nair", Active: true, ClassTeacher: true },
];
const staffName = (s) => ({ ...s, Name: `${s.FirstName} ${s.LastName}` });
const logins = {
  "maya@sealevelhotyoga.com": 100000201,
  "jordan@sealevelhotyoga.com": 100000202,
  "priya@sealevelhotyoga.com": 100000203,
};

/* ---------- catalog -------------------------------------------------- */

const services = [
  { Id: "s1", ProductId: 1001, Name: "Drop In", Price: 25, OnlinePrice: 25, TaxRate: 0, Count: 1, Type: "Series", RevenueCategory: "Classes" },
  { Id: "s2", ProductId: 1002, Name: "5 Class Series", Price: 115, OnlinePrice: 115, TaxRate: 0, Count: 5, Type: "Series", RevenueCategory: "Classes" },
  { Id: "s3", ProductId: 1003, Name: "10 Class Series", Price: 210, OnlinePrice: 210, TaxRate: 0, Count: 10, Type: "Series", RevenueCategory: "Classes" },
  { Id: "s4", ProductId: 1004, Name: "New Student 2 Week Unlimited", Price: 49, OnlinePrice: 49, TaxRate: 0, Count: 999, Type: "Series", IsIntroOffer: true, RevenueCategory: "Classes" },
  { Id: "s5", ProductId: 1005, Name: "Month Unlimited", Price: 189, OnlinePrice: 189, TaxRate: 0, Count: 999, Type: "Series", RevenueCategory: "Classes" },
  { Id: "s6", ProductId: 1006, Name: "Guest Pass (for auto-debit members)", Price: 0, OnlinePrice: 0, TaxRate: 0, Count: 1, Type: "Series", RevenueCategory: "Classes" },
  { Id: "s7", ProductId: 1007, Name: "Towel Rental", Price: 3, OnlinePrice: 3, TaxRate: TAX, Count: 1, Type: "Series", RevenueCategory: "Towel and Mat" },
  { Id: "s8", ProductId: 1008, Name: "Mat Rental", Price: 3, OnlinePrice: 3, TaxRate: TAX, Count: 1, Type: "Series", RevenueCategory: "Towel and Mat" },
];
/* T219: a workshop sold as two passes, with a course to sign the buyer up
 * for. Only with FAKE_MB_WORKSHOP=1, so the training screenshots' shelf
 * does not change under them. */
const WORKSHOP = process.env.FAKE_MB_WORKSHOP === "1";
if (WORKSHOP) {
  services.push(
    { Id: "s9", ProductId: 1009, Name: "Gratitude Yin Sound Bath", Price: 45, OnlinePrice: 45, TaxRate: 0, Count: 1, Type: "Series", RevenueCategory: "Workshops" },
    { Id: "s10", ProductId: 1010, Name: "Gratitude Yin Sound Bath (Members)", Price: 35, OnlinePrice: 35, TaxRate: 0, Count: 1, Type: "Series", RevenueCategory: "Workshops" },
  );
}
const products = [
  { Id: "p100", ProductId: 2001, Name: "Water Bottle (1L)", Price: 3, OnlinePrice: 3, TaxRate: TAX, CategoryId: 36 },
  { Id: "p101", ProductId: 2002, Name: "Coconut Water", Price: 4.5, OnlinePrice: 4.5, TaxRate: TAX, CategoryId: 36 },
  { Id: "p102", ProductId: 2003, Name: "Electrolyte Packet", Price: 2, OnlinePrice: 2, TaxRate: TAX, CategoryId: 36 },
  { Id: "p103", ProductId: 2004, Name: "Kombucha", Price: 5, OnlinePrice: 5, TaxRate: TAX, CategoryId: 36 },
  { Id: "p200", ProductId: 2101, Name: "Sealevel Tank Top", Price: 32, OnlinePrice: 32, TaxRate: TAX, CategoryId: 26 },
  { Id: "p201", ProductId: 2102, Name: "Sealevel Shorts", Price: 38, OnlinePrice: 38, TaxRate: TAX, CategoryId: 26 },
  { Id: "p300", ProductId: 2201, Name: "Yoga Mat Towel", Price: 45, OnlinePrice: 45, TaxRate: TAX, CategoryId: 32 },
  { Id: "p301", ProductId: 2202, Name: "Studio Yoga Mat", Price: 68, OnlinePrice: 68, TaxRate: TAX, CategoryId: 32 },
];
const contracts = [
  {
    Id: 347,
    Name: "Monthly Committed Membership",
    FirstPaymentAmountTotal: 149,
    RecurringPaymentAmountTotal: 149,
    TotalContractAmountTotal: 1788,
    AutopayEnabled: true,
    AutopaySchedule: { FrequencyType: "SetNumberOfAutopays", FrequencyValue: 1, FrequencyTimeUnit: "Monthly" },
    NumberOfAutopays: 12,
    ClientsChargedOn: "OnSaleDate",
    AgreementTerms:
      "<p>This membership renews monthly for twelve months at $149.00 per month, charged to the card on file on the same day each month.</p><p>After twelve months it continues month to month until cancelled in writing with 30 days notice.</p>",
    SoldOnline: true,
  },
];
const giftcards = [
  { Id: 282, ProductId: 282, Description: "Gift Card (Custom Amount)", CardValue: 0, SalePrice: 0, EditableByConsumer: true, SoldOnline: true, LocationIds: [1] },
  { Id: 283, ProductId: 283, Description: "Single Class Gift Card", CardValue: 25, SalePrice: 25, EditableByConsumer: false, SoldOnline: true, LocationIds: [1] },
  { Id: 284, ProductId: 284, Description: "Five Class Gift Card", CardValue: 115, SalePrice: 115, EditableByConsumer: false, SoldOnline: true, LocationIds: [1] },
];
const allItems = () => [
  ...services.map((s) => ({ ...s, _kind: "Service" })),
  ...products.map((p) => ({ ...p, _kind: "Product" })),
];

/* ---------- clients -------------------------------------------------- */

let uniq = 900000;
function client(id, first, last, extra = {}) {
  return {
    Id: String(id),
    UniqueId: ++uniq,
    FirstName: first,
    LastName: last,
    Email: `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, "") + "@example.com",
    MobilePhone: "(206) 555-01" + String(uniq % 100).padStart(2, "0"),
    Status: "Active",
    Active: true,
    Liability: { IsReleased: true, AgreementDate: "2025-03-14T10:12:00", ReleasedBy: null },
    AccountBalance: 0,
    MembershipIcon: 0,
    RedAlert: null,
    YellowAlert: null,
    Notes: null,
    BirthDate: null,
    CreationDate: "2025-03-14T10:12:00",
    /* T216's star: a date before today means "been before". The two
     * first-timers below override it with null, which is what a client
     * who has never taken a class carries. */
    FirstClassDate: "2025-03-14T00:00:00",
    SendAccountEmails: true,
    SendAccountTexts: false,
    SendPromotionalEmails: true,
    SendPromotionalTexts: false,
    SendScheduleEmails: true,
    SendScheduleTexts: false,
    ...extra,
  };
}
const clients = [
  client(10199, "Counter", "Walk-in"),
  client(10101, "Alex", "Morgan", { MembershipIcon: 1 }),
  client(10102, "Sam", "Okafor"),
  client(10103, "Riley", "Thompson", { YellowAlert: "Bad left knee, offer a block" }),
  client(10104, "Dana", "Whitfield", { MembershipIcon: 1, AccountBalance: -12.5 }),
  client(10105, "Chris", "Albright", { Liability: { IsReleased: false }, FirstClassDate: null }),
  client(10106, "Jamie", "Ortiz", { RedAlert: "Front desk: ask Jamie to update the card on file before class" }),
  client(10107, "Taylor", "Brooks"),
  client(10108, "Morgan", "Lee", { MembershipIcon: 1 }),
  client(10109, "Casey", "Park"),
  client(10110, "Jordan", "Kim", { Notes: "Prefers the back row. Training for a marathon." }),
  client(10111, "Avery", "Santos"),
  client(10112, "Quinn", "Delgado"),
  client(10113, "Devon", "Hart", { MembershipIcon: 1 }),
  client(10114, "Elena", "Petrova"),
  client(10115, "Noah", "Bennett"),
  client(10116, "Dennis", "Carver", { FirstClassDate: null }),
  client(10117, "Denise", "Fowler", { Liability: { IsReleased: false } }),
  client(10118, "Sofia", "Marquez"),
  client(10119, "Liam", "O'Connell"),
  client(10120, "Harper", "Nguyen"),
];
const byId = (id) => clients.find((c) => c.Id === String(id));

/* Each client's passes (ClientServices). */
let csId = 50000;
function pass(clientId, productId, remaining, extra = {}) {
  const svc = services.find((s) => s.ProductId === productId);
  return {
    Id: ++csId,
    ClientId: String(clientId),
    ProductId: productId,
    Name: svc.Name,
    Count: svc.Count,
    Remaining: remaining,
    Current: true,
    ActiveDate: day(-20) + "T00:00:00",
    ExpirationDate: day(70) + "T00:00:00",
    PaymentDate: day(-20) + "T09:41:00",
    Program: { Id: 1, Name: "Classes" },
    ...extra,
  };
}
const exp = (d) => ({ ExpirationDate: day(d) + "T00:00:00" });
const clientServices = [
  pass(10101, 1005, 999, exp(23)),
  pass(10102, 1003, 6, exp(88)),
  pass(10103, 1002, 1, exp(12)),
  pass(10104, 1005, 999, exp(17)),
  pass(10106, 1003, 3, exp(51)),
  pass(10108, 1005, 999),
  pass(10108, 1006, 1, { ExpirationDate: day(40) + "T00:00:00" }),
  pass(10109, 1004, 999, { ExpirationDate: day(9) + "T00:00:00" }),
  pass(10110, 1002, 4, exp(64)),
  pass(10111, 1003, 8, exp(120)),
  pass(10113, 1005, 999, exp(6)),
  pass(10114, 1001, 1, exp(30)),
  pass(10118, 1003, 2, exp(45)),
  pass(10120, 1002, 3, exp(33)),
];
const contractsHeld = {
  10101: [{ Id: 7001, ContractName: "Monthly Committed Membership", StartDate: day(-200) + "T00:00:00", EndDate: day(165) + "T00:00:00", AgreementDate: day(-200) + "T00:00:00" }],
  10104: [{ Id: 7002, ContractName: "Monthly Committed Membership", StartDate: day(-90) + "T00:00:00", EndDate: day(275) + "T00:00:00", AgreementDate: day(-90) + "T00:00:00" }],
};
const cards = {
  10101: { CardType: "Visa", LastFour: "4242", ExpMonth: "08", ExpYear: "2028", CardHolder: "Alex Morgan" },
  10102: { CardType: "Mastercard", LastFour: "5100", ExpMonth: "02", ExpYear: "2029", CardHolder: "Sam Okafor" },
  10103: { CardType: "Visa", LastFour: "3344", ExpMonth: "04", ExpYear: "2028", CardHolder: "Riley Thompson" },
  10107: { CardType: "Mastercard", LastFour: "8210", ExpMonth: "09", ExpYear: "2027", CardHolder: "Taylor Brooks" },
  10104: { CardType: "Visa", LastFour: "1881", ExpMonth: "11", ExpYear: "2027", CardHolder: "Dana Whitfield" },
  10106: { CardType: "Amex", LastFour: "0005", ExpMonth: "05", ExpYear: "2028", CardHolder: "Jamie Ortiz" },
  10110: { CardType: "Visa", LastFour: "7311", ExpMonth: "01", ExpYear: "2030", CardHolder: "Jordan Kim" },
  10116: { CardType: "Visa", LastFour: "9024", ExpMonth: "06", ExpYear: "2027", CardHolder: "Dennis Carver" },
};
for (const c of clients) {
  const card = cards[c.Id];
  if (card) c.ClientCreditCard = { ...card, Address: "", City: "", State: "", PostalCode: "98103" };
}

/* ---------- classes and visits -------------------------------------- */

const classDefs = [
  { Id: 30001, start: -300, len: 90, name: "Hot 26", teacher: 100000202, cap: 40 },
  { Id: 30002, start: -150, len: 60, name: "Hot 26 Fusion", teacher: 100000203, cap: 40 },
  { Id: 30003, start: 0, len: 90, name: "Hot 26", teacher: 100000201, cap: 40 },
  { Id: 30004, start: 120, len: 60, name: "Hot Flow", teacher: 100000202, cap: 4 },
  { Id: 30005, start: 240, len: 90, name: "Hot 26", teacher: 100000203, cap: 40 },
];
/* T219: the course, ClassScheduleId 743, sixteen days out at 7pm, and its
 * one session. `enrolled` is who addclienttoenrollment has booked. */
const enrollments = WORKSHOP
  ? [
      {
        Id: 743,
        ClassDescription: { Id: 9743, Name: "Gratitude Yin Sound Bath" },
        StartDate: `${day(16)}T00:00:00`,
        EndDate: `${day(16)}T00:00:00`,
        StartTime: "1900-01-01T19:00:00",
        EndTime: "1900-01-01T20:30:00",
        cap: 2,
        enrolled: [],
      },
    ]
  : [];
const enrollmentRow = (e) => ({
  Id: e.Id,
  ClassDescription: e.ClassDescription,
  StartDate: e.StartDate,
  EndDate: e.EndDate,
  StartTime: e.StartTime,
  EndTime: e.EndTime,
  Classes: [
    {
      Id: 124900 + (e.Id % 100),
      ClassScheduleId: e.Id,
      StartDateTime: `${e.StartDate.slice(0, 10)}T${e.StartTime.slice(11)}`,
      EndDateTime: `${e.EndDate.slice(0, 10)}T${e.EndTime.slice(11)}`,
      MaxCapacity: e.cap,
      TotalBooked: e.enrolled.length,
      IsCanceled: false,
    },
  ],
});
let visitSeq = 800000;
const visits = {}; /* classId -> visit[] */
function visit(classId, clientId, productId, signedIn = false) {
  const cs = productId
    ? clientServices.find((s) => s.ClientId === String(clientId) && s.ProductId === productId)
    : null;
  const c = byId(clientId);
  return {
    Id: ++visitSeq,
    ClassId: classId,
    ClientId: String(clientId),
    ClientUniqueId: c.UniqueId,
    Name: classDefs.find((d) => d.Id === classId).name,
    StartDateTime: at(classDefs.find((d) => d.Id === classId).start),
    SignedIn: signedIn,
    ServiceName: cs ? cs.Name : null,
    Service: cs ? { ...cs, Remaining: Math.max(cs.Remaining - 1, 0) } : null,
    LateCancelled: false,
    MakeUp: false,
  };
}
visits[30001] = [visit(30001, 10101, 1005, true), visit(30001, 10111, 1003, true), visit(30001, 10113, 1005, true)];
visits[30002] = [visit(30002, 10104, 1005, true), visit(30002, 10120, 1002, true)];
visits[30003] = [
  visit(30003, 10101, 1005, true),
  visit(30003, 10102, 1003, true),
  visit(30003, 10103, 1002),
  visit(30003, 10104, 1005),
  visit(30003, 10105, null),
  visit(30003, 10106, 1003),
  visit(30003, 10107, null),
  visit(30003, 10108, 1005),
  visit(30003, 10109, 1004),
  visit(30003, 10110, 1002),
];
visits[30004] = [
  visit(30004, 10111, 1003),
  visit(30004, 10113, 1005),
  visit(30004, 10114, 1001),
  visit(30004, 10118, 1003),
];
visits[30005] = [visit(30005, 10120, 1002)];
const waitlist = {}; /* classId -> entries */

function classRow(d) {
  const s = staff.find((x) => x.Id === d.teacher);
  const booked = (visits[d.Id] ?? []).length;
  return {
    Id: d.Id,
    ClassScheduleId: d.Id - 20000,
    StartDateTime: at(d.start),
    EndDateTime: at(d.start + d.len),
    IsCanceled: false,
    IsAvailable: booked < d.cap,
    MaxCapacity: d.cap,
    TotalBooked: booked,
    TotalSignedIn: (visits[d.Id] ?? []).filter((v) => v.SignedIn).length,
    WebCapacity: d.cap,
    TotalBookedWaitlist: (waitlist[d.Id] ?? []).length,
    ClassDescription: { Id: d.Id, Name: d.name, Program: { Id: 1, Name: "Classes" } },
    Staff: staffName(s),
    Location: { Id: 1, Name: "Fremont neighborhood, Seattle" },
  };
}

/* ---------- sales ---------------------------------------------------- */

const sales = [];
let saleSeq = 3100000;
function priceCart(body) {
  let sub = 0;
  let tax = 0;
  const lines = [];
  for (const it of body.Items ?? []) {
    const meta = it?.Item?.Metadata ?? {};
    const id = String(meta.Id ?? "");
    const found = allItems().find((x) => String(x.ProductId) === id || String(x.Id) === id);
    const qty = Number(it.Quantity ?? 1);
    const price = found ? found.Price : 0;
    sub += price * qty;
    tax += price * qty * (found?.TaxRate ?? 0);
    lines.push({ found, qty, id, type: it?.Item?.Type });
  }
  let disc = 0;
  for (const it of body.Items ?? []) {
    const d = Number(it?.DiscountAmount ?? 0);
    if (Number.isFinite(d)) disc += d;
  }
  /* Tax on the discounted amount, proportionally. */
  if (sub > 0 && disc > 0) tax = tax * ((sub - disc) / sub);
  const r = (n) => Math.round(n * 100) / 100;
  return { sub: r(sub), tax: r(tax), disc: r(disc), total: r(sub - disc + tax), lines };
}

/* ---------- the server ----------------------------------------------- */

function send(res, status, obj) {
  const text = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}
function all(params, key) {
  const out = [];
  for (const [k, v] of params) if (k.toLowerCase() === key.toLowerCase() || k.toLowerCase() === `request.${key.toLowerCase()}`) out.push(v);
  return out;
}
function one(params, key) {
  return all(params, key)[0] ?? null;
}
const page = (arr) => ({ PaginationResponse: { RequestedLimit: 200, RequestedOffset: 0, PageSize: arr.length, TotalResults: arr.length } });

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname.replace(/^\/public\/v6/, "").toLowerCase();
    const q = url.searchParams;
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {}
    try {
      handle(req.method, path, q, body, res);
    } catch (e) {
      console.error("[fake-mb] error", path, e);
      send(res, 500, { Error: { Message: String(e), Code: "Fake" } });
    }
  });
});

function handle(method, path, q, body, res) {
  console.log(`[fake-mb] ${method} ${path}${q.size ? "?" + q.toString().slice(0, 120) : ""}`);
  switch (path) {
    case "/usertoken/issue": {
      const u = String(body.Username ?? "").toLowerCase();
      if (logins[u] && body.Password) {
        const s = staff.find((x) => x.Id === logins[u]);
        return send(res, 200, { TokenType: "Bearer", AccessToken: `tok-${s.Id}-${Date.now()}`, User: { Id: s.Id, FirstName: s.FirstName, LastName: s.LastName, Type: "Staff" } });
      }
      if (body.Password) {
        return send(res, 200, { TokenType: "Bearer", AccessToken: `tok-svc-${Date.now()}`, User: { Id: 100000140, FirstName: "Sealevel", LastName: "API", Type: "Staff" } });
      }
      return send(res, 401, { Error: { Message: "Staff identity authentication failed.", Code: "DeniedAccess" } });
    }
    case "/usertoken/revoke":
      return send(res, 200, {});
    case "/staff/staff": {
      const ids = all(q, "StaffIds").map(Number);
      const rows = (ids.length ? staff.filter((s) => ids.includes(s.Id)) : staff).map(staffName);
      return send(res, 200, { ...page(rows), StaffMembers: rows });
    }
    case "/staff/staffpermissions":
      return send(res, 200, {
        PermissionGroupName: "Front Desk",
        AllowedPermissions: ["LaunchSignInScreen", "BookClassesAndEventsWithoutPayment", "MakeSales", "CreateRetailTickets", "UseStoredCreditCards", "AddProductsOnRetailScreen"],
        DeniedPermissions: [],
        IpRestricted: false,
      });
    case "/site/sites":
      return send(res, 200, { Sites: [{ Id: 471, Name: "Sealevel Hot Yoga" }] });
    case "/site/liabilitywaiver":
      return send(res, 200, {
        LiabilityWaiver:
          "<p><b>Release of liability.</b> I understand that hot yoga is physical exercise in a heated room and carries a risk of injury, dehydration and heat illness.</p><p>I confirm that I am in good health, that I will drink water, rest when I need to, and tell the teacher about any injury or condition before class.</p><p>I release Sealevel Hot Yoga, its teachers and staff from liability for any injury arising from my participation, except where caused by gross negligence.</p><p>I agree to follow the teacher's instructions and the studio's policies.</p>",
      });
    case "/site/categories":
      return send(res, 200, { ...page([]), Categories: [] });
    case "/site/paymenttypes":
      return send(res, 200, { PaymentTypes: [{ Id: 1, PaymentTypeName: "Cash", Active: true }, { Id: 2, PaymentTypeName: "Check", Active: true }] });

    case "/class/classes": {
      const ids = all(q, "ClassIds").map(Number);
      const start = one(q, "StartDateTime");
      const end = one(q, "EndDateTime");
      let rows = classDefs.map(classRow);
      if (ids.length) rows = rows.filter((r) => ids.includes(r.Id));
      if (start) rows = rows.filter((r) => r.StartDateTime >= start.slice(0, 19));
      if (end) rows = rows.filter((r) => r.StartDateTime < end.slice(0, 19));
      return send(res, 200, { ...page(rows), Classes: rows });
    }
    case "/class/classvisits": {
      const id = Number(one(q, "ClassId"));
      const d = classDefs.find((x) => x.Id === id);
      return send(res, 200, { Class: { ...(d ? classRow(d) : {}), Visits: visits[id] ?? [] } });
    }
    case "/class/waitlistentries": {
      const ids = all(q, "ClassIds").map(Number);
      const rows = ids.flatMap((id) => waitlist[id] ?? []);
      return send(res, 200, { ...page(rows), WaitlistEntries: rows });
    }
    case "/class/addclienttoclass": {
      const classId = Number(body.ClassId);
      const c = byId(body.ClientId);
      if (!c) return send(res, 400, { Error: { Message: "Client not found.", Code: "InvalidParameter" } });
      if (body.Waitlist === true) {
        const entry = { Id: 60000 + Math.floor(Math.random() * 9999), ClassId: classId, RequestDateTime: wall(new Date()), Client: { Id: c.Id, UniqueId: c.UniqueId, FirstName: c.FirstName, LastName: c.LastName } };
        (waitlist[classId] ??= []).push(entry);
        return send(res, 200, { Visit: null, WaitlistEntryId: entry.Id });
      }
      const csIdWanted = body.ClientServiceId ? Number(body.ClientServiceId) : null;
      let cs = csIdWanted ? clientServices.find((s) => s.Id === csIdWanted) : clientServices.find((s) => s.ClientId === c.Id && s.Remaining > 0 && !/guest/i.test(s.Name));
      if (body.RequirePayment === false && !csIdWanted) cs = cs ?? null;
      const v = {
        Id: ++visitSeq,
        ClassId: classId,
        ClientId: c.Id,
        ClientUniqueId: c.UniqueId,
        Name: classDefs.find((d) => d.Id === classId)?.name,
        StartDateTime: at(classDefs.find((d) => d.Id === classId)?.start ?? 0),
        SignedIn: false,
        ServiceName: cs ? cs.Name : null,
        Service: cs ? { ...cs, Remaining: Math.max(cs.Remaining - 1, 0) } : null,
      };
      if (cs && cs.Remaining < 900) cs.Remaining -= 1;
      (visits[classId] ??= []).push(v);
      return send(res, 200, { Visit: v });
    }
    case "/enrollment/enrollments": {
      const ids = all(q, "ClassScheduleIds").map(Number);
      const rows = enrollments.filter((e) => !ids.length || ids.includes(e.Id)).map(enrollmentRow);
      return send(res, 200, { ...page(rows), Enrollments: rows });
    }
    case "/enrollment/addclienttoenrollment": {
      const e = enrollments.find((x) => x.Id === Number(body.ClassScheduleId));
      const c = byId(body.ClientId);
      if (!e) return send(res, 400, { Error: { Message: "Enrollment not found.", Code: "InvalidParameter" } });
      if (!c) return send(res, 400, { Error: { Message: "Client not found.", Code: "InvalidParameter" } });
      if (e.enrolled.includes(c.Id)) return send(res, 400, { Error: { Message: "The client is already enrolled.", Code: "ClientIsAlreadyBooked" } });
      if (body.Test !== true) e.enrolled.push(c.Id);
      console.log(`[fake-mb] enrolled ${c.Id} in ${e.Id}${body.Waitlist ? " (waiting list)" : ""}`);
      return send(res, 200, enrollmentRow(e));
    }
    case "/class/removeclientfromclass": {
      const classId = Number(body.ClassId);
      visits[classId] = (visits[classId] ?? []).filter((v) => v.ClientId !== String(body.ClientId));
      return send(res, 200, { Class: classRow(classDefs.find((d) => d.Id === classId)) });
    }
    case "/client/updateclientvisit": {
      for (const list of Object.values(visits)) {
        const v = list.find((x) => x.Id === Number(body.VisitId));
        if (v) {
          if (typeof body.SignedIn === "boolean") v.SignedIn = body.SignedIn;
          if (body.ClientServiceId) {
            const cs = clientServices.find((s) => s.Id === Number(body.ClientServiceId));
            if (cs) {
              v.ServiceName = cs.Name;
              v.Service = { ...cs, Remaining: Math.max(cs.Remaining - 1, 0) };
              if (cs.Remaining < 900) cs.Remaining -= 1;
            }
          }
          return send(res, 200, { Visit: v });
        }
      }
      return send(res, 400, { Error: { Message: "Visit not found.", Code: "InvalidParameter" } });
    }
    case "/client/addarrival":
      return send(res, 200, { ArrivalAdded: true });

    case "/client/clients": {
      const ids = all(q, "clientIds");
      const text = one(q, "searchText");
      let rows = clients;
      if (ids.length) rows = clients.filter((c) => ids.includes(c.Id));
      else if (text) {
        const t = text.toLowerCase().trim();
        rows = clients.filter((c) =>
          `${c.FirstName} ${c.LastName}`.toLowerCase().includes(t) ||
          c.LastName.toLowerCase().startsWith(t) ||
          c.Email.toLowerCase().includes(t),
        );
      }
      return send(res, 200, { ...page(rows), Clients: rows });
    }
    case "/client/clientservices": {
      const id = one(q, "ClientId");
      const rows = clientServices.filter((s) => s.ClientId === String(id) && s.Current !== false && (s.Remaining > 0));
      return send(res, 200, { ...page(rows), ClientServices: rows });
    }
    case "/client/clientcontracts": {
      const id = one(q, "ClientId");
      const rows = contractsHeld[id] ?? [];
      return send(res, 200, { ...page(rows), Contracts: rows });
    }
    case "/client/clientvisits": {
      const uniq = one(q, "UniqueClientId");
      const c = uniq ? clients.find((x) => String(x.UniqueId) === uniq) : byId(one(q, "ClientId"));
      const past = [];
      /* Days ago of each past visit, per client, so the roster's history
       * line varies: "3rd class this week", "5 visits in the last month",
       * "Last here 9/2", or nothing for a brand new student. */
      const pattern = {
        10101: [1, 2, 4, 9, 12], 10102: [2, 6, 13, 20], 10103: [3, 10, 17, 24, 27],
        10104: [1, 3, 5, 8], 10106: [12, 25], 10107: [65], 10108: [2, 4, 6, 9],
        10109: [1, 3], 10110: [5], 10111: [1, 8, 15], 10113: [2, 5, 7],
        10114: [40], 10118: [6, 14], 10120: [1, 4],
      }[c?.Id] ?? [];
      for (const [i, ago] of pattern.entries()) {
        past.push({ Id: 700000 + i, ClientId: c.Id, Name: i % 2 ? "Hot 26" : "Hot Flow", StartDateTime: day(-ago) + "T17:30:00", SignedIn: true, ServiceName: "10 Class Series" });
      }
      /* The first-class check (T217) asks oldest-first for everything up
       * to a class's start, so it also gets the client's bookings in
       * today's classes. The history line's call (no Order) gets only the
       * invented past, which keeps those lines as the guide shows them. */
      if (c && one(q, "Order")) {
        for (const list of Object.values(visits)) {
          for (const v of list) if (v.ClientId === c.Id) past.push(v);
        }
        const from = (one(q, "StartDate") ?? "").slice(0, 19);
        const to = (one(q, "EndDate") ?? "9999").slice(0, 19);
        const rows = past
          .filter((v) => v.StartDateTime >= from && v.StartDateTime <= to)
          .sort((a, b) => a.StartDateTime.localeCompare(b.StartDateTime))
          .slice(0, Number(one(q, "Limit") ?? 100));
        return send(res, 200, { ...page(rows), Visits: rows });
      }
      return send(res, 200, { ...page(past), Visits: past });
    }
    case "/client/requiredclientfields":
      return send(res, 200, { RequiredClientFields: ["FirstName", "LastName", "Email"] });
    case "/client/addclient": {
      const id = 10200 + clients.length;
      const c = client(id, body.FirstName ?? "New", body.LastName ?? "Client", {
        Email: body.Email ?? "",
        MobilePhone: body.MobilePhone ?? "",
        Liability: { IsReleased: false },
        CreationDate: wall(new Date()),
        FirstClassDate: null,
      });
      clients.push(c);
      return send(res, 200, { Client: c });
    }
    case "/client/updateclient": {
      const incoming = body.Client ?? {};
      const c = byId(incoming.Id);
      if (!c) return send(res, 400, { Error: { Message: "Client not found.", Code: "InvalidParameter" } });
      for (const [k, v] of Object.entries(incoming)) {
        if (k === "Id") continue;
        if (k === "Liability" || k === "LiabilityRelease") continue;
        c[k] = v;
      }
      if (incoming.LiabilityRelease === true) c.Liability = { IsReleased: true, AgreementDate: wall(new Date()) };
      return send(res, 200, { Client: c });
    }
    case "/client/addclientformulanote":
      return send(res, 400, { Error: { Message: "This site does not have formula notes enabled", Code: "InvalidParameter" } });
    case "/client/uploadclientdocument":
      return send(res, 200, { FileSize: 72, FileName: body.File?.FileName ?? "waiver.png" });

    case "/sale/services": {
      return send(res, 200, { ...page(services), Services: services.map((s) => ({ ...s, SellAtLocationIds: [1] })) });
    }
    case "/sale/products": {
      const cats = all(q, "categoryIds").map(Number);
      const rows = products.filter((p) => !cats.length || cats.includes(p.CategoryId));
      return send(res, 200, { ...page(rows), Products: rows });
    }
    case "/sale/packages":
      return send(res, 200, { ...page([]), Packages: [] });
    case "/sale/contracts":
      return send(res, 200, { ...page(contracts), Contracts: contracts });
    case "/sale/giftcards":
      return send(res, 200, { ...page(giftcards), GiftCards: giftcards });
    case "/sale/giftcardbalance":
      return send(res, 200, { BarcodeId: one(q, "barcodeId"), RemainingBalance: 0 });
    case "/sale/checkoutshoppingcart": {
      const p = priceCart(body);
      const purchased = p.lines.map((l) => ({
        Id: l.found?.ProductId ?? l.id,
        BarcodeId: l.found?.Id ?? null,
        Name: l.found?.Name ?? "Item",
        IsService: l.found?._kind === "Service",
        Quantity: l.qty,
        Price: l.found?.Price ?? 0,
      }));
      const cart = {
        Id: `cart-${Date.now()}`,
        CartItems: p.lines.map((l) => ({ Item: { Id: l.found?.Id, ProductId: l.found?.ProductId, Name: l.found?.Name, Price: l.found?.Price, TaxRate: l.found?.TaxRate }, Quantity: l.qty })),
        SubTotal: p.sub,
        DiscountTotal: p.disc,
        TaxTotal: p.tax,
        GrandTotal: p.total,
      };
      if (body.Test === true) return send(res, 200, { ShoppingCart: cart });
      const saleId = ++saleSeq;
      sales.push({ Id: saleId, ClientId: String(body.ClientId ?? ""), SaleDateTime: wall(new Date()), PurchasedItems: purchased, Payments: body.Payments ?? [] });
      /* A pass sold becomes a ClientService the app re-reads. */
      for (const l of p.lines) {
        if (l.found?._kind === "Service" && body.ClientId) {
          clientServices.push(pass(body.ClientId, l.found.ProductId, l.found.Count ?? 1, { PaymentDate: wall(new Date()) }));
        }
      }
      return send(res, 200, { ShoppingCart: { ...cart, Id: String(saleId), PurchasedItems: purchased } });
    }
    case "/sale/sales": {
      return send(res, 200, { ...page(sales), Sales: sales.slice().reverse() });
    }
    case "/sale/purchasecontract": {
      const c = contracts.find((x) => x.Id === Number(body.ContractId)) ?? contracts[0];
      const tax = 0;
      const totals = { SubTotal: c.FirstPaymentAmountTotal, Discount: 0, Tax: tax, Total: c.FirstPaymentAmountTotal };
      if (body.Test === true) return send(res, 200, { Totals: totals, ClientContractId: null });
      contractsHeld[body.ClientId] = [{ Id: 7100, ContractName: c.Name, StartDate: (body.StartDate ?? day(0)) + "T00:00:00", EndDate: day(365) + "T00:00:00" }];
      const cl = byId(body.ClientId);
      if (cl) cl.MembershipIcon = 1;
      clientServices.push(pass(body.ClientId, 1005, 999));
      return send(res, 200, { Totals: totals, ClientContractId: 7100, PaymentProcessingFailures: [] });
    }
    case "/sale/purchasegiftcard": {
      const amount = body.PaymentInfo?.Metadata?.Amount ?? body.PaymentInfo?.Amount ?? 0;
      const gc = giftcards.find((g) => g.Id === Number(body.GiftCardId));
      const value = gc && !gc.EditableByConsumer ? gc.CardValue : Number(amount);
      return send(res, 200, { BarcodeId: body.BarcodeId, Value: value, AmountPaid: Number(amount), SaleId: body.Test ? null : ++saleSeq });
    }
    case "/sale/purchaseaccountcredit":
      return send(res, 200, { SaleId: ++saleSeq, AmountPaid: body.Amount ?? 0 });
    case "/sale/returnsale":
      return send(res, 200, { ReturnSaleID: ++saleSeq });
    case "/sale/alternativepaymentmethods":
      return send(res, 400, { Error: { Message: "Not supported", Code: "Fake" } });
    default:
      console.warn(`[fake-mb] UNHANDLED ${method} ${path}`);
      return send(res, 200, {});
  }
}

server.listen(PORT, () => {
  console.log(`[fake-mb] listening on :${PORT}, current class starts ${at(0)}`);
});
