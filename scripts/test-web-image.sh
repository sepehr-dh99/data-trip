#!/usr/bin/env bash
set -euo pipefail
image=${1:?Pass the local image tag}
name="datatrip-web-test-$RANDOM-$$"
directory=$(mktemp -d)
trap 'docker rm -fv "$name" >/dev/null 2>&1 || true; rm -f "$directory/web.yml" "$directory/cookies"; rmdir "$directory"' EXIT
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
address=127.0.0.1:$port
origin=http://$address
hash=$(printf '%s\n' datatrip-image-fixture | docker run --rm -i "$image" hash-password --stdin)
cat > "$directory/web.yml" <<EOF
bind: 0.0.0.0:8080
publicOrigin: $origin
dataDir: /data
assetsDir: /app/dist-web
workspaceKeyEnv: DATATRIP_WEB_WORKSPACE_KEY
auth:
  local:
    users:
      - id: image-smoke
        username: fixture
        passwordHash: '$hash'
databaseEndpoints: []
EOF
chmod 644 "$directory/web.yml"
docker run --detach --name "$name" --read-only --tmpfs /tmp \
  -p "$address:8080" --mount "type=bind,src=$directory/web.yml,dst=/etc/datatrip/web.yml,readonly" \
  -e DATATRIP_WEB_WORKSPACE_KEY="$(openssl rand -hex 32)" "$image"
curl -fsS --retry 30 --retry-connrefused "$origin/livez"
curl -fsS "$origin/readyz"
docker exec "$name" datatrip-web healthcheck
index=$(curl -fsS "$origin/")
grep -q 'DataTrip' <<< "$index"
test "$(docker exec "$name" id -u)" = 10001
asset=$(docker exec "$name" sh -c 'basename /app/dist-web/assets/*.wasm')
headers=$(curl -fsSI "$origin/assets/$asset")
grep -qi '^content-type: application/wasm' <<< "$headers"
grep -qi '^cache-control: .*immutable' <<< "$headers"

sign_in() {
    curl -fsS -c "$directory/cookies" -H "Origin: $origin" -H 'Content-Type: application/json' \
      --data '{"username":"fixture","password":"datatrip-image-fixture"}' "$origin/api/v1/login/local" \
      | python3 -c 'import json, sys; print(json.load(sys.stdin)["binding"])'
}
operation() {
    curl -fsS -b "$directory/cookies" -H "Origin: $origin" -H "X-DataTrip-Session: $binding" \
      -H 'Content-Type: application/json' --data "$2" "$origin/api/v1/operations/$1"
}
binding=$(sign_in)
operation save_settings '{"settings":{"imageFixture":true}}'
file=$(curl -fsS -b "$directory/cookies" -H "Origin: $origin" -H "X-DataTrip-Session: $binding" \
  -H 'Content-Type: application/json' --data '{"name":"image.sqlite","purpose":"sqlite"}' \
  "$origin/api/v1/files/output" | python3 -c 'import json, sys; print(json.load(sys.stdin)["file"])')
operation save_connection "{\"config\":{\"id\":\"fixture\",\"driver\":\"sqlite\",\"name\":\"Fixture\",\"filePath\":\"$file\"}}"
session=$(operation open_session '{"connectionId":"fixture"}' | python3 -c 'import json, sys; print(json.load(sys.stdin)["sessionId"])')
sql() {
    operation execute "$(python3 -c 'import json, sys; print(json.dumps(dict(sessionId=sys.argv[1], sql=sys.argv[2], maxRows=5)))' "$session" "$1")"
}
sql 'CREATE TABLE fixture (id INTEGER PRIMARY KEY)'
sql 'BEGIN'
sql 'INSERT INTO fixture VALUES (1)'
docker stop --timeout 20 "$name"
test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
docker start "$name"
curl -fsS --retry 30 --retry-connrefused "$origin/readyz"
binding=$(sign_in)
test "$(operation get_settings '{}')" = '{"imageFixture":true}'
session=$(operation open_session '{"connectionId":"fixture"}' | python3 -c 'import json, sys; print(json.load(sys.stdin)["sessionId"])')
sql 'SELECT id FROM fixture' | python3 -c 'import json, sys; assert json.load(sys.stdin)["rows"] == []'
docker stop --timeout 20 "$name"
test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
