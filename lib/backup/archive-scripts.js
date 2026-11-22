//! Node 26: Shell scripts for backup archive operations.
function scriptPrelude() {
    const plainPaths = BACKUP_PATHS.filter(path => !EXPANDED_DIRS[path]).join(' ');
    // Expanded folders are added child by child so excluded children never reach tar.
    const expandLines = Object.keys(EXPANDED_DIRS).map(dirPath =>
        '  if [ -d "$R/' + dirPath + '" ]; then for f in "$R/' + dirPath + '"/* "$R/' + dirPath + '"/.[!.]*; do [ -e "$f" ] || continue; '
        + 'case "${f##*/}" in ' + EXPANDED_DIRS[dirPath].join('|') + ') continue;; esac; add "' + dirPath + '/${f##*/}"; done; fi'
    );

    return [
        // R is the filesystem root (empty on the device; a temp folder in tests).
        'R=""',
        'B="$R' + BACKUP_DIR + '"',
        'list_backups() {',
        '  echo "@@USER $(id -un 2>/dev/null)"',
        '  echo "@@DF $(df -Pk "$B" 2>/dev/null | tail -n 1)"',
        '  for f in "$B"/*.tar.gz; do [ -f "$f" ] || continue; printf "@@B\\t%s\\t%s\\t%s\\n" "$(wc -c < "$f")" "$(date -r "$f" "+%Y-%m-%d %H:%M" 2>/dev/null)" "${f##*/}"; done',
        '}',
        'fail() { echo "@@ERROR $*"; list_backups; exit 0; }',
        'create_backup() {',
        '  NAME="$1-$(date +%Y%m%d-%H%M%S).tar.gz"',
        '  mkdir -p "$B" "$R/' + MANIFEST_PATH.replace(/\/[^/]+$/, '') + '" || fail "Cannot create $B"',
        '  L=""',
        '  add() { if [ -e "$R/$1" ]; then if [ -r "$R/$1" ]; then L="$L $1"; else echo "@@SKIPPED $1 (not readable)"; fi; fi; }',
        '  for p in ' + plainPaths + '; do add "$p"; done',
        ...expandLines,
        '  { echo "type=grid-control-backup"; echo "format=1"; echo "created=$(date "+%Y-%m-%d %H:%M:%S %z")"; echo "host=$(hostname)"; echo "venus=$(head -n 1 /opt/victronenergy/version 2>/dev/null)"; echo "user=$(id -un 2>/dev/null)"; for p in $L; do echo "path=$p"; done; } > "$R/' + MANIFEST_PATH + '" || fail "Cannot write manifest"',
        '  case " $L " in *" data/home/nodered/grid-control-config "*) ;; *) L="$L ' + MANIFEST_PATH + '";; esac',
        // GNU tar (Venus OS): skip daemontools runtime folders (`supervise`, root-only) at any depth.
        // BusyBox tar has no --exclude, so the option is only passed to GNU tar.
        '  EX=""; tar --version 2>/dev/null | grep -q GNU && EX="--exclude=supervise --exclude=lost+found"',
        '  tar -czf "$B/$NAME.part" $EX -C "$R/" $L 2>"$B/.tar-errors"',
        '  if tar -tzf "$B/$NAME.part" >/dev/null 2>&1; then mv "$B/$NAME.part" "$B/$NAME"; else rm -f "$B/$NAME.part"; sed "s/^/@@LOG /" "$B/.tar-errors"; fail "Archive could not be created"; fi',
        '  sed "s/^/@@LOG /" "$B/.tar-errors"; rm -f "$B/.tar-errors"',
        '  for p in $L; do echo "@@INCLUDED $p"; done',
        '  CREATED="$NAME"',
        '}'
    ].join('\n');
}

function buildRefreshScript() {
    return scriptPrelude() + '\nlist_backups';
}

function buildCreateScript() {
    return scriptPrelude() + '\ncreate_backup grid-backup\necho "@@CREATED $CREATED"\nlist_backups';
}

// `name` is validated against NAME_PATTERN and the current list before this is called.
function buildDeleteScript(name) {
    return scriptPrelude() + '\n' + [
        '[ -f "$B/' + name + '" ] || fail "Backup not found: ' + name + '"',
        'rm -f "$B/' + name + '" && [ ! -e "$B/' + name + '" ] || fail "Cannot delete ' + name + '"',
        'echo "@@DELETED ' + name + '"',
        'list_backups'
    ].join('\n');
}

