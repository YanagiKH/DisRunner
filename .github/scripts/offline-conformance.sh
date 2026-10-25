#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" = --inside ]]; then
  shift
  root="$1"
  node_path="$2"
  python_path="$3"
  host_namespace="$4"
  source_sha="$5"
  mode="$6"
  evidence_directory="$7"
  source_dirty="$8"
  current_namespace="$(readlink /proc/self/ns/net)"
  test "$current_namespace" != "$host_namespace"
  ip link set dev lo up
  test "$(ip -o link show | wc -l | tr -d ' ')" = 1
  ip -o link show lo | grep -q '<[^>]*UP[^>]*>'
  test -z "$(ip -4 route show default)"
  test -z "$(ip -6 route show default)"

  export PATH="$(dirname "$node_path"):$(dirname "$python_path"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  export DISRUNNER_TEST_PYTHON="$python_path"
  "$node_path" --input-type=module <<'NODE'
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
const server = createServer((socket) => socket.end());
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const socket = createConnection(server.address().port, '127.0.0.1');
  await once(socket, 'connect');
  socket.destroy();
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
NODE
  if [[ "$mode" = probe ]]; then
    echo 'Private network namespace verified: only the loopback interface is available. Corpus was not executed.'
    exit 0
  fi

  cd "$root"
  test -f packages/runtime/dist/index.js
  test -f packages/runtime/tests/session-exact-response.test.mjs
  test -f tests/conformance/sdk-transports.test.mjs
  test -f tests/conformance/sdk-sessions.test.mjs
  shopt -s nullglob
  corpus=(tests/conformance/*.test.mjs packages/runtime/tests/session-exact-response.test.mjs)
  mkdir -p "$evidence_directory"
  set +e
  "$node_path" --test "${corpus[@]}" 2>&1 | tee "$evidence_directory/results.tap"
  pipeline_status=("${PIPESTATUS[@]}")
  result="${pipeline_status[0]}"
  if [[ "${pipeline_status[1]}" != 0 ]]; then result=1; fi
  set -e
  export DISRUNNER_OFFLINE_EVIDENCE_DIRECTORY="$evidence_directory"
  export DISRUNNER_OFFLINE_SOURCE_SHA="$source_sha"
  export DISRUNNER_OFFLINE_EXIT_CODE="$result"
  export DISRUNNER_OFFLINE_NAMESPACE="$current_namespace"
  export DISRUNNER_OFFLINE_SOURCE_DIRTY="$source_dirty"
  "$node_path" --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const directory = process.env.DISRUNNER_OFFLINE_EVIDENCE_DIRECTORY;
const results = await readFile(path.join(directory, 'results.tap'));
const manifest = async (name) => JSON.parse(await readFile(`packages/${name}/manifest.json`, 'utf8'));
const js = await manifest('adapter-discordjs');
const py = await manifest('adapter-discordpy');
const evidence = {
  schemaVersion: 1,
  sourceSha: process.env.DISRUNNER_OFFLINE_SOURCE_SHA,
  sourceDirty: process.env.DISRUNNER_OFFLINE_SOURCE_DIRTY === 'true',
  isolation: 'linux-network-namespace-loopback-only',
  networkNamespace: process.env.DISRUNNER_OFFLINE_NAMESPACE,
  interfaces: ['lo'],
  defaultRoutes: 0,
  node: process.version,
  python: execFileSync(process.env.DISRUNNER_TEST_PYTHON, ['--version'], { encoding: 'utf8' }).trim(),
  adapters: [
    { id: 'raw-interaction-webhook' },
    { id: js.id, sdkVersion: js.sdkVersion },
    { id: py.id, sdkVersion: py.sdkVersion },
  ],
  corpus: ['tests/conformance/*.test.mjs', 'packages/runtime/tests/session-exact-response.test.mjs'],
  exitCode: Number(process.env.DISRUNNER_OFFLINE_EXIT_CODE),
  resultsSha256: createHash('sha256').update(results).digest('hex'),
  completedAt: new Date().toISOString(),
};
await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
NODE
  exit "$result"
fi

test "$(uname -s)" = Linux || { echo 'Isolated offline conformance requires Linux.' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
node_path="$(node -p process.execPath)"
python_path="${DISRUNNER_TEST_PYTHON:-python3}"
if [[ "$python_path" != /* ]]; then python_path="$(command -v "$python_path")"; fi
test -x "$node_path"
test -x "$python_path"
host_namespace="$(readlink /proc/self/ns/net)"
source_sha="${GITHUB_SHA:-$(git -C "$root" rev-parse HEAD)}"
test "$source_sha" = "$(git -C "$root" rev-parse HEAD)"
source_dirty=false
if [[ -n "$(git -C "$root" status --porcelain)" ]]; then source_dirty=true; fi
mode=corpus
if [[ "${1:-}" = --probe ]]; then mode=probe;
elif [[ -n "${1:-}" ]]; then echo 'Usage: offline-conformance.sh [--probe]' >&2; exit 1; fi
evidence_directory="${OFFLINE_EVIDENCE_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/disrunner-offline-evidence.XXXXXX")}"

# Both launch paths create an isolated kernel network namespace; neither permits a host-network fallback.
if command -v sudo >/dev/null && sudo -n unshare --net --fork true 2>/dev/null; then
  launcher=(sudo -n unshare --net --fork)
elif unshare --user --map-root-user --net --fork true 2>/dev/null; then
  launcher=(unshare --user --map-root-user --net --fork)
elif [[ "$EUID" = 0 ]] && unshare --net --fork true 2>/dev/null; then
  launcher=(unshare --net --fork)
else
  echo 'Cannot create an isolated network namespace. Offline conformance was not executed.' >&2
  exit 1
fi
exec "${launcher[@]}" bash "$root/.github/scripts/offline-conformance.sh" --inside "$root" "$node_path" "$python_path" "$host_namespace" "$source_sha" "$mode" "$evidence_directory" "$source_dirty"
