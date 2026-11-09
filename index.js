/**
 * dsh-ollama-think — 本地 Ollama 模型自动补齐推理等级（事件驱动，零轮询）。
 *
 * 工作原理
 * --------
 * dsh-llm-pi-ai 的推理等级是逐模型声明的（models[].reasoningEfforts），
 * 且没有全局开关；新模型若没这个字段，选择器就不显示等级。本插件把它变成自动的：
 *
 *   1. 问 Ollama 本身：GET /api/tags 列模型，POST /api/show 查顶层
 *      capabilities 是否含 "thinking"（Ollama 对会推理的模型如实上报）。
 *   2. 找到 llm-pi-ai 配置里 baseURL 指向该 Ollama 的路由（默认按 11434 端点匹配）。
 *   3. 通过宿主设置服务的正规写路径 ctx.settings.mutate(ns, ops, revision)
 *      把差异补写进 profile 的 cordis.patch.yml —— 这正是「模型」设置页自己
 *      用的通道：带 revision 冲突检测，绝不覆写并发修改，只写字面量。
 *   4. llm-pi-ai 监听 loader/volatile-update 热重载路由，下一轮对话即生效，
 *      无需重启 DSH。
 *
 * 触发时机（没有任何定时轮询）
 * ----------------------------
 *   - 启动后扫一次；若失败（Ollama 还没起来等）做有限次退避重试
 *     （10s/30s/60s/2min/5min，共 5 次），成功一次后永不再跑；
 *   - fs.watch Ollama 模型目录（默认 ~/.ollama/models），pull/rm 引发目录
 *     变化时防抖 3 秒重扫一次。事件由 OS 内核投递，空闲零开销。
 *
 * 补齐规则（幂等，只增不删）
 * --------------------------
 *   - thinking 模型不在路由 models 列表里 → 追加 { id, name, reasoningEfforts }
 *   - 在列表里但缺 reasoningEfforts 且会 thinking → 加上默认等级
 *   - 其它任何形状（用户手改过的）→ 永不触碰
 *
 * 零依赖：link: 安装的插件按真实路径解析裸导入会 MODULE_NOT_FOUND
 * （见 dsh-splash 的同款教训），因此只用 node:fs / node:os / node:path
 * 与注入的 ctx.settings，不导出 Config。
 *
 * cordis 语义备忘：ctx.effect(fn) 的 fn **立即执行**，fn 返回的函数才是
 * disposer。写错一次已付出过一整轮静默失效的代价，勿再反转。
 *
 * 配置（写在 bundle patch 的 config: 里，可在 profile patch 覆盖）
 * ------------------------------------------------------------
 *   enabled        默认 true；false 则整个插件空转。
 *   ollamaBaseUrl  默认 http://localhost:11434 —— 匹配路由与发起探测。
 *   ollamaModelsDir 监听目录，默认 $OLLAMA_MODELS 或 ~/.ollama/models。
 *   routeId        可选；直接点名 llm-pi-ai providers 下的路由键，跳过 baseURL 匹配。
 *   settingsNs     被写的配置命名空间，默认 llm-pi-ai。
 *   autoAddMissing 默认 true；false 则只给已在列表里的模型补等级，不追加新模型。
 */

import { watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_EFFORTS = { off: null, low: 'low', medium: 'medium', high: 'high' }
const STARTUP_DELAY_MS = 5000
const DEBOUNCE_MS = 3000
const STARTUP_RETRY_DELAYS_MS = [10000, 30000, 60000, 120000, 300000]

function normalize(v) {
  const c = v !== null && typeof v === 'object' ? v : {}
  return {
    enabled: c.enabled !== false,
    ollamaBaseUrl: typeof c.ollamaBaseUrl === 'string' && c.ollamaBaseUrl ? c.ollamaBaseUrl.replace(/\/+$/, '') : 'http://localhost:11434',
    ollamaModelsDir: typeof c.ollamaModelsDir === 'string' && c.ollamaModelsDir ? c.ollamaModelsDir : (process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models')),
    routeId: typeof c.routeId === 'string' && c.routeId ? c.routeId : undefined,
    settingsNs: typeof c.settingsNs === 'string' && c.settingsNs ? c.settingsNs : 'llm-pi-ai',
    autoAddMissing: c.autoAddMissing !== false,
  }
}

async function getJson(url, body, timeoutMs) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${url} -> ${res.status}`)
  return await res.json()
}

/** 比较路由 baseURL（…/v1）与探测端点（…:11434），忽略 /v1 后缀与末尾斜杠。 */
function sameEndpoint(routeBaseUrl, ollamaBase) {
  if (typeof routeBaseUrl !== 'string') return false
  const trim = (s) => s.replace(/\/+$/, '').replace(/\/v1$/, '')
  const a = trim(routeBaseUrl)
  return a.length > 0 && a === trim(ollamaBase)
}

/**
 * 纯函数：当前 models 列表 + thinking 判定 → 新列表；无差异返回 undefined。
 * 不修改输入。只增不删——任何已有 reasoningEfforts（含自定义形状）都不触碰。
 */
export function computeNextModels(current, facts, autoAddMissing) {
  const list = Array.isArray(current) ? current : []
  const known = new Set(list.map((m) => (m && typeof m.id === 'string' ? m.id : undefined)))
  let changed = false
  const next = list.map((m) => {
    if (!m || typeof m.id !== 'string') return m
    const fact = facts.get(m.id)
    if (fact === undefined || !fact.thinking || m.reasoningEfforts !== undefined) return m
    changed = true
    return { ...m, reasoningEfforts: { ...DEFAULT_EFFORTS } }
  })
  if (autoAddMissing) {
    for (const [id, fact] of facts) {
      if (!fact.thinking || known.has(id)) continue
      changed = true
      next.push({ id, name: id, reasoningEfforts: { ...DEFAULT_EFFORTS } })
    }
  }
  return changed ? next : undefined
}

/** Ollama 侧事实：模型名 -> { thinking }；/api/tags 不可达返回 undefined。单个 show 失败则跳过该模型。 */
async function collectThinkingFacts(base) {
  const tags = await getJson(`${base}/api/tags`, undefined, 8000)
  const models = Array.isArray(tags?.models) ? tags.models : undefined
  if (!models) return undefined
  const facts = new Map()
  for (const m of models) {
    if (typeof m?.name !== 'string') continue
    try {
      const show = await getJson(`${base}/api/show`, { model: m.name }, 10000)
      facts.set(m.name, { thinking: Array.isArray(show?.capabilities) && show.capabilities.includes('thinking') })
    } catch {
      // 探测失败：本轮跳过它，不动它的配置
    }
  }
  return facts
}

export default {
  name: 'dsh-ollama-think',

  apply(ctx, rawConfig) {
    const cfg = normalize(rawConfig)
    if (!cfg.enabled) return
    let stopped = false
    let busy = false
    let watcherClose
    let debounceTimer

    // 卸载/停用时回收监听器。cordis 语义：effect 的函数体立即执行，
    // 其返回的函数才是 disposer——必须 return 出去，写反会让清理当场跑一次。
    ctx.effect(() => () => {
      stopped = true
      clearTimeout(debounceTimer)
      if (watcherClose !== undefined) {
        try { watcherClose() } catch { /* 卸载路径永不抛 */ }
      }
    })

    /** @returns {Promise<boolean>} 本轮是否走通了完整链路（Ollama 应答 + 路由确认 + 写入未失败）。 */
    async function scan(settings) {
      if (stopped || busy) return false
      busy = true
      try {
        const facts = await collectThinkingFacts(cfg.ollamaBaseUrl)
        if (facts === undefined || facts.size === 0) return false
        const descriptor = settings.describe({ redactSecrets: true }).find((row) => row.ns === cfg.settingsNs)
        if (!descriptor) return false
        const providers = descriptor.value?.providers
        if (!providers || typeof providers !== 'object') return false
        let routeKey
        let route
        for (const [key, value] of Object.entries(providers)) {
          if (cfg.routeId !== undefined ? key === cfg.routeId : sameEndpoint(value?.baseURL, cfg.ollamaBaseUrl)) {
            routeKey = key
            route = value
            break
          }
        }
        if (!route || routeKey === undefined) return false
        const nextModels = computeNextModels(route.models, facts, cfg.autoAddMissing)
        if (nextModels !== undefined) {
          await settings.mutate(cfg.settingsNs, [{ op: 'set', path: ['providers', routeKey, 'models'], value: nextModels }], descriptor.revision)
          ctx.logger.info('ollama-think: reasoningEfforts synced for route "%s" (%d models)', routeKey, nextModels.length)
        }
        return true
      } catch (error) {
        ctx.logger.debug('ollama-think: scan failed: %s', error instanceof Error ? error.message : String(error))
        return false
      } finally {
        busy = false
      }
    }

    /** 监听 Ollama 模型目录：pull/rm 触发防抖重扫；watcher 已建则跳过。 */
    function watchModelsDir(settings) {
      if (watcherClose !== undefined || stopped) return
      try {
        watcherClose = watch(cfg.ollamaModelsDir, { recursive: true }, () => {
          if (stopped) return
          clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            scan(settings).then((ok) => {
              if (!ok) ctx.logger.info('ollama-think: change-triggered scan did not complete; will retry on next change')
            })
          }, DEBOUNCE_MS)
        })
        ctx.logger.debug('ollama-think: watching %s', cfg.ollamaModelsDir)
      } catch (error) {
        ctx.logger.debug('ollama-think: cannot watch %s (%s)', cfg.ollamaModelsDir, error instanceof Error ? error.message : String(error))
      }
    }

    ctx.inject(['settings'], (child) => {
      const settings = child.settings
      let attempt = 0
      const runStartupScan = () => {
        if (stopped) return
        scan(settings).then((ok) => {
          watchModelsDir(settings) // watcher 独立于扫描成败，能建就建
          if (ok) return
          if (attempt >= STARTUP_RETRY_DELAYS_MS.length) {
            ctx.logger.info('ollama-think: startup scan never succeeded (Ollama unreachable or route not found); relying on model-dir events')
            return
          }
          setTimeout(runStartupScan, STARTUP_RETRY_DELAYS_MS[attempt++])
        })
      }
      setTimeout(runStartupScan, STARTUP_DELAY_MS)
    })
  },
}
