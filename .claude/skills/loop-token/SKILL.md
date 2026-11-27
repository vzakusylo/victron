---
name: loop-token
description: Rotate the Windows dev loop's GitHub token (~/victron-loop/token) - prepare the fine-grained token page, have the owner generate and paste it into rotate-token.ps1, restart the loop, revoke the old token. Use when the owner says "rotate key for loop", "new loop token", the loop dashboard shows the token near expiry, or loop cycles fail with "error connecting to api.github.com", "token-invalid" or "token-missing".
---

# Loop token

The Windows loop (`tools/dev-loop/run-windows.ps1`) calls `gh` with `GH_TOKEN` read from `~/victron-loop/token`
on every cycle (`victron_loop/gh.py`). A bad, revoked or expired fine-grained token can show up as
"error connecting to api.github.com" (seen 26-27 Nov 2026), not only as HTTP 401. Only the Windows loop runs;
never start the Omarchy one.

**Agents never see, type or store the token.** Agents may prepare the GitHub page; the owner presses
Generate, copies the token and pastes it at the script's hidden prompt.

## Steps

1. **Check:** dashboard http://127.0.0.1:8790/ shows "GitHub loop token: expires in N days". To test the installed
   token, the owner runs `pwsh -NoProfile -File tools\dev-loop\rotate-token.ps1 -Check`.
2. **Prepare the page**, either:
   - owner runs `pwsh -NoProfile -File tools\dev-loop\new-token-page.ps1` (opens the pre-filled page, waits, then runs
     `rotate-token.ps1`), or
   - Claude fills https://github.com/settings/personal-access-tokens/new in the built-in browser (owner signs in):
     name `victron-loop <date>`, owner vzakusylo, 90 days, Only select repositories -> `vzakusylo/victron`,
     Contents / Pull requests / Workflows: Read and write, Actions: Read-only (Metadata read-only is required).
     Read the settings back from the page; stop at the Generate token button.
3. **Owner:** stop the loop (Ctrl+C), Generate token, click the copy icon and copy nothing else, then type (do not
   paste) `pwsh -NoProfile -File C:\learn\victron\tools\dev-loop\rotate-token.ps1` and paste once at the hidden prompt.
4. **Read the result:**
   - "Loop token installed" + "Loop dry run passed" = done. The warning "can list more than one repository" is
     expected (every fine-grained token reads public repos).
   - "Expected a fine-grained github_pat_ token" = the clipboard held something else (a token is 93 chars,
     `github_pat_...`). Copy again from GitHub, or Regenerate the token if the page is gone.
   - "...token-rotation.lock ... used by another process" = another `rotate-token.ps1` is waiting at its prompt;
     find it (`Get-CimInstance Win32_Process | ? CommandLine -match rotate-token`) and paste there or stop it.
   - Nothing is installed on failure; the old token stays in place. The previous token is kept as `token.prev`
     (`rotate-token.ps1 -Rollback` restores it).
5. **Restart:** `pwsh -NoProfile -File C:\learn\victron\tools\dev-loop\run-windows.ps1 -Live` in the owner's own
   terminal. Check the first cycle has no "error connecting" lines.
6. **Revoke** the old token at https://github.com/settings/personal-access-tokens.
