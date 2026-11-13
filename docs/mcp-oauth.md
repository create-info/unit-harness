# MCP 的 OAuth

远程 MCP server 要授权时不再只能靠手填 header。流程是标准的三段发现 + PKCE：

```
401 + WWW-Authenticate: Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"
  → GET 那个地址（RFC 9728），拿到 authorization_servers[]
  → GET 授权服务器的 /.well-known/oauth-authorization-server（RFC 8414）
  → 动态注册客户端（RFC 7591）拿 client_id
  → PKCE 授权码流程，本地起回调服务器收 code
  → 换 token，0600 存起来，过期前刷新
```

Codex 这一段交给 `rmcp` 的 `AuthorizationManager`；我们没有那个库，自己写。

## 默认关闭

```json
{ "mcpServers": { "github": { "url": "https://…/mcp", "oauth": true } } }
```

授权要弹浏览器、要人点一下。一个 agent 不该在跑任务途中突然把浏览器抢过去——所以只有显式
写了 `oauth: true` 的 server 才会走这条路，其余的 401 原样报错。

## 授权服务器混淆（RFC 9700 §4.4）

一个人会连很多 MCP server。如果它们共用同一个回调 URL，而授权响应里不说明它来自哪一台，
那条 code 就可能被交给另一台服务器的 token 端点——**等于把钥匙递给了别人**。

两个防御，优先用第一个：

| 模式 | 条件 | 做法 |
|---|---|---|
| **IssuerBound** | 授权服务器声明 `authorization_response_iss_parameter_supported` | 校验回调里的 `iss` 与发现阶段一致，缺了或对不上都拒绝 |
| **CallbackSpecific** | 服务器不支持 `iss` | 每个 server 用**不同的回调路径**（URL 的 SHA-256 前 16 位） |

只有服务器**明确声明**会带 `iss` 时才强制校验它。它没声明却要求它带，会把正常的服务器全拒掉。

## 其它必须做对的

- **`state` 必须校验**，且用固定时间比较（不因为第一个字节不同就提前返回）。对不上就是拒绝，不「先接受再说」。
- **只 bind `127.0.0.1`**。`0.0.0.0` 会把回调暴露到整个局域网。
- **只接受 S256**。服务器只支持 `plain` 时直接报错——公开客户端上的 plain PKCE 等于没有 PKCE。
- **带 `resource` 参数**（RFC 8707）。不带上，拿到的 token 就可能被拿去打别的 server。
- **`quoted-string` 要还原** `\"`，逗号在引号里不算分隔符，坏掉的头部当没有挑战（不猜）。
- **刷新时保留旧的 `refresh_token`**，除非服务端轮换了。不保留的话第二次刷新必然失败。
- **提前 60 秒算过期**，避免「还差 3 秒」那种边缘失败。

## 一个不显眼但会炸的坑

`McpClient` 的构造函数原来写成 TS 的参数属性：

```ts
constructor(readonly name: string, private readonly cfg: McpServerConfig) {}
```

编译没问题，但**测试里直接 import `.ts` 会炸**——Node 的 type-stripping 不支持这个语法
（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。改成显式字段赋值。生产走 build 所以看不出来，
只在测试里暴露。

## 存储

`~/.uh/mcp-oauth.json`，0600，按 server URL 索引：

```json
{ "tokens": { "https://mcp.example/mcp": {
  "accessToken": "…", "refreshToken": "…", "expiresAt": 1767…, "tokenType": "Bearer", "issuer": "https://as.example"
} } }
```

文件坏了等价于「没有 token」（重走授权），不是崩溃。

## 验证

```bash
node --test tests/mcp-oauth.test.mjs      # 33 个
node --test tests/mcp-oauth-e2e.test.mjs  # 4 个
```

单测覆盖零件：头部语法（转义、引号内逗号、Basic 与 Bearer 共存、未闭合引号）、PKCE 的
S256 自洽、回调路径按 server 区分、state/iss 的四种拒绝路径、token 存取的 0600、刷新时的
轮换与不轮换。

端到端覆盖串起来能不能用——真起一个要授权的 MCP server 和它身后的授权服务器，走完
401 → 发现 → 注册 → PKCE → 授权 → 回调 → 换 token →**带 token 重试**，最后 `listTools` 拿回工具。
另外三条：关掉 oauth 时不弹浏览器、iss 不匹配时拒绝、iss 匹配时通过。

零件测试看不见的 bug 恰恰在接缝处：令牌没带上、重试用了旧的 id、回调路径拼错。
