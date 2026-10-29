#!/usr/bin/env bash
# Export the real server response without loading .env. Requires Linux setsid, curl, Node, installed tsx.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
root=$(pwd -P)
output=${1:-var/preview}
if (( $# > 1 )); then
  echo 'usage: scripts/export-preview.sh [output-directory]' >&2
  exit 1
fi
mkdir -p -- "$output"
output=$(cd "$output" && pwd -P)
work=$(mktemp -d "$output/.export.XXXXXX")
server_pid=
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$server_pid" ]]; then
    # tsx spawns children: terminate the entire isolated process group.
    kill -TERM -- "-$server_pid" 2>/dev/null || true
    sleep 0.2
    kill -KILL -- "-$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if (( status != 0 )); then
    # Never dump the environment, run logs, or HTML. Redact the inherited marker
    # before printing server errors, including its trimmed/JSON-escaped forms.
    node --input-type=module - "$work" <<'NODE' >&2 || true
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
const work = process.argv[2];
const marker = process.env.LANE_MARKER ?? '';
const secrets = [...new Set([marker, marker.trim()].filter(Boolean)
  .flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))]
  .sort((a, b) => b.length - a.length);
const redact = text => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
const report = text => console.error(redact(text));
const type = path => {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
  } catch (error) {
    return `unavailable (${error.code ?? 'unknown error'})`;
  }
};
report(`Preview config: ${resolve(work, 'rig.json')}`);
try {
  const config = JSON.parse(readFileSync(resolve(work, 'rig.json'), 'utf8'));
  const runs = resolve(work, config.runsDir);
  report(`Preview resolved runs path: ${runs}; type: ${type(runs)}`);
  const night = resolve(runs, '2026-10-28.jsonl');
  report(`Preview night path: ${night}; type: ${type(night)}`);
} catch (error) {
  report(`Preview config unavailable (${error.code ?? error.name})`);
}
try {
  report('Preview server log (marker redacted):');
  // Redact before truncating so a boundary cannot expose part of the marker.
  console.error(redact(readFileSync(resolve(work, 'server.log'), 'utf8')).slice(-16000));
} catch (error) {
  report(`Preview server log unavailable (${error.code ?? error.name})`);
}
NODE
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export PORT=${PORT:-8787}
# Refuse an occupied port rather than accidentally exporting another server's response.
node --input-type=module <<'NODE'
import net from 'node:net';
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}
const server = net.createServer();
server.on('error', () => { console.error('Preview port unavailable'); process.exit(1); });
server.listen(port, () => server.close());
NODE

# Isolate the real server's heartbeat under the output directory too. The source and
# read-only runs remain in the checkout; only the temporary config uses absolute paths.
node --input-type=module - "$root" "$work" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [root, work] = process.argv.slice(2);
const config = JSON.parse(readFileSync(resolve(root, 'rig.json'), 'utf8'));
config.runsDir = resolve(root, config.runsDir);
writeFileSync(resolve(work, 'rig.json'), JSON.stringify(config));
NODE

# Outside the checkout (RUNNER_TEMP in Actions), tsx cannot discover tsconfig.json
# from cwd. Without it, JSX uses React instead of Hono and /health still passes
# while /digest fails with HTTP 500. Pin both paths and avoid pnpm's cwd/install
# behavior. Only config/heartbeat are relative to work; never load .env.
cd "$work"
setsid "$root/node_modules/.bin/tsx" --tsconfig "$root/tsconfig.json" \
  "$root/src/server.ts" >server.log 2>&1 &
server_pid=$!
cd "$root"
ready=false
for (( attempt=0; attempt<50; attempt++ )); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo 'Preview server exited before becoming ready' >&2
    exit 1
  fi
  if curl --fail --silent --max-time 1 --noproxy '*' "http://localhost:$PORT/health" >/dev/null; then
    ready=true
    break
  fi
  sleep 0.2
done
if [[ "$ready" != true ]]; then
  echo 'Preview server did not become healthy in time' >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 10 --noproxy '*' \
  "http://localhost:$PORT/digest/2026-10-28" >"$work/index.html"

# Fail closed if the page ever gains scripts or non-inline dependencies. Never print its contents.
node --input-type=module - "$work/index.html" <<'NODE'
import { readFileSync } from 'node:fs';
const html = readFileSync(process.argv[2], 'utf8');
const allowedTags = new Set([
  'html', 'head', 'meta', 'title', 'style', 'body', 'header', 'strong', 'span',
  'main', 'h1', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);
const tags = [...html.matchAll(/<\/?([a-z][\w:-]*)\b([^>]*)>/gi)];
const invalid = !/^<!doctype html>/i.test(html) || !/<\/html>\s*$/i.test(html)
  || !/<style>[\s\S]+<\/style>/i.test(html)
  || tags.some(([, name, attrs]) => !allowedTags.has(name.toLowerCase())
    || /\b(?:on[\w-]+|src|srcset|href|http-equiv|style)\s*=/i.test(attrs))
  || /@import\b|url\s*\(/i.test(html);
if (invalid) {
  console.error('Preview must be one self-contained HTML document without scripts or external assets');
  process.exit(1);
}
NODE
mv -- "$work/index.html" "$output/index.html"
echo 'Preview exported and validated (HTML contents not logged).'
