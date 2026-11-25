## 1. Open pull requests

| PR | Branch | Task | State / next step |
|---|---|---|---|
| #195 | g3-daily | Reset feedback notices | Open |

## 2. Deploy

| Item | State |
|---|---|
| Master | Pending |

## 3. Production backlog

### Priority plan: test first, then split

Order: G3-TRACKING → NR8.

| ID | Phase | Task | State |
|---|---|---|---|
| NR8 | B perf | Memory: trim heat pump templates | open |
| P-R1 | process | After-the-fact review of #103 | done |

| ID | Task | Size (days) | Notes |
|---|---|---|---|
| B6 | Temperatures page: all sensors, day-by-day paging, motion sensor | 0–1 | Check first: a temperatures page with motion exists. |

### Process and repo (review 2026-11-21)

| ID | Task | State | Notes |
|---|---|---|---|
| R1 | `CLAUDE.md` + `AGENTS.md` | Done: #91 | Phase 1, docs / config only. |
| AUTO1 | Autonomous dev loop on Omarchy | Done: #193 | `tools/dev-loop`. |

### Node-RED refactoring, grid control first

| ID | Task | Depends on | State | Notes |
|---|---|---|---|---|
| G3-DAILY | Reset feedback notices at the Oslo day boundary | G3 | in progress | |
| G3-TRACKING | Detect sustained physical import divergence | G3 | open | Define the threshold before enabling alarms. |

### Heat pump batch H0–H12

| ID | Task | Notes |
|---|---|---|
| H9 | Review that all data is stored | Add what is missing, report gaps. |

### Approved follow-up queue after HP-C1

| ID | Task | State / notes |
|---|---|---|
| H16 | Heat pump idle follow-ups | Blocked: needs diagnostics. |
| AI1 | Monitoring and curve control split by job | Open. Owner curve remains in control. |

## 4. Review follow-ups (deferred Low / Nit)

| From | Item |
|---|---|
| #69 | Worst-case repacks against the 600 s exec timeout. |
| #69 | An interrupted mail send clears the backups list on the card. |

## 5. Test GX plan

| # | Task | State |
|---|---|---|
| 2 | Charging scenarios | Done (#55) |
| 5 | Edges: midnight, DST, month change, tariff tier change, sensor failures | Pending |

## 6. Done (for reference)

| ID | Task | State |
|---|---|---|
| EXCLUDED | Completed work | Done |
