'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installer = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install-gx-secrets.sh'), 'utf8');
const fixture = `
set -eu
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
export VICTRON_HOME="$ROOT/gx"
mkdir -p "$ROOT/bin" "$VICTRON_HOME/.node-red" "$VICTRON_HOME/grid-control-config" "$VICTRON_HOME/tools" "$ROOT/bundle/secrets" "$ROOT/bundle/tools"
export PATH="$ROOT/bin:$PATH"
cat > "$ROOT/bin/id" <<'MOCK'
#!/bin/sh
echo 0
MOCK
cat > "$ROOT/bin/svstat" <<'MOCK'
#!/bin/sh
echo "service: \${MOCK_STATE:-down} 1 seconds"
MOCK
# The GX has no install(1); the installer must not depend on it.
cat > "$ROOT/bin/install" <<'MOCK'
#!/bin/sh
exit 127
MOCK
cat > "$ROOT/bin/chown" <<'MOCK'
#!/bin/sh
if [ -n "\${FAIL_INSTALL:-}" ] && [ "$(basename "$2")" = "$FAIL_INSTALL" ]; then exit 1; fi
MOCK
cat > "$ROOT/bin/node" <<'MOCK'
#!/bin/sh
exit \${FAIL_VALIDATION:-0}
MOCK
chmod +x "$ROOT/bin/"*
cat > "$ROOT/install.sh" <<'INSTALLER'
${installer}
INSTALLER
CONFIG_FILES="tuya-cloud.json tuya-devices.json tuya-local-sensors.json tuya-nodes.json email.json mcp-token.txt"
for f in $CONFIG_FILES; do
  printf 'old-%s' "$f" > "$VICTRON_HOME/grid-control-config/$f"
  printf 'new-%s' "$f" > "$ROOT/bundle/secrets/$f"
done
printf old-settings > "$VICTRON_HOME/.node-red/settings-user.js"
printf new-settings > "$ROOT/bundle/secrets/settings-user.js"
for f in victron-secrets.js reload-victron-secrets.js; do
  printf 'old-%s' "$f" > "$VICTRON_HOME/tools/$f"
  printf 'new-%s' "$f" > "$ROOT/bundle/tools/$f"
done
for f in flows_cred.json .config.runtime.json .config.users.json; do
  printf preserved > "$VICTRON_HOME/.node-red/$f"
done
make_archive() { tar -C "$ROOT/bundle" -cf "$ROOT/archive.tar" secrets tools; }
unchanged() {
  for f in $CONFIG_FILES; do
    test "$(cat "$VICTRON_HOME/grid-control-config/$f")" = "old-$f"
  done
  test "$(cat "$VICTRON_HOME/.node-red/settings-user.js")" = old-settings
  test "$(cat "$VICTRON_HOME/tools/victron-secrets.js")" = old-victron-secrets.js
}
make_archive
`;

function runFixture(body) {
    const command = process.platform === 'win32' ? 'wsl.exe' : 'sh';
    const args = process.platform === 'win32' ? ['-e', 'sh', '-s'] : ['-s'];
    const result = spawnSync(command, args, { input: fixture + body, encoding: 'utf8', timeout: 30000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('GX secret installer refuses a running service without writing files', () => {
    runFixture(`
export MOCK_STATE=up
if sh "$ROOT/install.sh" < "$ROOT/archive.tar" > "$ROOT/log" 2>&1; then exit 1; fi
grep -q "Stop Node-RED" "$ROOT/log"
unchanged
test -z "$(find "$VICTRON_HOME/.node-red" -type d -name 'backup-pre-secret-deploy-*')"
`);
});

test('GX secret installer installs active files but preserves recovery credentials', () => {
    runFixture(`
sh "$ROOT/install.sh" < "$ROOT/archive.tar" > "$ROOT/log" 2>&1
for f in $CONFIG_FILES; do
  test "$(cat "$VICTRON_HOME/grid-control-config/$f")" = "new-$f"
done
test "$(cat "$VICTRON_HOME/.node-red/settings-user.js")" = new-settings
for f in flows_cred.json .config.runtime.json .config.users.json; do
  test "$(cat "$VICTRON_HOME/.node-red/$f")" = preserved
done
grep -q "Node-RED remains stopped" "$ROOT/log"
test -z "$(find "$VICTRON_HOME" -type d -name '.secrets-stage.*')"
`);
});

test('GX secret installer replaces a symlinked destination instead of writing through it', () => {
    runFixture(`
printf outside > "$ROOT/outside"
rm "$VICTRON_HOME/grid-control-config/email.json"
ln -s "$ROOT/outside" "$VICTRON_HOME/grid-control-config/email.json"
sh "$ROOT/install.sh" < "$ROOT/archive.tar" > "$ROOT/log" 2>&1
test "$(cat "$ROOT/outside")" = outside
test ! -L "$VICTRON_HOME/grid-control-config/email.json"
test "$(cat "$VICTRON_HOME/grid-control-config/email.json")" = new-email.json
`);
});

test('GX secret installer rollback does not write through a symlinked destination', () => {
    runFixture(`
printf outside > "$ROOT/outside"
rm "$VICTRON_HOME/grid-control-config/mcp-token.txt"
ln -s "$ROOT/outside" "$VICTRON_HOME/grid-control-config/mcp-token.txt"
export FAIL_INSTALL=email.json
if sh "$ROOT/install.sh" < "$ROOT/archive.tar" > "$ROOT/log" 2>&1; then exit 1; fi
test "$(cat "$ROOT/outside")" = outside
test ! -L "$VICTRON_HOME/grid-control-config/mcp-token.txt"
grep -q "restoring previous files" "$ROOT/log"
`);
});

test('GX secret installer rejects unexpected archive files', () => {
    runFixture(`
printf unexpected > "$ROOT/bundle/secrets/flows_cred.json"
make_archive
if sh "$ROOT/install.sh" < "$ROOT/archive.tar" > "$ROOT/log" 2>&1; then exit 1; fi
grep -q "exactly the expected files" "$ROOT/log"
unchanged
`);
});

test('GX secret installer rejects symlinks before extraction', () => {
    runFixture(`
rm "$ROOT/bundle/secrets/email.json"
ln -s "$ROOT/outside" "$ROOT/bundle/secrets/email.json"
make_archive
if sh "$ROOT/install.sh" < "$ROOT/archive.tar" > "$ROOT/log" 2>&1; then exit 1; fi
grep -q "only regular files" "$ROOT/log"
unchanged
test ! -e "$ROOT/outside"
`);
});

test('GX secret installer restores prior files after a copy failure', () => {
    runFixture(`
export FAIL_INSTALL=email.json
if sh "$ROOT/install.sh" < "$ROOT/archive.tar" > "$ROOT/log" 2>&1; then exit 1; fi
grep -q "restoring previous files" "$ROOT/log"
unchanged
test "$(cat "$VICTRON_HOME/tools/reload-victron-secrets.js")" = old-reload-victron-secrets.js
`);
});

test('GX secret installer rolls back validation failure and removes newly created files', () => {
    runFixture(`
rm "$VICTRON_HOME/tools/reload-victron-secrets.js"
export FAIL_VALIDATION=1
if sh "$ROOT/install.sh" < "$ROOT/archive.tar" > "$ROOT/log" 2>&1; then exit 1; fi
grep -q "restoring previous files" "$ROOT/log"
unchanged
test ! -e "$VICTRON_HOME/tools/reload-victron-secrets.js"
test -z "$(find "$VICTRON_HOME" -type d -name '.secrets-stage.*')"
`);
});
