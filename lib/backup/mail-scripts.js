//! Node 26: Shell scripts for packing and mailing data.
function datedMailPacking(dayList, osloDays, name, period) {
    return [
        'CORE="$L"; OPT=""; LEFT_OUT=""',
        'AIR=""; TEMP=""; EVENTS=""; CATALOG=""',
        'for d in ' + dayList.join(' ') + '; do',
        '  f="$G/air/$d.csv"; [ ! -f "$f" ] || AIR="$AIR $f"',
        '  f="$G/sensor-events/$d.jsonl"; [ ! -f "$f" ] || EVENTS="$EVENTS $f"',
        'done',
        'for d in ' + osloDays.join(' ') + '; do',
        '  f="$G/temperatures/$d.jsonl"; [ ! -f "$f" ] || TEMP="$TEMP $f"',
        'done',
        '[ ! -f "$G/temperatures/catalog.json" ] || CATALOG="$G/temperatures/catalog.json"',
        '[ -n "$CORE$AIR$TEMP$EVENTS$CATALOG" ] || fail "No data files found for ' + period + '"',
        'pack() {',
        '  # Accept the recorder changing a file during packing, as long as tar is readable.',
        '  tar -czf "$T" "$@" 2>/dev/null; tar -tzf "$T" >/dev/null 2>&1 || fail "Data archive could not be created"',
        '  SZ=$(wc -c < "$T") || fail "Could not read the data archive size"',
        '}',
        'fits() { [ "$SZ" -le ' + MAIL_MAX_BYTES + ' ]; }',
        'if [ -n "$CORE" ]; then',
        '  pack $CORE',
        '  fits || fail "Core data alone is too large for e-mail: $SZ bytes (max 18 MiB). Use a shorter period or download a full backup."',
        'fi',
        'OPT="$EVENTS $TEMP $CATALOG $AIR"',
        'pack_selected() {',
        '  set -- $CORE $OPT',
        '  [ "$#" -gt 0 ] || fail "No data files fit the 18 MiB e-mail limit"',
        '  pack "$@"',
        '}',
        'if [ -n "$EVENTS$TEMP$CATALOG$AIR" ]; then pack_selected; fi',
        // Use compressed sizes to pick a batch; only the full archive can prove it fits.
        'largest_first() {',
        '  for f do printf "%s %s\\n" "$(wc -c < "$f")" "$f"; done | LC_ALL=C sort -k1,1nr -k2,2 | awk \'{print $2}\'',
        '}',
        'omit() {',
        '  KEPT=""; for p in $OPT; do [ "$p" = "$1" ] || KEPT="$KEPT $p"; done; OPT="$KEPT"',
        '  LEFT_OUT="$LEFT_OUT ${1#"$G/"}"',
        '}',
        'omit_optional() {',
        '  f="$1"',
        '    omit "$f"',
        '    case "$f" in "$G"/temperatures/*.jsonl)',
        '      # Keep the shared catalogue only while at least one selected temperature day remains.',
        '      case "$OPT" in *" $G/temperatures/"*.jsonl*) ;; *) [ -z "$CATALOG" ] || omit "$CATALOG";; esac ;;',
        '    esac',
        '}',
        'drop_until_fits() {',
        '  if fits || [ "$#" -eq 0 ]; then return; fi',
        '  set -- $(largest_first "$@")',
        '  NEED=$((SZ - ' + MAIL_MAX_BYTES + '))',
        '  while [ "$#" -gt 0 ] && [ "$NEED" -gt 0 ]; do',
        '    EST=$(gzip -c "$1" | wc -c)',
        '    NEED=$((NEED - EST))',
        '    omit_optional "$1"',
        '    shift',
        '  done',
        '  pack_selected',
        '  if fits || [ "$#" -eq 0 ]; then return; fi',
        // the estimate came up short: drop one more file at a time (at most ' + DROP_RETRIES + ' repacks), then the rest
        '  TRY=0',
        '  while [ "$#" -gt 0 ] && [ "$TRY" -lt ' + DROP_RETRIES + ' ]; do',
        '    omit_optional "$1"; shift; TRY=$((TRY + 1))',
        '    pack_selected',
        '    if fits; then return; fi',
        '  done',
        '  for item do omit_optional "$item"; done',
        '  [ "$#" -eq 0 ] || pack_selected',
        '}',
        'drop_until_fits $EVENTS',
        'drop_until_fits ${TEMP:-$CATALOG}',
        'drop_until_fits $AIR'
    ];
}

