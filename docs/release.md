# UnitHarness 分发与 CI 构建清单 v1

> 状态：**草案**（2026-11-12）
> 上位：`unit-harness-opensource-v1.md` D2（全 Node）+ D15（分发矩阵）
> 目标：`npm i -g @unit-harness/cli` 与 GitHub Release 下载**得到同一个二进制、同一份行为**。

---

## 1. 产物矩阵

| 目标 | 三元组 | 格式 | npm 包 | 状态 |
|---|---|---|---|---|
| Linux x64 | `x86_64-unknown-linux-gnu`（glibc ≥ 2.28） | `.tar.gz` + `.zst` | `@unit-harness/cli-linux-x64` | P0 必须 |
| Linux arm64 | `aarch64-unknown-linux-gnu`（glibc ≥ 2.28） | `.tar.gz` + `.zst` | `@unit-harness/cli-linux-arm64` | **P0 必须**（ARM 云便宜 30–40%） |
| Linux musl（静态） | `*-unknown-linux-musl` | — | — | **暂停**，S2 未通过 |
| macOS arm64 | `aarch64-apple-darwin` | `.tar.gz` | `@unit-harness/cli-darwin-arm64` | P0 必须 |
| macOS x64 | `x86_64-apple-darwin` | `.tar.gz` | `@unit-harness/cli-darwin-x64` | P0 必须 |
| Windows x64 | `x86_64-pc-windows-msvc` | `.zip` | `@unit-harness/cli-win32-x64` | P0 必须 |
| Windows arm64 | `aarch64-pc-windows-msvc` | `.zip` | `@unit-harness/cli-win32-arm64` | P2（用户量待观察） |
| macOS 桌面壳 | 同上 | `.dmg` | — | P3 |
| 辅助二进制 | `landlock-helper` / `bwrap` | 随平台包内嵌 | 同包 | P1 |

**通用产物**：

```
SHA256SUMS
install.sh
install.ps1
cordis.schema.json          # 配置补全（编辑器用）
*.sigstore                  # 每个二进制与每个压缩包的签名 bundle
```

---

## 2. 单文件构建：Node SEA

### 2.1 流程

```bash
# ① 打包成单文件 **CJS**
#    实测：Node 22 的 SEA 入口必须是 CJS（ESM 会报 Cannot use import statement
#    outside a module at internal/main/embedding:60 embedderRunCjs）。
#    源码可以写 ESM/TS，esbuild 输出 CJS 即可。
esbuild packages/cli/src/main.ts --bundle --platform=node --format=cjs \
  --target=node22 --outfile=dist/uh.cjs

# ② 生成 SEA blob（可内嵌 web 静态资源）
node --experimental-sea-config sea-config.json

# ③ 复制基座 node，注入 blob
cp "$(command -v node)" build/uh
npx postject build/uh NODE_SEA_BLOB build/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# ④ macOS 必须重签名（复制已签名二进制后签名失效）
codesign --remove-signature build/uh        # macOS
codesign --sign - build/uh                  # ad-hoc，正式版用 Developer ID
```

`sea-config.json`：

```json
{
  "main": "dist/uh.cjs",
  "output": "build/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useCodeCache": true,
  "assets": {
    "web/index.html": "dist/web/index.html",
    "web/app.js": "dist/web/app.js",
    "events.v1.json": "schema/events.v1.json"
  }
}
```

### 2.2 Spike 实测结论（已完成，2026-11-12）

S1 与 S1b 均已通过（详见 `spikes/RESULTS.md`），并带来两条必须遵守的实现约束：

1. **SEA 入口必须是 CJS**——Node 22 不支持 ESM `main`（`embedderRunCjs` 直接抛错）。
2. **动态 import 用户插件必须用 `new Function('s','return import(s)')` 包裹**，
   否则打包器会把它改写成 `require` 链，运行时找不到外部 ESM。
