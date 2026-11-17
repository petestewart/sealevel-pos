# Training guide screenshots

`docs/training/front-desk-guide.html` is the teacher training guide. Its
screenshots in `docs/training/img/` are taken from the real app, run against
`fake-mindbody.mjs`: an invented studio with made-up students, so nothing
touches a real Mindbody site.

Re-take them whenever the screens change.

## 1. A local Postgres

Teacher PINs and sessions need a database. Any Postgres works; for example:

```bash
initdb -D /var/tmp/pgtrain -A trust -U postgres
pg_ctl -D /var/tmp/pgtrain -o '-p 5433 -k /tmp' start
createdb -h /tmp -p 5433 -U postgres pos
```

## 2. The environment

Production target with dry run off, so the screens show no practice banner.
That is safe here only because the base URL points at the fake server.

```bash
export MINDBODY_TARGET=prod
export MINDBODY_PROD_API_KEY=fake-key
export MINDBODY_PROD_SITE_ID=471
export MINDBODY_PROD_STAFF_USERNAME=sealevelapiuser
export MINDBODY_PROD_STAFF_PASSWORD=fake
export MINDBODY_API_BASE_URL=http://127.0.0.1:4010/public/v6
export POS_DRY_RUN=false
export POS_PIN=2468
export POS_SESSION_SECRET=training-demo-secret-0123456789abcdef
export DATABASE_URL="postgresql://postgres@localhost:5433/pos?host=/tmp"
export POS_HOUSE_CLIENT_ID=10199
export POS_DEVTOOLS=false
```

Never run the app with these settings and a real `MINDBODY_API_BASE_URL`.

## 3. Build and start the app

A production build, so no development overlay appears in the pictures.

```bash
npx next build && npx next start -p 3000
```

## 4. Take the screenshots

In a second shell with the same environment:

```bash
node scripts/training/capture.cjs
```

The script starts and restarts the fake server itself, once per flow, so
every flow begins from the same data. Name flows to re-take only those
(`node scripts/training/capture.cjs sale discount`). Run `signin` first on a
fresh database: it clears the stored teacher PIN and signs in, and the other
flows reuse that sign-in from `scripts/training/.state/`. A failed flow
leaves a `FAILED-<flow>.png` there showing where it stopped.

The demo class starts at the next quarter hour, so times in the pictures
follow the clock when they were taken.

`FAKE_MB_WORKSHOP=1` adds T219's workshop to the fake: the two Gratitude Yin
Sound Bath passes (ProductIds 1009 and 1010) and course 743, sixteen days
out with room for two, with `GET /enrollment/enrollments` and
`POST /enrollment/addclienttoenrollment`. It is off by default so the
shelf in the pictures does not change.
