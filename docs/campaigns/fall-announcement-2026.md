# Fall 2026 schedule announcement (SEA-88)

Review copy of the campaign's content brief. The canonical, machine-read
version lives in `packages/core/src/campaigns/fallAnnouncement.ts`; if this
page and that module disagree, fix both. The send itself is SEA-89 (week of
Sept 7). Nothing below marked NEEDS VERIFICATION may ship until Pete
confirms it against the actual published Mindbody fall schedule.

- Campaign key: `fall-announcement-2026`
- Audience view: `v_campaign_fall_announcement` (sealevel-analytics, branch
  `claude/sea-88-fall-view`)
- Copy house rule: no em dashes anywhere in outgoing copy. The brief and
  the fan-out code both enforce this.

## Schedule facts the email may state

| Fact | Status |
|---|---|
| The fall schedule adds roughly 25 new weekly classes. | NEEDS VERIFICATION (exact count) |
| A new 4pm class slot is added on weekdays. | NEEDS VERIFICATION (which days, which class types) |
| The 5pm evening classes move to 5:30pm. | NEEDS VERIFICATION (current live schedule shows 5pm 60-minute classes Fri through Sun; confirm which days shift) |
| The studio now runs two rooms; overlapping class times are both really happening and are not conflicts. | NEEDS VERIFICATION (confirm the second room is live for fall) |
| Vinyasa is new to the studio this fall, with its own dedicated program. | Confirmed (wiki: upstairs-room vinyasa program, fall 2026; live schedule already lists Hot Vinyasa Flow, Mondays 8am) |
| Regular hot 26 and 2 classes continue as always, at 60 and 90 minutes. | Confirmed (live Mindbody schedule, checked 2026-08-12) |

Copy must not claim anything beyond these facts plus the per-segment
framing below. No invented class names, times, teachers, or prices.

## Audience segments and framing

Buckets come from `v_campaign_fall_announcement`: active in the trailing
12 months, class-type affinity from attended visits, first match wins in
this order. Counts below are from the 2026-07-01 analytics mirror.

### lapsed_recent (~1,357 clients)
Active in the last year, but last visit more than 60 days ago. Win-back
tone, no guilt. Lead with what changed: the biggest schedule refresh in
years. New times (4pm, 5:30pm) as more ways back in. Vinyasa framed as a
genuinely new reason to return.

### vinyasa_curious (0 today; fills as vinyasa visits land in export data)
Active clients who already took a vinyasa class. Talk to them as early
adopters: the program they sampled is growing into a full weekly schedule.

### hot_only (~375 clients)
All visits in the last year are hot classes. Reassure first: the heat and
their classes are not changing. Vinyasa framed as a different rhythm in
the same heat, flowing and breath-led rather than the fixed sequence. Call
out the 5:30pm shift plainly so evening regulars are not surprised.

### generalist (~119 clients)
Mixed-format or non-hot practice. Lead with breadth across the whole
schedule. Vinyasa framed as a natural addition between the heat and the
stillness they already enjoy. Two rooms means more of what they like runs
side by side.

## For Pete to confirm before SEA-89

1. The four NEEDS VERIFICATION facts above, against the published fall
   schedule (exact class count, 4pm days/types, which 5pm classes shift,
   second room live).
2. The bucket definitions and the 60-day lapsed line (same recency line
   as `v_client_activity`).
3. Whether the vinyasa_curious bucket being empty at launch is acceptable
   (it exists so send-week data lands in the right copy automatically).
