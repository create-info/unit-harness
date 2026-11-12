import type { Recipe } from './types.ts'

/**
 * 内置剧本写成常量，不读磁盘：单文件分发时没有 "recipes/" 目录可读，
 * 而剧本是产品的一部分，不能因为换了分发形态就消失。
 * 用户仍可在 ~/.uh/recipes/*.json 里放自己的，同名覆盖。
 */
export const BUILTIN_RECIPES: Recipe[] = [
  {
    name: 'node-service',
    description: '生成一个零依赖的 Node HTTP 服务，并证明它真的能响应',
    vars: { port: 8731 },
    task: [
      '在工作区创建一个零依赖的 Node.js HTTP 服务，文件名为 server.mjs。',
      '要求：',
      '1. 监听端口 {{port}}（只绑 127.0.0.1）',
      '2. GET /healthz 返回 JSON {"ok":true}，状态码 200',
      '3. 其他路径返回 404',
      '4. 不要引入任何第三方依赖，只用 node: 内置模块',
      '5. 不要自己启动服务或后台运行它 —— 验证由外部完成',
      '完成后说明文件内容与设计取舍。',
    ],
    checks: [
      { kind: 'file', path: 'server.mjs', label: 'server.mjs 已创建' },
      {
        kind: 'command',
        label: '服务能起来且 /healthz 返回 200',
        argv: ['sh', '-c', 'node server.mjs >/dev/null 2>&1 & pid=$!; sleep 1.5; curl -sf -o /dev/null http://127.0.0.1:{{port}}/healthz; st=$?; kill $pid 2>/dev/null; exit $st'],
        timeoutMs: 20000,
      },
    ],
  },
  {
    name: 'python-cli',
    description: '生成一个无依赖的 Python CLI，并证明 --help 与核心子命令可用',
    task: [
      '在工作区创建一个 Python 命令行工具，文件名为 cli.py，只用标准库。',
      '要求：',
      '1. 支持 `python3 cli.py add 2 3`，输出 5',
      '2. 支持 `--help`，说明用法',
      '3. 参数缺失时给出可读错误并以非 0 退出',
      '4. 不要引入任何第三方依赖',
      '完成后说明实现方式。',
    ],
    checks: [
      { kind: 'file', path: 'cli.py', label: 'cli.py 已创建' },
      { kind: 'command', label: '--help 可用', argv: ['python3', 'cli.py', '--help'], timeoutMs: 15000 },
      {
        kind: 'command',
        label: 'add 2 3 输出 5',
        argv: ['sh', '-c', 'test "$(python3 cli.py add 2 3)" = "5"'],
        timeoutMs: 15000,
      },
    ],
  },
]