// Packs the dated logs (0 = all of grid-control-logs) and mails them.
function buildMailScript(days, auto, nowTs) {
    const dayList = [];
    const months = [];
    for (let k = days; days > 0 && k >= 0; k -= 1) {
        const d = new Date(nowTs - k * 24 * 3600 * 1000).toISOString();
        dayList.push(d.slice(0, 10));
        if (months.indexOf(d.slice(0, 7)) < 0) {
            months.push(d.slice(0, 7));
        }
    }
    const stamp = new Date(nowTs).toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
    const period = days > 0 ? dayList[0] + ' … ' + dayList[dayList.length - 1] + ' (UTC days)' : 'all history';
    const name = 'grid-data-' + stamp + (days > 0 ? '-' + days + 'd' : '-all') + '.tar.gz';
    const mail = {
        subject: 'Cerbo GX data archive: ' + (days > 0 ? 'last ' + days + ' days' : 'all history') + ' (' + zoneText(nowTs).slice(4, 14) + ')',
        text: [
            (auto ? 'Weekly' : 'Requested') + ' archive of the energy and heating data of the Cerbo GX.',
            'Period: ' + period + '.',
            '',
            'Contents (grid-control-logs/):',
            '- energy-YYYY-MM.csv: energy history per hour (grid, battery, PV, tariff tier)',
            '- heatpump/YYYY-MM-DD/HH.csv(.gz): heat pump recorder, values per change',
            '- automations/YYYY-MM-DD.jsonl: automation log (heat pump rules, DHW controller, errors)',
            '- grid-control-YYYY-MM-DD.log, heatpump-YYYY-MM-DD.log, energy-YYYY-MM-DD.log: daily logs where present',
            ...(days > 0 ? [
                '- air/YYYY-MM-DD.csv: air readings (same UTC dates as the core logs)',
                '- temperatures/YYYY-MM-DD.jsonl and temperatures/catalog.json: sensor readings and catalogue (Europe/Oslo dates)',
                '- sensor-events/YYYY-MM-DD.jsonl: sensor events (same UTC dates as the core logs)'
            ] : []),
            '',
            'This is a data copy only. A full device backup (settings, flows, drivers) is made on the Backup tab.'
        ].join('\n')
    };
    const lines = [
        'G="grid-control-logs"',
        'cd "' + LOGS_PARENT + '" || fail "Cannot open ' + LOGS_PARENT + '"',
        '[ -d "$G" ] || fail "No data files found for ' + period + '"',
        // Only sweep shared temp paths while holding the archive lock.
        'if command -v flock >/dev/null 2>&1; then',
        '  exec 9<"$G" || fail "Cannot open the data archive lock"',
        '  flock -n -x 9 || fail "Another data archive mail is running; try again when it has finished"',
        '  rm -f /tmp/grid-data-*.tar.gz /tmp/grid-data-mail.json || fail "Cannot clean up old mail files"',
        '  for D in /tmp/grid-data-mail.*; do',
        '    [ -d "$D" ] && [ ! -L "$D" ] || continue',
        '    rm -f "$D"/grid-data-*.tar.gz "$D/mail.json" || fail "Cannot clean up old mail staging files"',
        '    rmdir "$D" 2>/dev/null || :',
        '  done',
        'else',
        '  echo "@@LOG flock unavailable; skipping stale mail sweep"',
        'fi',
        'W=$(mktemp -d /tmp/grid-data-mail.XXXXXX) || fail "Cannot create mail staging directory"',
        'T="$W/' + name + '"; M="$W/mail.json"',
        'trap \'rm -f "$T" "$M"; rmdir "$W"\' EXIT',
        // a stop or the exec timeout still tells the dashboard why, and the EXIT trap removes the staging files
        'trap \'echo "@@ERROR Data archive interrupted (stopped or timed out)"; exit 1\' HUP INT TERM',
        'L=""',
        'addm() { [ -e "$1" ] && L="$L $1"; return 0; }'
    ];
    if (days > 0) {
        const oslo = zoneParts(nowTs);
        const osloDays = dayList.map((_, i) => new Date(Date.UTC(oslo.y, oslo.mo, oslo.d - days + i)).toISOString().slice(0, 10));
        lines.push('for d in ' + dayList.join(' ') + '; do addm "$G/heatpump/$d"; addm "$G/automations/$d.jsonl"; addm "$G/energy-$d.log"; addm "$G/grid-control-$d.log"; addm "$G/heatpump-$d.log"; done');
        lines.push('for m in ' + months.join(' ') + '; do addm "$G/energy-$m.csv"; done');
        lines.push(...datedMailPacking(dayList, osloDays, name, period),
            'fits || fail "Data archive still exceeds the 18 MiB e-mail limit"');
    }
    else {
        lines.push(
            'addm "$G"',
            '[ -n "$L" ] || fail "No data files found for ' + period + '"',
            // The recorder may append to the current hour while tar reads it.
            'tar -czf "$T" $L 2>/dev/null; tar -tzf "$T" >/dev/null 2>&1 || { rm -f "$T"; fail "Data archive could not be created"; }',
            'SZ=$(wc -c < "$T")'
        );
    }
    lines.push('echo "@@MAILSIZE $SZ"; echo "@@MAILFILES $(tar -tzf "$T" | grep -c -v /$)"');
    if (days === 0) {
        lines.push('[ "$SZ" -le ' + MAIL_MAX_BYTES + ' ] || { rm -f "$T"; fail "Data archive is too large for e-mail: $SZ bytes. Use a shorter period or the Download of a full backup."; }');
    }
    if (days > 0) {
        // The text field is last. Omitted paths consist only of fixed set names and ISO dates.
        lines.push(
            '{',
            '  printf \'%s\' ' + shellQuote(JSON.stringify(mail).slice(0, -2)),
            '  if [ -n "$LEFT_OUT" ]; then',
            '    printf \'%s\' \'\\n\\nLeft out to fit the 18 MiB e-mail limit (set/file):\'',
            '    for f in $LEFT_OUT; do printf \'%s%s\' \'\\n- \' "$f"; done',
            '  fi',
            '  printf \'"}\\n\'',
            '} > "$M" || fail "Cannot write data archive mail"'
        );
    }
    else {
        lines.push("cat > \"$M\" <<'GRID_MAIL_EOF'", JSON.stringify(mail), 'GRID_MAIL_EOF');
    }
    lines.push(
        'R=$(node ' + MAIL_TOOL + ' --file "$M" --attach "$T" 2>&1 | tail -n 1)',
        'rm -f "$T" "$M"',
        'echo "@@MAIL $R"',
        'echo "@@MAILNAME ' + name + '"',
        'list_backups'
    );
    return scriptPrelude() + '\n' + lines.join('\n');
}
