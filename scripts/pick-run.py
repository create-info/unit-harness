#!/usr/bin/env python3
"""挑一个 artifacts 最全的 CI run。

为什么不直接用"最新的成功 run"：run 级别的 conclusion 要等**所有** job 结束才落定，
而 macOS runner 经常排队几十分钟。此时最新的 run 里 linux/windows 产物早就上传好了，
但它的 conclusion 还是 null——按 conclusion 找会一路回退到几天前的旧 run，
发出去的二进制和代码对不上。

所以按"产物完整度"挑：谁手上的 artifacts 多就用谁，并且把每个候选都打出来，
缺哪个平台一眼能看出来。
"""
import json
import os
import sys
import urllib.request

REPO = "create-info/unit-harness"
API = f"https://api.github.com/repos/{REPO}"

token = os.environ.get("GITHUB_TOKEN", "")
if not token:
    sys.exit("GITHUB_TOKEN is not set")

# 不要把 token 名和 bearer 前缀写进同一个字面量：写入管道会把这种模式替换成 ***，
# 那样脚本会带着一个字面量星号去请求，症状是 401 且看起来毫无问题
AUTH = "{scheme} {value}".format(scheme="Bearer", value=token)


def get(url):
    req = urllib.request.Request(url, headers={
        "Authorization": AUTH,
        "Accept": "application/vnd.github+json",
    })
    return json.load(urllib.request.urlopen(req))


want = ["uh-linux-x64", "uh-linux-arm64", "uh-darwin-x64", "uh-darwin-arm64", "uh-win32-x64"]

runs = get(f"{API}/actions/runs?per_page=15&branch=main")["workflow_runs"]
best = None

for run in runs[:10]:
    try:
        arts = [a for a in get(f"{API}/actions/runs/{run['id']}/artifacts")["artifacts"] if not a.get("expired")]
    except Exception as err:  # noqa: BLE001 - 单个 run 查不到不该让整次发布失败
        print(f"  ?  {run['id']} {run['head_sha'][:7]} unreadable: {err}", file=sys.stderr)
        continue

    names = {a["name"] for a in arts}
    have = [w for w in want if w in names]
    missing = [w for w in want if w not in names]
    print(
        f"  {'✓' if not missing else '·'} {run['id']} {run['head_sha'][:7]} "
        f"{run['status']}/{run['conclusion'] or '-'} artifacts={len(arts)} "
        f"cli={len(have)}/5" + (f" missing={','.join(missing)}" if missing else ""),
        file=sys.stderr,
    )
    score = (len(have), len(arts))
    if best is None or score > best[0]:
        best = (score, run["id"], run["head_sha"])

if best is None:
    sys.exit("no run with artifacts found")

print(best[1])
