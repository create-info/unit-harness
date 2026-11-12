/** 所有磁盘位置集中在这里，便于测试用 UH_HOME 重定向。 */
import os from 'node:os'
import path from 'node:path'

export function uhHome(): string {
  return process.env.UH_HOME ?? path.join(os.homedir(), '.uh')
}

export const sessionsDir = (): string => path.join(uhHome(), 'sessions')
export const workspaceDir = (): string => path.join(uhHome(), 'work')
export const pluginsDir = (): string => path.join(uhHome(), 'plugins')
