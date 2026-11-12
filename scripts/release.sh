#!/usr/bin/env bash
#
# 把 CI 产物发布成 GitHub Release。
#
#   GITHUB_TOKEN=<pat> bash scripts/release.sh v0.1.0
#   bash scripts/release.sh v0.1.0 --dry-run     # 不联网，只验证收集与校验和
#
# token 不写进仓库、不贴聊天：走环境变量，脚本不回显。
# 需要 fine-grained PAT，权限 Contents: Read and write（Actions: Read 用于拉 artifact）。
#
set -euo pipefail

REPO="create-info/unit-harness"
API="https://api.github.com/repos/${REPO}"

TAG=""
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -*) echo "unknown flag: ${arg}" >&2; exit 2 ;;
    *) TAG="$arg" ;;
  esac
done

[ -n "$TAG" ] || { echo "usage: GITHUB_TOKEN=<pat> bash scripts/release.sh v0.1.0 [--dry-run]" >&2; exit 2; }
if [ "$DRY" = 0 ] && [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN is not set (SSH keys can push commits, but releases need the API)" >&2
  exit 2
fi

# 间接引用：token 名不要和 header 挤在同一处字面量里。
# 上一版这行落盘成了 "Bearer ***"，脚本一跑就是 401，而且看起来一切正常。
TOKEN="${GITHUB_TOKEN:-}"
AUTH_HEADER="Authorization: Bearer ${TOKEN}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILES="${WORK}/files"
mkdir -p "$FILES"

json() { python3 -c "$1"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

api() { # api <method> <url> [json-body]
  local method="$1" url="$2" data="${3:-}"
  if [ -n "$data" ]; then
    curl -sS -X "$method" -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" -d "$data" "$url"
  else
    curl -sS -X "$method" -H "$AUTH_HEADER" -H "Accept: application/vnd.github+json" "$url"
  fi
}

# ---------------------------------------------------------------- 收集产物
if [ "$DRY" = 1 ]; then
  echo "→ dry run: placeholders instead of downloading artifacts"
  for n in uh-linux-x64 uh-linux-arm64 uh-darwin-x64 uh-darwin-arm64 uh-win32-x64.exe; do
    printf 'placeholder %s\n' "$n" > "${FILES}/${n}"
  done
  for n in UnitHarness_0.1.0_amd64.deb UnitHarness_0.1.0_amd64.AppImage \
           UnitHarness_0.1.0_aarch64.dmg UnitHarness_0.1.0_x64-setup.exe; do
    printf 'placeholder %s\n' "$n" > "${FILES}/${n}"
  done
else
  echo "→ picking the run with the most complete artifacts"
  RUN_ID=$(python3 "$(dirname "$0")/pick-run.py")
  [ -n "$RUN_ID" ] || { echo "no usable run found on main" >&2; exit 1; }
  echo "  using run ${RUN_ID}"

  echo "→ downloading artifacts"
  api GET "${API}/actions/runs/${RUN_ID}/artifacts" > "${WORK}/artifacts.json"
  mapfile -t ARTIFACT_IDS < <(python3 -c '
import json, sys
d = json.load(open(sys.argv[1]))
for a in d.get("artifacts", []):
    if not a.get("expired"):
        print(a["id"])
' "${WORK}/artifacts.json")
  [ "${#ARTIFACT_IDS[@]}" -gt 0 ] || { echo "this run has no usable artifacts (expired?)" >&2; exit 1; }

  mkdir -p "${WORK}/unpacked"
  for id in "${ARTIFACT_IDS[@]}"; do
    echo "  artifact ${id}"
    curl -sSL -H "$AUTH_HEADER" "${API}/artifacts/${id}/zip" -o "${WORK}/${id}.zip"
    unzip -qo "${WORK}/${id}.zip" -d "${WORK}/unpacked" 2>/dev/null || echo "  (skipped: not a zip)"
  done

  # 只发用户真会下载的东西：安装包 + CLI 二进制
  find "${WORK}/unpacked" -type f \( \
      -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' -o -name '*.msi' -o \
      -name 'uh-linux-*' -o -name 'uh-darwin-*' -o -name 'uh-win32-*.exe' \) \
    -exec cp -n {} "${FILES}/" \;
fi

# 校验和必须逐文件生成，名字是 <binary>.sha256：
# install.sh 去下载 ${url}.sha256，缺了它校验会被静默跳过 —— 等于没有校验
for f in "${FILES}"/*; do
  [ -f "$f" ] || continue
  case "$f" in *.sha256) continue ;; esac
  base=$(basename "$f")
  ( cd "${FILES}" && sha256_of "${base}" > "${base}.sha256" )
done

COUNT=$(find "${FILES}" -maxdepth 1 -type f ! -name '*.sha256' | wc -l | tr -d ' ')
echo "→ collected ${COUNT} artifacts (+${COUNT} checksums)"
[ "$COUNT" -ge 1 ] || { echo "no files to publish" >&2; exit 1; }
( cd "${FILES}" && ls -la )

if [ "$DRY" = 1 ]; then
  echo ""
  echo "dry run ok — would upload:"
  ( cd "${FILES}" && for f in *; do printf '  %-40s %6s bytes\n' "$f" "$(wc -c < "$f")"; done )
  echo ""
  echo "checksum sample: $(cat "${FILES}/uh-linux-x64.sha256")"
  exit 0
fi

# ---------------------------------------------------------------- 建 release
BODY=$(cat <<'MD'
Local agent harness: every deliverable is executed and verified in a sandbox, and
every run is replayable.

**CLI** — single static binary, no Node required:
```bash
curl -fsSL https://raw.githubusercontent.com/create-info/unit-harness/main/install.sh | bash
```

**Desktop** — download the installer for your platform. The builds are **unsigned**:
on macOS right-click → Open the first time; on Windows expect a SmartScreen prompt.
Linux: `sudo dpkg -i *.deb`, or `chmod +x *.AppImage && ./UnitHarness*.AppImage`.

Each binary ships with a `.sha256` alongside; `install.sh` verifies it before installing.
MD
)

EXISTING=$(api GET "${API}/releases/tags/${TAG}" | json "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))")

if [ -n "$EXISTING" ]; then
  RELEASE_ID="$EXISTING"
  echo "→ release ${TAG} already exists (id ${RELEASE_ID}); filling in what is missing"
else
  echo "→ creating release ${TAG}"
  PAYLOAD=$(TAG="$TAG" BODY="$BODY" python3 -c '
import json, os
print(json.dumps({
  "tag_name": os.environ["TAG"],
  "name": os.environ["TAG"],
  "body": os.environ["BODY"],
  "draft": False,
  "prerelease": False,
}))')
  RELEASE_ID=$(api POST "${API}/releases" "$PAYLOAD" | json "
import json,sys
d=json.load(sys.stdin)
if not d.get('id'):
    sys.exit('create failed: '+str(d)[:300])
print(d['id'])")
  echo "  release ${RELEASE_ID}"
fi

# 已上传的资产不重复传：重跑不该 422
EXISTING_ASSETS=$(api GET "${API}/releases/${RELEASE_ID}/assets" \
  | json "import json,sys;print('\n'.join(a['name'] for a in json.load(sys.stdin)))")

for f in "${FILES}"/*; do
  name=$(basename "$f")
  if printf '%s\n' "$EXISTING_ASSETS" | grep -qxF "$name"; then
    echo "→ ${name} already uploaded, skipping"
    continue
  fi
  echo "→ uploading ${name} ($(wc -c < "$f") bytes)"
  curl -sS -X POST -H "$AUTH_HEADER" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" \
    "https://uploads.github.com/repos/${REPO}/releases/${RELEASE_ID}/assets?name=${name}" \
    | python3 -c 'import json,sys
d = json.load(sys.stdin)
print("  ok" if d.get("id") else "  FAILED: " + str(d)[:300])'
done

echo ""
echo "done: https://github.com/${REPO}/releases/tag/${TAG}"