3. 插件必须**零运行时依赖**（不 import cordis / core），否则在 `~/.uh/plugins` 下
   解析不到 `node_modules`；插件目录需带 `"type": "module"`。

### 2.3 两个必须先验证的点（spike）

| # | 问题 | 若失败的影响 | fallback |
|---|---|---|---|
| **S1** | SEA 产物能否 `import()` **用户目录下的 ESM 插件**（`~/.uh/plugins/x/index.js`） | 插件体系不可用，整个架构前提崩塌 | ① 改用 `createRequire` + CJS 兼容层；② 退回"内嵌 Node 的轻量启动器"（`uh` 只是个 shell wrapper，实际用系统 node 跑 `lib/`，体积 15MB，要求 node≥22）；③ 最差：Tauri 壳内嵌 Node |
| **S2** | musl SEA —— **2026-11-12 实测失败**：alpine 3.22 + 自带 node 22.23.4（musl）生成 blob → postject 注入 → 运行即 `Segmentation fault`，崩在我们的代码之前。blob 与基座是同一二进制，非版本不匹配 | Linux 无法静态分发，Alpine 容器场景受限 | **已采用**：glibc 构建 + 文档要求 glibc ≥ 2.28；补 Docker 镜像。**后台继续试**：unofficial-builds 静态 musl node / `objcopy --add-section` 替代 postject / 更新的 postject |

**验证脚本（S1）**：

```bash
mkdir -p /tmp/uh-spike/plugins/hello
cat > /tmp/uh-spike/plugins/hello/index.js <<'EOF'
export default { name: 'hello', apiVersion: 1, apply(ctx) { ctx.log.info('loaded') } }
EOF
UNTAI_PLUGIN_DIR=/tmp/uh-spike/plugins ./build/uh plugin list
# 期望：列出 hello，且日志出现 loaded
```

S1 不通过就不要继续做 SEA，直接切 fallback ②——**这是 P0 的唯一硬阻塞**。

---

## 3. npm 平台分包

```
@unit-harness/cli                 主包（launcher，< 20KB）
@unit-harness/cli-linux-x64       含 bin/uh（SEA 二进制，~90MB）
@unit-harness/cli-linux-arm64
@unit-harness/cli-darwin-arm64
@unit-harness/cli-darwin-x64
@unit-harness/cli-win32-x64
```

`@unit-harness/cli/package.json`：

```json
{
  "name": "@unit-harness/cli",
  "version": "0.1.0",
  "bin": { "uh": "bin/uh.js", "unitai": "bin/uh.js" },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "optionalDependencies": {
    "@unit-harness/cli-linux-x64": "0.1.0",
    "@unit-harness/cli-linux-arm64": "0.1.0",
    "@unit-harness/cli-darwin-arm64": "0.1.0",
    "@unit-harness/cli-darwin-x64": "0.1.0",
    "@unit-harness/cli-win32-x64": "0.1.0"
  }
}
```

`bin/uh.js`（launcher，约 30 行）：按 `process.platform` + `process.arch` 映射到包名 → `require.resolve` → `spawn` 该二进制，透传 argv/stdio/exit code。找不到时给出**可读错误**（"你的平台 win32-arm64 暂无预编译包，请用 `npm i -g @unit-harness/cli --force` 走 JS 模式"）。

平台包用 `os` / `cpu` 字段声明适用性，npm 只装匹配的那一个：

```json
{ "os": ["linux"], "cpu": ["x64"], "files": ["bin/uh"], "preferUnplugged": true }
```

**为什么 npm 也发 SEA 二进制而不是纯 JS**：D2 的"CI 过的测试 = 用户机器上的行为"要求二进制一致；纯 JS 模式会让"用户 node 版本"成为未受测变量。代价是安装包大（Codex 的 npm 包 166MB，我们约 90MB），可接受。

---

## 4. 辅助二进制

