# Omarchy loop token

## Create

1. In GitHub, open **Settings → Developer settings → Personal access tokens
   → Fine-grained tokens → Generate new token**.
2. Name it `victron-dev-loop-YYYYMMDD`, set a 90-day expiration, and choose
   `vzakusylo` as resource owner. Under repository access, choose **Only select
   repositories** and select **victron** only. The link printed by the rotation
   script prefills supported fields; always verify the repository selection.
3. Under **Repository permissions**, set:

   | Permission | Access | Why |
   |---|---|---|
   | Contents | Read and write | Read the repository and push feature branches |
   | Pull requests | Read and write | Read PRs and manage PR state |
   | Actions | Read | Read Test GX and deployment runs and jobs |
   | Workflows | Read and write | Push changes that include workflow files |
   | Metadata | Read (automatic) | Identify and read basic repository metadata |

4. Generate the token and paste it at the script's hidden prompt. Do not pass
   it in an argument or send it in chat.

## Use

The Omarchy account running the loop stores the token at `~/victron-loop/token`
with mode 600. The loop gives it to `gh` through `GH_TOKEN`; the dashboard reads
it to redact it from logs and shows only status and rotation metadata. Do not
commit the token or store it in GitHub Actions. If the file is absent or empty,
the loop stops instead of using the account's broader `gh` login. Leave
`allow_gh_login_fallback = false` unless you deliberately want that behavior.

## Maintain

Rotate every 90 days, or earlier when the dashboard or a notification warns that
the token expires in 14 or 3 days. From the PC:

```bash
scp tools/dev-loop/rotate-token.sh omarchy:~/
ssh -t omarchy 'bash ~/rotate-token.sh'
```

The script validates repository, PR, and Actions reads before replacing the
token. It keeps one previous token in `~/victron-loop/token.prev` (mode 600),
records the dates in `token.meta`, restarts the running page, and runs an
installed loop once in dry-run mode. Use `bash ~/rotate-token.sh --check` on
Omarchy to validate the current token or `bash ~/rotate-token.sh --rollback`
to restore the previous token if it still works. After verifying the new
token, revoke the previous one in **GitHub Settings → Fine-grained tokens**.

If a token leaks, **revoke it immediately** in GitHub, run `rotate-token.sh`
with a new token, and review the GitHub security/audit log and the repository's
recent PR and workflow activity for unexpected actions.

## Troubleshooting

| Symptom | Action |
|---|---|
| `token-invalid` / HTTP 401 | The token may have expired or been revoked. Validate it with `--check`, then rotate it. The loop will not retry with another login. |
| HTTP 403 | Check the selected repository, the permission for the failing endpoint, and any pending approval for the token. Rotate with the correct scope if needed. |
| `token-missing` | Run the rotation script on Omarchy, and verify that the loop's `token_file` points to `~/victron-loop/token` and that the service account can read it. |
