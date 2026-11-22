//! Node 29: Shell sampler and command quoting.
const SCRIPT = [
    'echo "@@HOST $(hostname 2>/dev/null)"',
    'echo "@@USER $(id -un 2>/dev/null)"',
    'echo "@@KERNEL $(uname -r 2>/dev/null)"',
    'echo "@@MODEL $(tr -d "\\000" 2>/dev/null < /proc/device-tree/model)"',
    'echo "@@VENUS $(head -n 2 /opt/victronenergy/version 2>/dev/null | tr "\\n" " ")"',
    'echo "@@DATE $(date "+%Y-%m-%d %H:%M:%S %Z")"',
    'echo "@@UPTIME $(cat /proc/uptime)"',
    'echo "@@LOAD $(cat /proc/loadavg)"',
    'echo "@@NCPU $(grep -c "^processor" /proc/cpuinfo)"',
    'echo "@@CPUMODEL $(grep -m 1 -i -E "^(model name|hardware|cpu model)" /proc/cpuinfo | cut -d: -f2-)"',
    'for t in /sys/class/thermal/thermal_zone*/temp; do [ -r "$t" ] && echo "@@TEMP ${t%/temp} $(cat "$t")"; done',
    'grep -E "^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):" /proc/meminfo | sed "s/^/@@MEM /"',
    'df -Pk 2>/dev/null | sed "1d; s/^/@@DF /"',
    'ip -o -4 addr show 2>/dev/null | sed "s/^/@@IP /"',
    'sample() {',
    '  echo "@@SAMPLE $1"',
    '  head -n 1 /proc/stat | sed "s/^/@@CPU /"',
    '  sed "1,2d; s/^/@@NET /" /proc/net/dev 2>/dev/null',
    '  for d in /proc/[0-9]*; do read -r st 2>/dev/null < "$d/stat" && echo "@@P $st"; done',
    '}',
    'sample 1',
    'sleep 1',
    'sample 2',
    // Full command line + owner straight from /proc: `comm` is cut to 15 chars (e.g. "dbus-serialbatt")
    // and BusyBox `ps` has no -e and truncates args, so it cannot be relied on.
    'cut -d: -f1,3 /etc/passwd 2>/dev/null | sed "s/^/@@PASSWD /"',
    'for d in /proc/[0-9]*; do',
    '  u=""; while read -r k v rest; do [ "$k" = "Uid:" ] && { u=$v; break; }; done 2>/dev/null < "$d/status"',
    '  printf "@@ARGS %s %s " "${d#/proc/}" "${u:--}"; tr "\\000" " " 2>/dev/null < "$d/cmdline"; echo',
    'done',
    'sed "1d; s/^/@@TCP /" /proc/net/tcp 2>/dev/null',
    'sed "1d; s/^/@@TCP6 /" /proc/net/tcp6 2>/dev/null',
    'true'
].join('\n');

function shellQuote(script) {
    return "'" + String(script).replace(/'/g, "'\\''") + "'";
}
