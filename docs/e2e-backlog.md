# End-to-end test backlog

| Item | Scenario | Inputs | Expected write | Status |
| --- | --- | --- | --- | --- |
| P1 | Version badge appears in the top-right header on every page | Open every page after a stamped deployment | None; all pages show the same `d#<n> · <sha7>` badge | todo |
| P1 | Menu names stay plain | Open the dashboard menu after migrating from a legacy stamped deployment | None; names contain neither `d#<n>` nor a Git source suffix | todo |
| P1 | Open dashboard updates after a deploy that bumps `d#` | Leave a dashboard page open and deploy a build with the next flow version and a new dashboard commit | Deployment updates the version tab; the header shows the new `d#` and dashboard SHA without a manual page reload | todo |
| P5 | Dated archives include sensor logs | Send manual 7-day and 31-day archives and trigger a weekly send using synthetic logs spanning UTC/Oslo midnight | One e-mail per send; UTC dates for core and air, Oslo dates for temperatures and events, one catalogue, no config | todo |
| P5 | Dated archive trims optional logs to 18 MiB | Use synthetic incompressible files across all three optional sets | E-mail attachment fits; omissions are largest-first within events, then temperatures, then air; e-mail lists omitted paths and retains core | todo |
| P5 | Oversized core is refused; all-history and full backup keep their existing behavior | Try dated mail with core alone over 18 MiB, then exercise all-history mail and full backup against synthetic data | No e-mail for oversized core; all-history mail keeps whole log tree or refuses it, full backup retains its normal paths | todo |
| P5f | Dated archive near UTC midnight | Manually send at 23:30 UTC with synthetic sensor events at the UTC and Oslo day boundaries | Attachment includes the first UTC day's sensor-event file and excludes the next day's file | todo |
| P5f | Mail staging cleanup and bounded repacks | Seed stale mail files, interrupt a send, then retry with oversized optional sets | Stale files are removed, the next send succeeds, final attachment stays within 18 MiB, and omitted paths are listed | todo |
| P4 | Toilet visits are counted once per visit | Local PIR reports at t, t+30 s and t+7 min; restart Node-RED between reports | `dhwUsage.<day>.visits` = 2 in `heat-pump-automations.json`; no extra visit after the restart | todo |
| P4 | Hot-water draws are linked to motion | Local motion, then the tank falls 2.5 °C within 3 min; later a 2 °C drop with no motion in the last 15 min | One draw with motion and one without; `dropC` and the hourly bucket updated; Heat Pump page shows the 7-day summary | todo |
| P5g | Archive mail reports why it stopped | Start a second mail while one runs; stop Node-RED / let the exec time out mid-pack | Second send: "Another data archive mail is running"; interrupted send: "@@ERROR Data archive interrupted", no staging files left in /tmp | todo |
| B1 | Heat Pump + history pages render with no console errors (null curve point, no plan) | open pages with missing values | no `cy=""` / $parse errors | todo |
