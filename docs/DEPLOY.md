# Deploying the counter app (Railway)

The repo carries `railway.json` (Nixpacks, `npm ci && npm run build`,
`npm run start` on `$PORT`). The database schema migrates itself on
first use. Nothing else is needed on the platform side.

## First deploy

1. **Railway: New Project, Deploy from GitHub repo**, pick
   `petestewart/sealevel-pos`. Set the branch to deploy under the
   service's Settings (Source): `main` once feature/phase-2 is merged,
   or `feature/phase-2` for a trial.
2. **Add a Postgres service** to the same project (New, Database,
   PostgreSQL). Nothing to configure on it.
3. **Variables on the app service** (Settings, Variables, Raw editor):

   ```
   MINDBODY_TARGET=prod
   MINDBODY_PROD_API_KEY=<the studio's API key>
   MINDBODY_PROD_SITE_ID=471
   MINDBODY_PROD_STAFF_USERNAME=<the API staff login>
   MINDBODY_PROD_STAFF_PASSWORD=<its password>
   POS_PIN=<digits for the device lock screen>
   POS_SESSION_SECRET=<openssl rand -hex 32>
   POS_PIN_PEPPER=<openssl rand -hex 32>
   POS_HOUSE_CLIENT_ID=1
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   POS_DEVTOOLS=false
   POS_DRY_RUN=true
   POS_WRITE_CLIENT_IDS=
   POS_ADMIN_STAFF_IDS=<the staff ids allowed to switch target, or empty>
   ```

   Optional, and only if the counter should be able to point itself at
   Mindbody's sandbox without a redeploy (T89). Both of these plus
   `POS_ADMIN_STAFF_IDS` are needed before the switch will do anything:

   ```
   MINDBODY_SANDBOX_API_KEY=<a key issued for site -99>
   MINDBODY_SANDBOX_SITE_ID=-99
   MINDBODY_SANDBOX_STAFF_USERNAME=<a staff login on site -99>
   MINDBODY_SANDBOX_STAFF_PASSWORD=<its password>
   ```

   The sandbox needs credentials issued FOR site -99: the studio's own
   API login belongs to site 471 and authenticates nowhere else. Leaving
   these unset is the normal production posture, and the switch then
   refuses by name rather than half working.

   `POS_SESSION_SECRET` and `POS_PIN_PEPPER` are random and never typed
   by anyone. Keep them: changing the first logs every device out,
   changing the second orphans every stored teacher PIN.
4. **Generate a domain** (Settings, Networking, Generate Domain). Open
   it on the iPad, enter the PIN, sign in as a teacher, and use Share,
   Add to Home Screen.
5. `GET /api/config` on that domain should report `target: "prod"`,
   `dryRun: true`, `storage: "postgres"`, and the banner across the top
   should say dry run. If it says `storage: "none"`, the DATABASE_URL
   reference did not resolve; the app still runs on its fallbacks.

## Going live

With `POS_DRY_RUN=true` every screen works against real data and every
write is suppressed and logged. When taps should check real students in
and sales should charge:

```
POS_DRY_RUN=false
```

Leave `POS_WRITE_CLIENT_IDS` empty in production. The banner switches to
"LIVE" on the next load; a teacher must never have to wonder which.

One iPad can still rehearse on a live server: the dev drawer's "dry run
on this iPad" control (T89) sets a cookie this app reads per request, and
writes from THAT browser are suppressed and logged while every other
counter keeps writing. It can only add suppression, never remove it, so
`POS_DRY_RUN=true` overrides it and the control shows as forced on. The
banner on that iPad reads "Dry run on this iPad."

## Switching the studio target without a redeploy

`MINDBODY_TARGET` still decides by default. With `DATABASE_URL` set, both
credential sets present and the teacher's staff id in
`POS_ADMIN_STAFF_IDS`, the dev drawer's settings tab can switch the
counter between sandbox and prod (T89): the choice is stored in
`app_settings.mindbody_target` and survives a restart, `GET /api/config`
reports `targetSource: "setting"`, and every teacher is signed out by the
switch, since a Mindbody staff token belongs to the site that issued it.
Dry run and the write guard do NOT move with it: switching to prod lands
in dry run unless `POS_DRY_RUN=false` was deployed.

`POS_DEVTOOLS` must be `true` on the service for the switch to exist at
all, which means a deployment that wants it also exposes the dev drawer;
prefer leaving both off in production and switching by redeploy.

## Configuring the shelf and bundles

`POS_DEVTOOLS` must stay `false` on the deployed app: the dev drawer
exposes client names and call bodies. To hide items, group passes or
edit bundles, run the app locally with `POS_DEVTOOLS=true` and
`DATABASE_URL` set to the Railway Postgres's public connection string
(on the Postgres service, Variables, `DATABASE_PUBLIC_URL`), save in the
drawer, and the deployed app reads the same table on its next catalog
load. A proper admin surface outside the drawer is recorded future work.

## Redeploying

Railway redeploys on every push to the chosen branch. Since T78 a
restart keeps every teacher signed in: staff sessions live in the
`staff_sessions` table with the Mindbody token encrypted under
`POS_SESSION_SECRET`, so a sign-in made before the deploy still names
its teacher after it. With that secret or `DATABASE_URL` unset they
live in server memory only, and a restart signs everyone out and the
gate comes back. The device PIN session survives either way.

## Still unverified live

- That the Mindbody sales report names the signed-in teacher rather
  than the service account.
- What Mindbody returns for an expired staff token (the app treats a
  401 as the session ending).
- The plan's own last item: watch a teacher work a 6pm rush before
  trusting it at the counter.
