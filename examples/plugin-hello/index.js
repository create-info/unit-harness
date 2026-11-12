/**
 * 最小可跑插件（示例，生态入口）。
 *
 * 关键约束（由 S1/S1b spike 验证得出）：
 *  - 插件的 package.json 必须 "type": "module"，否则 Node 会按 CJS 重解析（性能警告）；
 *  - 插件零运行时依赖：不 import cordis，也不 import @unit-harness/core 的运行时值，
 *    只用 apply(ctx) 拿到的上下文；
 *  - 所有副作用走 ctx.exec，不要直接 import node:child_process。
 */
export default {
  name: '@unit-harness-example/hello',
  apiVersion: 1,

  apply(ctx) {
    ctx.log.info('hello plugin applied')

    // 注册一个工具：可用 `uh tool hello` 直接调用
    ctx.tools.register({
      name: 'hello',
      description: 'Say hello and report the sandbox isolation in use',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const r = await ctx.exec.run(['sh', '-c', 'echo hello from exec'])
        return {
          content: `hello (isolation=${r.isolation}, exit=${r.exitCode}) ${r.stdout.trim()}`,
        }
      },
    })

    // 注册一个钩子：command 模式，最确定、最可回放
    // 注意：exit 2 才是阻断，exit 1 是非阻断错误
    ctx.hooks.on('pre-tool', {
      name: 'hello-guard',
      mode: 'command',
      command: ['sh', '-c', 'exit 0'],
    })
  },
}
