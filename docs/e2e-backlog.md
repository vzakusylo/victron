# End-to-end test backlog

| Item | Scenario | Inputs | Expected write | Status |
| --- | --- | --- | --- | --- |
| P1 | Version badge appears in the top-right header on every page | Open every page after a stamped deployment | None; all pages show the same `d#<n> · <sha7>` badge | todo |
| P1 | Menu names stay plain | Open the dashboard menu after migrating from a legacy stamped deployment | None; names contain neither `d#<n>` nor a Git source suffix | todo |
| P1 | Open dashboard updates after a deploy that bumps `d#` | Leave a dashboard page open and deploy a build with the next flow version and a new dashboard commit | Deployment updates the version tab; the header shows the new `d#` and dashboard SHA without a manual page reload | todo |