| 二进制 | 用途 | 打包方式 |
|---|---|---|
| `bwrap` | Linux 沙箱降级链第二档（D7） | 从 Alpine 的静态包里取，随 `cli-linux-*` 发布，安装时校验 sha256；**不依赖用户系统是否装了 bwrap**（Ubuntu 23.10+ 的 userns 限制仍可能导致不可用，此时继续降级） |
| `landlock-helper` | 若需要独立的 landlock 封装进程（而非 `process.binding` 路径） | 我们自己构建，Rust/C，仅 Linux |

两者都要：签名、在 `uh doctor` 里报告版本与可用性、**失败不影响主流程**（只是降级）。

---

## 5. GitHub Actions

### 5.1 `ci.yml`（每个 PR）

```yaml
jobs:
  lint:        node 22 · oxlint · prettier --check
  typecheck:   tsc -b（全部 tsconfig）
  deps:        scripts/check-deps.ts        # R1–R5 依赖方向规则
  constraints: scripts/check-constraints.ts # 四条不可回退约束（D2/D3/D6/D5）
  test:        vitest run --coverage
  snapshot:    vitest run -c vitest.snapshot.config.ts   # 录制回放
  api-surface: scripts/api-surface.ts --diff origin/main  # @public 变更检测（D4）
  core-wo-protocols: 删掉 protocol 包后跑核心测试（D11 验收）
```

`constraints` job 检查的四条（对应 `unit-harness-opensource-v1.md` 附录）：
1. 无 bun 依赖、无 `Bun.` 调用；
2. 无 `vendor/cordis`；
3. 核心 schema 无 `remote_id|synced_at|server_`；
4. 文档无 "capability manifest prevents/enforces" 类表述。

### 5.2 `release.yml`（打 tag 触发）

```yaml
on: { push: { tags: ['v*'] } }
jobs:
  verify:      # 先跑一遍 ci.yml 的全部 job，任一失败即中止
  build:
    strategy:
      matrix:
        include:
          - { os: ubuntu-22.04,      target: linux-x64,   flavor: glibc }
          - { os: ubuntu-22.04-arm,  target: linux-arm64, flavor: glibc }
          - { os: macos-14,          target: darwin-arm64, flavor: none }
          - { os: macos-13,          target: darwin-x64,   flavor: none }
          - { os: windows-2022,      target: win32-x64,    flavor: none }
          # musl 暂停：见 §2.2 S2
  sign:
    needs: build
    permissions: { id-token: write, contents: write }   # keyless OIDC 必需
    steps:
      - uses: sigstore/cosign-installer@v3
      - run: cosign sign-blob --yes --bundle "$f.sigstore" "$f"
  checksums:   # sha256sum 汇总成 SHA256SUMS，再对 SHA256SUMS 签名
  publish-npm: # 七个包依次 npm publish --access public --provenance
  release:     # gh release create vX.Y.Z + 全部产物 + notes
```

**Linux 构建**：在 `ubuntu` runner 上用官方 glibc node 作 SEA 基座，完成后 `strip`。**musl 暂停**——segfault 未解决（见 §2.2 S2），恢复前不要发布 `*-linux-musl` 产物，也不要在 README 声称支持 Alpine。

**Windows 构建**：`postject` 在 Windows 上对 `.exe` 注入后**必须重签**（我们的代码签名证书），否则 SmartScreen 拦截。

**Arm runner**：公开仓库可用 `ubuntu-22.04-arm`；若配额受限，linux-arm64 用 QEMU（慢 10 倍，但只跑一次发布可接受）。

### 5.3 npm provenance

`npm publish --provenance` 需要 `id-token: write`，产物与 commit 绑定，用户可 `npm audit signatures` 验证。这是 npm 生态里"供应链可信"的最低要求，必须开。

---

## 6. 签名与校验

