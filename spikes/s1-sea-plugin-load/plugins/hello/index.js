// 一个位于「用户目录」的第三方插件（模拟 ~/.uh/plugins/hello）
export default {
  name: '@example/hello',
  apiVersion: 1,
  apply(ctx, config) {
    ctx.log.info('apply() called, config =', JSON.stringify(config))
    ctx.provide('helloService', { hi: () => 'hi' })
  },
}
