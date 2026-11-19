# End-to-end test backlog

| Item | Scenario | Inputs | Expected write | Status |
| --- | --- | --- | --- | --- |
| P1 | Version badge appears in the top-right header on every page | Open every page after a stamped deployment | None; all pages show the same `d#<n> · <sha7>` badge | todo |
| P1 | Menu names stay plain | Open the dashboard menu after migrating from a legacy stamped deployment | None; names contain neither `d#<n>` nor a Git source suffix | todo |
| P1 | Open dashboard updates after a deploy that bumps `d#` | Leave a dashboard page open and deploy a build with the next flow version and a new dashboard commit | Deployment updates the version tab; the header shows the new `d#` and dashboard SHA without a manual page reload | todo |
| P5 | Dated archives include sensor logs | Send manual 7-day and 31-day archives and trigger a weekly send using synthetic logs spanning UTC/Oslo midnight | One e-mail per send; UTC dates for core and air, Oslo dates for temperatures and events, one catalogue, no config | todo |
| P5 | Dated archive trims optional logs to 18 MiB | Use synthetic incompressible files across all three optional sets | E-mail attachment fits; omissions are largest-first within events, then temperatures, then air; e-mail lists omitted paths and retains core | todo |
| P5 | Oversized core is refused; all-history and full backup keep their existing behavior | Try dated mail with core alone over 18 MiB, then exercise all-history mail and full backup against synthetic data | No e-mail for oversized core; all-history mail keeps whole log tree or refuses it, full backup retains its normal paths | todo |
