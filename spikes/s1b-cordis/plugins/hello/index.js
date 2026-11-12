// 位于用户目录的第三方插件：零运行时依赖，只用 apply(ctx)
// 这是本 spike 要验证的关键约束——插件不 import cordis/core，避免 ESM 解析找不到 node_modules
export default {
  name: '@example/hello',
  apply(ctx) {
    console.log('[plugin:hello] apply() called')
    ctx.provide('hello', { hi: () => 'hi from plugin' })
  },
}
