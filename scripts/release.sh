#!/usr/bin/env bash
# 把 CI 产物发布成 GitHub Release。
#
#   GITHUB_TOKEN=xxx bash scripts/release.sh v0.1.0
#
# 需要 token（SSH key 能推代码，但建 release / 下载 artifact 必须走 API）。
# token 不要写进仓库、不要贴进聊天：用环境变量传入，脚本不会回显它。
set -euo pipefail

TAG="${1:?usage: GITHUB_TOKEN=<pat> bash scripts/release.sh v0.1.0}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set}"

REPO="create-info/unit-harness"
API="https://api.github.com/repos/${REPO}"
AUTH="Authorization: Bearer ${GITHUB_TOKEN}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

json_get() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

echo "→ locating the latest successful CI run"
RUN_ID=$(curl -sf -H "$AUTH" "${API}/actions/runs?per_page=10&status=success" \
  | json_get "next(r['id'] for r in d['workflow_runs'] if r['head_branch']=='main')")
echo "  run ${RUN_ID}"

echo "→ downloading artifacts"
curl -sf -H "$AUTH" "${API}/actions/runs/${RUN_ID}/artifacts" -o "${WORK}/artifacts.json"
mapfile -t ARTIFACT_IDS < <(json_get "[a['id'] for a in d['artifacts']]" < "${WORK}/artifacts.json" | tr -d '[],' | tr ' ' '\n' | grep -E '^[0-9]+$')

mkdir -p "${WORK}/files"
for id in "${ARTIFACT_IDS[@]}"; do
  echo "  artifact ${id}"
  curl -sfL -H "$AUTH" "${API}/artifacts/${id}/zip" -o "${WORK}/${id}.zip"
  unzip -qo "${WORK}/${id}.zip" -d "${WORK}/unpacked" || true
done

# 只留真正要发的东西：安装包 + CLI 二进制 + 校验和
find "${WORK}/unpacked" -type f \( \
    -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.msi' -o -name '*.exe' -o \
    -name 'uh-linux-*' -o -name 'uh-darwin-*' -o -name 'uh-win32-*' -o -name '*.sha256' \) \
  -exec cp -n {} "${WORK}/files/" \;

COUNT=$(ls -1 "${WORK}/files" | wc -l)
echo "→ collected ${COUNT} files"
ls -la "${WORK}/files"
[ "$COUNT" -ge 1 ] || { echo "no files to publish"; exit 1; }

echo "→ creating release ${TAG}"
BODY=$(cat <<'MD'
Local agent harness: every deliverable is executed and verified in a sandbox, and
every run is replayable.

**CLI** — single static binary, no Node required:
```bash
curl -fsSL https://raw.githubusercontent.com/create-info/unit-harness/main/install.sh | bash
```

**Desktop** — download the installer for your platform. The builds are unsigned:
on macOS use right-click → Open the first time; on Windows expect a SmartScreen
prompt. Linux: `sudo dpkg -i *.deb`, or `chmod +x *.AppImage && ./UnitHarness*.AppImage`.
MD
)

PAYLOAD=$(TAG="$TAG" BODY="$BODY" python3 -c '
import json, os
print(json.dumps({
  "tag_name": os.environ["TAG"],
  "name": os.environ["TAG"],
  "body": os.environ["BODY"],
  "draft": False,
  "prerelease": False,
}))')

RELEASE_ID=$(curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "$PAYLOAD" "${API}/releases" | json_get "d['id']")
echo "  release ${RELEASE_ID}"

for f in "${WORK}/files"/*; do
  name=$(basename "$f")
  echo "→ uploading ${name}"
  curl -sf -X POST \
    -H "$AUTH" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    "https://uploads.github.com/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${name}" > /dev/null
done

echo ""
echo "done: https://github.com/${REPO}/releases/tag/${TAG}"