| 环节 | 做法 |
|---|---|
| 二进制/压缩包 | `cosign sign-blob --bundle x.sigstore`（keyless，OIDC 身份绑定 GitHub Actions workflow） |
| 校验和 | `SHA256SUMS`，并对它本身签名 |
| 用户验证 | `uh self verify` 或 `cosign verify-blob --bundle` |
| macOS | Developer ID 签名 + notarization（`.dmg` 与二进制都要），否则 Gatekeeper 拦截 |
| Windows | Authenticode 签名（EV 证书可减少 SmartScreen 警告） |

`install.sh` 的校验顺序：下载 → `sha256sum -c` → （可选）`cosign verify-blob` → 解压到 `~/.local/bin`（或 `/usr/local/bin`，看权限）→ 打印 `uh --version` 与 `uh doctor` 摘要。

---

## 7. 版本与发布节奏

| 项 | 决策 |
|---|---|
| tag | `v0.1.0`（统一 tag，不用语言前缀；我们不是单语言项目） |
| 版本管理 | changesets；同一次 release 所有包统一 bump（避免平台包版本错配） |
| 节奏 | 每周一次 minor，hotfix 随时 patch；**平台包与主包必须同版本号** |
| API 冻结 | 见 D4：`@public` 才承诺兼容 |
| 插件 API 版本 | `apiVersion` 独立于包版本演进（D3 薄封装的好处） |
| Release notes | 自动从 changesets 生成 + 手写"这一版对验证语义的影响"一节 |

**发布 checklist**（写进 `docs/releasing.md`，发布者逐条打勾）：

1. [ ] `ci.yml` 全绿；`constraints` 与 `api-surface` 无警告
2. [ ] `pnpm install --frozen-lockfile` 在干净容器里成功（验证 `patches/` 可应用）
3. [ ] SEA spike（S1）在该版本仍通过——**每版都跑，不只在 P0 跑**
4. [ ] 五个平台产物齐全，`SHA256SUMS` 与签名齐备
5. [ ] `install.sh` 在干净 Ubuntu/Alpine/macOS 上实测安装成功
6. [ ] `npm i -g @unit-harness/cli` 在五平台各测一次（含 `uh doctor`）
7. [ ] 沙箱矩阵：各平台 `uh doctor` 报告的 `IsolationLevel` 与 D7 表一致
8. [ ] 录制回放：`uh session replay` 在四个平台产物上结果一致（sha256 相同）
9. [ ] `cordis.schema.json` 与当前配置结构一致
10. [ ] 桌面壳（若有）：`.dmg` 已 notarize

第 3 与第 8 条是"验证闭环"自己的验收——**如果我们连自己的产物都不能可复现地验证，这个项目就没有资格谈验证**。

---

## 8. 分阶段落地

| 期 | 产物 | 说明 |
|---|---|---|
| P0 | linux-x64 + darwin-arm64 + win32-x64 三个产物 + `npm i -g` | 先覆盖 80% 用户；`install.sh` 同步上线 |
| P1 | 加 linux-arm64 + darwin-x64 + bwrap 内嵌 | ARM 云用户到位；`uh doctor` 报告沙箱矩阵 |
| P1.5 | musl SEA（若 spike 通过）+ Docker 镜像 | Alpine / 容器场景 |
| P2 | win32-arm64 + Docker 镜像 + `cordis.schema.json` | 容器/CI 场景 |
| P3 | `.dmg` 桌面壳 + 自动更新 | `uh update` 检查 manifest 与签名 |

---

## 9. 与现有站点的衔接

本地 agent 的发布产物**不依赖** unitai.site：`install.sh` 从 GitHub Releases 下载，`npm` 从 registry 下载。站点只承担两件事：

1. 数据包下载与鉴权（D6 的 sync 与 market 插件）；
2. `uh login` 的 OAuth 回调。

**这样即使站点挂了，用户照样能装能用**——对一个"本地优先"的产品，这是基本要求，也是"开源 + 自托管"叙事的一部分。
