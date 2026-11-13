export * from './types.ts'
export { Harness } from './harness.ts'
export type { HarnessOptions, LoadedPlugin, LogLevel } from './harness.ts'
export { probeIsolation, describeIsolation } from './sandbox/probe.ts'
export { EventStore } from './evidence/store.ts'
export type { SessionEvent, SessionMeta } from './evidence/store.ts'
export { SESSION_KINDS } from './evidence/kinds.ts'
export type { SessionKind, EventSource } from './evidence/kinds.ts'
export { uhHome, sessionsDir, workspaceDir, pluginsDir } from './paths.ts'
export { resolveProvider, listModels } from './llm/resolve.ts'
export type { ResolvedProvider } from './llm/resolve.ts'
export { PROVIDERS, findProvider, maskKey } from './llm/providers.ts'
export type { ProviderDef, WireProtocol } from './llm/providers.ts'
export { readConfig, writeConfig, setProviderEntry, unsetProvider, setDefaultProvider, configPath, apiKeyFor } from './llm/config.ts'
export type { UhConfig } from './llm/config.ts'
export { LlmGateway } from './llm/gateway.ts'
export { runAgent } from './agent/loop.ts'
export { needsApproval, denyAll, allowAll } from './approval/gate.ts'
export {
  makeEdit, applyUndo, editsForLastTurn, readSessionEvents,
  readMaybeFile, isRestorable, MAX_INLINE_BYTES, isTurnUndone, markTurnUndone,
  hydrateEdits, toPayload, spillToBlob, INLINE_LIMIT_BYTES,
} from './checkpoint/store.ts'
export type { FileEdit, UndoResult } from './checkpoint/store.ts'
export type { ApprovalGate, ApprovalPolicy, ApprovalRequest, ApprovalDecision } from './approval/gate.ts'
export { buildSystemPrompt, findProjectInstructions } from './agent/prompt.ts'
export { compactMessages, shouldCompact, safeCutIndex } from './agent/compact.ts'
export { parsePatch, planPatch } from './agent/tools/apply-patch.ts'
export { readState, latestResumable } from './evidence/resume.ts'
export type { ResumeState } from './evidence/resume.ts'
export { loadHosts, upsertHost, removeHost, hostsConfigPath, targetOf } from './remote/hosts.ts'
export type { RemoteHost } from './remote/hosts.ts'
export { runRemote, sshArgv } from './remote/ssh.ts'
export { classify, describeRisk } from './remote/risk.ts'
export type { RiskLevel } from './remote/risk.ts'
export { listRecipes, loadRecipe, resolveVars, renderTemplate } from './recipe/registry.ts'
export { runRecipeChecks } from './recipe/checks.ts'
export { BUILTIN_RECIPES } from './recipe/builtin.ts'
export type { Recipe, RecipeCheck, RecipeCheckResult } from './recipe/types.ts'
export { discoverSkills, renderSkillIndex, skillRoots } from './skill/registry.ts'
export type { Skill } from './skill/registry.ts'
export { McpRegistry, qualify } from './mcp/bridge.ts'
export { McpClient } from './mcp/client.ts'
export { loadMcpServers, globalMcpConfigPath, projectMcpConfigPath, upsertMcpServer, removeMcpServer } from './mcp/config.ts'
export type { McpServerConfig, McpTool } from './mcp/client.ts'
export type { RunResult } from './agent/loop.ts'
export type { RunTaskOutcome } from './harness.ts'
export { snapshotDir, diffSnapshots, collectArtifacts } from './artifact/snapshot.ts'
export type { Artifact } from './artifact/snapshot.ts'
export { inferAssertions, runAssertion, describeAssertion } from './verify/assertions.ts'
export type { Assertion, AssertionOutcome } from './verify/assertions.ts'
export type { Message, ImageInput, ToolCall, ToolSpec, Usage, ProviderConfig, LlmRole } from './llm/types.ts'

// A2A v1.0 服务端：把工作区暴露成一个可被其他 agent 调用的 agent
export { createA2AServer, RpcError, textOf } from './a2a/server.ts'
export type { A2AHooks, A2AServerOptions } from './a2a/server.ts'
export { buildAgentCard } from './a2a/card.ts'
export { taskOf, stateOf, historyOf, artifactsOf, isTerminal } from './a2a/task.ts'
export type { SessionView, SessionEvent as A2ASessionEvent } from './a2a/task.ts'
export type { Task, TaskState, Message as A2AMessage, Part, Artifact as A2AArtifact, AgentCard } from './a2a/types.ts'

// ACP v1 服务端：stdio JSON-RPC，让编辑器驱动我们
export { createAcpServer, RpcError as AcpRpcError } from './acp/server.ts'
export type { AcpHooks, AcpHarnessLike } from './acp/server.ts'
export type {
  InitializeParams, InitializeResult, PromptParams, PromptResult, SessionUpdate,
  SessionUpdateParams, StopReason, RequestPermissionParams, RequestPermissionResult,
  ContentBlock as AcpContentBlock,
} from './acp/types.ts'

// 事件 → 人话。三个前端共用一套说法，屏幕上不出现内部术语
export { describeTool, describeToolResult, describeCommand, describeThinking, describeFilesChanged } from './agent/progress.ts'
export type { ProgressLine } from './agent/progress.ts'

// 审批记忆：prefix_rule 持久化（破坏性命令永不记）
export { suggestPrefix, matchesRule, normalizeArgv, loadRules, addRule, removeRule, touchMatching, describeRule } from './approval/rules.ts'
export type { ApprovalRule } from './approval/rules.ts'

// 成本预算：到线就叫停（与上下文压缩不是一回事）
export { checkBudget, normalizeBudget, formatTokens, describeBudget } from './agent/budget.ts'
export type { BudgetConfig, BudgetState, BudgetVerdict } from './agent/budget.ts'

// 文件监听：工作区变了，界面要知道（照 Codex 的三层结构）
export { FileWatcher, DebouncedWatchReceiver, WatchManager } from './watch/index.ts'
export type { WatchPath, WatchEvent, Subscription } from './watch/index.ts'
