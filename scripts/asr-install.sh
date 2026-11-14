#!/usr/bin/env bash
# 本地语音识别安装：faster-whisper + 一个中文够用的模型，全部落在 ~/.uh/asr。
#
# 为什么要有这一步：浏览器自带的语音识别是云端服务（Chrome 把它发给 Google），
# 在大陆基本连不上，界面上只会得到一个 `speech: network`——这句话对用户没有任何
# 信息量。换成这里：录音上传到本机引擎，转写在本机完成，不出网络。
#
#   bash scripts/asr-install.sh            # 默认 small（约 500 MB，中文明显好于 base）
#   UH_ASR_MODEL=base bash scripts/asr-install.sh
#
# 中国大陆访问 huggingface.co 基本不通，默认走 hf-mirror.com；可以自己覆盖 HF_ENDPOINT。
set -euo pipefail

MODEL="${UH_ASR_MODEL:-small}"
DIR="${UH_HOME:-$HOME/.uh}/asr"
PY="${PYTHON:-/usr/bin/python3}"

mkdir -p "$DIR/models"

if [ ! -x "$DIR/venv/bin/python" ]; then
  echo "-- creating venv in $DIR/venv"
  "$PY" -m venv "$DIR/venv"
  "$DIR/venv/bin/pip" install -q --upgrade pip
fi

if ! "$DIR/venv/bin/python" -c 'import faster_whisper' >/dev/null 2>&1; then
  echo "-- installing faster-whisper"
  "$DIR/venv/bin/pip" install -q faster-whisper
fi

# av 16 之后把 `metadata_errors` 参数删了，faster-whisper 1.2 还在用它 —
# 于是「装好了一切正常、一说话就 500」。这里必须把它钉住。
if ! "$DIR/venv/bin/python" -c 'import av; raise SystemExit(0 if int(av.__version__.split(".")[0]) < 16 else 1)' >/dev/null 2>&1; then
  echo "-- pinning av<16 (faster-whisper still passes metadata_errors)"
  "$DIR/venv/bin/pip" install -q "av<16"
fi

if [ ! -f "$DIR/models/$MODEL/model.bin" ]; then
  echo "-- downloading the $MODEL model"
  export HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"
  "$DIR/venv/bin/python" - "$MODEL" "$DIR/models/$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
model, dest = sys.argv[1], sys.argv[2]
snapshot_download(
    repo_id=f"Systran/faster-whisper-{model}",
    local_dir=dest,
    allow_patterns=["*.bin", "*.json", "*.txt"],
)
print("model ->", dest)
PY
fi

echo "ok: $DIR/venv"
echo "model: $DIR/models/$MODEL"
echo ""
echo "restart 'uh serve' (or the desktop app) and the mic button will transcribe locally."
