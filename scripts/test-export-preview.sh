#!/usr/bin/env bash
# Regression coverage for the runner's external output path; never uses a real .env/marker.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
sandbox=$(mktemp -d)
trap 'rm -rf -- "$sandbox"' EXIT
unset LANE_MARKER
export PORT=${PORT:-18787}

# A disposable checkout shape: a source copy with installed dependencies and
# read-only run fixtures linked in, but no .env or writes in the actual checkout.
fixture="$sandbox/checkout"
mkdir -p "$fixture/scripts"
cp "$root/scripts/export-preview.sh" "$fixture/scripts/"
for file in node_modules runs; do
  ln -s "$root/$file" "$fixture/$file"
done
cp -R "$root/src" "$fixture/src"
cp "$root/package.json" "$root/tsconfig.json" "$root/rig.json" "$fixture/"

# Also exercise a symlinked checkout path. Both output directories are outside it.
ln -s "$fixture" "$sandbox/checkout-link"
for mode in unmarked marked; do
  if [[ "$mode" == marked ]]; then
    export LANE_MARKER='harmless-export-regression-marker'
  else
    unset LANE_MARKER
  fi
  "$sandbox/checkout-link/scripts/export-preview.sh" "$sandbox/$mode"
  node --input-type=module - "$sandbox/$mode/index.html" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(process.argv[2], 'utf8');
const present = html.includes('harmless-export-regression-marker');
assert.equal(present, Boolean(process.env.LANE_MARKER), 'marker inclusion must follow the environment');
NODE
  [[ ! -e "$fixture/var/heartbeat.json" ]]
  [[ $(find "$sandbox/$mode" -mindepth 1 -maxdepth 1 -printf x) == x ]]
done

# An intentional HTTP 500 must preserve curl's status, show useful diagnostics,
# redact marker variants, and clean up both the server and temporary artifacts.
rm "$fixture/node_modules"
mkdir -p "$fixture/node_modules/.bin"
printf '%s\n' '{"type":"commonjs"}' >"$fixture/node_modules/package.json"
# .bin is under node_modules, so this stub is CommonJS regardless of repo type.
cat >"$fixture/node_modules/.bin/tsx" <<'NODE'
#!/usr/bin/env node
const http = require('node:http');
http.createServer((request, response) => {
  if (request.url === '/health') return response.end('ok');
  console.error(new Error(`intentional export test failure: ${process.env.LANE_MARKER}`));
  console.error(JSON.stringify(process.env.LANE_MARKER));
  console.error(process.env.LANE_MARKER.trim());
  response.writeHead(500).end();
}).listen(Number(process.env.PORT));
NODE
chmod +x "$fixture/node_modules/.bin/tsx"
export LANE_MARKER=$'  export-test-"quoted"\\value\n  '
status=0
"$fixture/scripts/export-preview.sh" "$sandbox/failed" >"$sandbox/failure.log" 2>&1 || status=$?
[[ "$status" == 22 ]]
node --input-type=module - "$sandbox/failure.log" "$fixture/runs" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const log = readFileSync(process.argv[2], 'utf8');
assert.ok(log.includes(`Preview resolved runs path: ${process.argv[3]}; type: directory`));
assert.ok(log.includes('2026-10-28.jsonl; type: file'));
assert.ok(log.includes('intentional export test failure: [REDACTED]'));
assert.ok(!log.includes('export-test-'), 'marker variants must not appear in diagnostics');
NODE
[[ -z $(find "$sandbox/failed" -mindepth 1 -maxdepth 1 -printf x) ]]
# The listener must have been terminated, not merely disconnected from the shell.
node --input-type=module <<'NODE'
import net from 'node:net';
const server = net.createServer();
server.on('error', () => process.exit(1));
server.listen(Number(process.env.PORT), () => server.close());
NODE
printf '%s\n' 'Export regression checks passed (no HTML or marker contents logged).'