function buildRestoreScript(name, restoreVenusSettings, restartNodeRed, enableDrivers) {
    const allowed = BACKUP_PATHS.map(escapeRegex).join('|');
    // Parent folder entries (`data/`, `data/home/`, ...) appear when an archive is repacked by another tool.
    const parents = Array.from(new Set(BACKUP_PATHS.reduce((list, path) => {
        const parts = path.split('/');
        for (let index = 1; index < parts.length; index += 1) {
            list.push(parts.slice(0, index).join('/') + '/');
        }
        return list;
    }, []))).map(escapeRegex).join('|');

    return scriptPrelude() + '\n' + [
        'F="$B/' + name + '"',
        'ST="$B/.restore-staging"',
        '[ -f "$F" ] || fail "Backup not found: ' + name + '"',
        'tar -tzf "$F" > "$B/.restore-list" 2>/dev/null || fail "Not a valid .tar.gz archive"',
        'grep -q "^' + escapeRegex(MANIFEST_PATH) + '$" "$B/.restore-list" || fail "Not a grid-control backup (manifest missing)"',
        'BAD=$(grep -v -E "^(' + allowed + ')(/|$)" "$B/.restore-list" | grep -v -E "^(' + parents + ')$" | head -n 3 | tr "\\n" " ")',
        '[ -z "$BAD" ] || fail "Archive contains unexpected paths: $BAD"',
        'grep -q "\\.\\./" "$B/.restore-list" && fail "Archive contains .. paths"',
        'create_backup pre-restore',
        'echo "@@SAFETY $CREATED"',
        'rm -rf "$ST"; mkdir -p "$ST" || fail "Cannot create staging folder"',
        'tar -xzf "$F" -C "$ST" 2>/dev/null || { rm -rf "$ST"; fail "Extract failed"; }',
        'NR=0',
        'for p in ' + BACKUP_PATHS.join(' ') + '; do',
        '  [ -e "$ST/$p" ] || continue',
        '  if [ "$p" = "' + VENUS_SETTINGS_PATH + '" ] && [ "' + (restoreVenusSettings ? '1' : '0') + '" != "1" ]; then echo "@@SKIP $p (Venus OS settings not selected)"; continue; fi',
        '  D="$R/${p%/*}"',
        '  if mkdir -p "$D" && cp -a "$ST/$p" "$D/"; then echo "@@RESTORED $p"; [ "$p" = "' + NODE_RED_DIR + '" ] && NR=1; else echo "@@FAILED $p"; fi',
        'done',
        // Re-register every restored driver that ships an enable.sh (creates its services / rc.local hooks).
        'if [ "' + (enableDrivers ? '1' : '0') + '" = "1" ]; then',
        '  for e in "$ST/' + DRIVERS_DIR + '"/*/enable.sh; do',
        '    [ -f "$e" ] || continue',
        '    DRV="${e%/enable.sh}"; DRV="${DRV##*/}"',
        '    if [ -f "$R/' + DRIVERS_DIR + '/$DRV/enable.sh" ] && bash "$R/' + DRIVERS_DIR + '/$DRV/enable.sh" > "$B/.enable-$DRV.log" 2>&1; then echo "@@DRIVER $DRV"; else echo "@@FAILED ' + DRIVERS_DIR + '/$DRV/enable.sh"; fi',
        '    tail -n 5 "$B/.enable-$DRV.log" 2>/dev/null | sed "s/^/@@LOG [$DRV] /"; rm -f "$B/.enable-$DRV.log"',
        '  done',
        'fi',
        'rm -rf "$ST" "$B/.restore-list"',
        'if [ "$NR" = "1" ] && [ "' + (restartNodeRed ? '1' : '0') + '" = "1" ]; then ( sleep 5; for s in /service/node-red*; do svc -t "$s"; done ) >/dev/null 2>&1 & echo "@@RESTART Node-RED restarts in 5 s"; fi',
        'echo "@@DONE ' + name + '"',
        'list_backups'
    ].join('\n');
}
