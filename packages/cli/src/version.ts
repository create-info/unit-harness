declare const __UH_VERSION__: string
/** 构建时由 esbuild define 注入 */
export const VERSION: string = typeof __UH_VERSION__ === 'string' ? __UH_VERSION__ : '0.0.0-dev'
