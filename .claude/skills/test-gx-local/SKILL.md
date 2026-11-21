---
name: test-gx-local
description: Run Test GX scenarios locally in Docker (Venus simulator + Node-RED with the synthetic fixture) - start the stack, run one scenario file or one scenario, read the result, stop the stack. Use when the user asks to run GX tests / Test GX / scenarios locally, reproduce a failing Test GX scenario, or check a new scenario before pushing.
---

# Test GX locally

Fake data only: never pass a real backup unless the owner asks (`-Backup` needs a sanitized directory).

1. **Docker up:** `docker version` must answer. Start the stack from the repo root:
   `.\tools\test-gx\up.ps1 -Sim emu` (builds the image the first time, ~5 min). Ready when
   `http://127.0.0.1:8081/state` and `http://127.0.0.1:1881/flows` answer.
2. **Run scenarios** (long: start in the background or a terminal tab, never block on it):
   - one file: `node tools/test-gx/run-scenarios.js --file heating-review.yml --junit out/junit.xml`
   - one scenario: `node tools/test-gx/run-scenarios.js --scenario "<exact name>"`
   - all: `node tools/test-gx/run-scenarios.js`
   Progress lines `RUNNING <name>: N real min elapsed` are normal; a scenario's real time depends on its `faketime`
   rate (`@2026-11-16 20:00:00 x60`).
3. **Read the result:** `PASS` / `FAIL <name>: step N: expected ..., received ...` / `EXPECTED_FAIL`. On a failure, read
   the step in `tools/test-gx/scenarios/<file>.yml`, the emulator writes (`curl http://127.0.0.1:8081/writes`) and the
   Node-RED log (`docker compose -p test-gx logs nodered`).
4. **Rules:** Test GX work does not change production `NN` sources. A real production bug is marked `expected_fail`
   with a reference and fixed in its own PR. A new scenario file must be added to the `files` matrix in
   `.github/workflows/test-gx.yml` (a unit test checks it).
5. **Stop:** `.\tools\test-gx\up.ps1 -Down`. Do not remove Docker data volumes without the owner.

CI: `test-gx.yml` runs one job per scenario file in parallel; the required check is the final `scenarios` job.
