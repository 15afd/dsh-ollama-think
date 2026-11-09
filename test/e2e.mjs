/**
 * dsh-ollama-think 自包含测试（零依赖，node test/e2e.mjs）
 *
 * 覆盖两层：
 *   1. computeNextModels 纯函数——幂等 / 只增不删 / 不触碰自定义形状 / 不修改输入。
 *   2. 端到端——假 Ollama（/api/tags + /api/show）+ 宿主桩。
 *      宿主桩**忠实复刻 cordis 的 ctx.effect 语义**：函数体立即执行，
 *      其返回值（若为函数）才是 disposer。曾把清理逻辑直接写进函数体，
 *      导致 stopped=true 在插件启动瞬间生效、整个插件静默失效
 *      （fiber 仍 active，表象是"装好了但什么都不写"）。该桩就是防回归闸门。
 *
 * 场景：启动扫描写入 → 模拟 ollama pull（模型目录文件事件）追加新模型 →
 *       无变化事件不写 → dispose 后事件不再写。
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import plugin, { computeNextModels } from '../index.js'

const DEFAULT = { off: null, low: 'low', medium: 'medium', high: 'high' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 1. 纯函数 ---------------- */

const cur = [
  { id: 'a', name: 'a', reasoningEfforts: DEFAULT },
  { id: 'b', name: 'b' },
  { id: 'c', name: 'c', reasoningEfforts: { off: null, high: 'high' } },
]
const facts = new Map([
  ['a', { thinking: true }],
  ['b', { thinking: true }],
  ['c', { thinking: true }],
  ['new:d', { thinking: true }],
])
const next = computeNextModels(cur, facts, true)
assert.deepEqual(next.find((m) => m.id === 'b').reasoningEfforts, DEFAULT, '缺失等级的 thinking 模型应被补齐')
assert.deepEqual(next.find((m) => m.id === 'c').reasoningEfforts, { off: null, high: 'high' }, '自定义形状必须原样保留')
assert.equal(next.length, 4, '新 thinking 模型应被追加')
assert.equal(computeNextModels(next, facts, true), undefined, '重算无差异应返回 undefined（幂等）')
assert.equal(computeNextModels(next, new Map([['b', { thinking: false }]]), false), undefined, '只增不删：thinking 丢失也不移除等级')
assert.equal(cur[1].reasoningEfforts, undefined, '输入对象不应被修改')
assert.equal(cur.length, 3, '输入数组不应被修改')
console.log('  unit: computeNextModels ✓')

/* ---------------- 2. 端到端 ---------------- */

// 假 Ollama：listen(0) 由系统分配端口，避免撞用户真实 11434。
let tagged = [{ name: 'thinker:a', modified_at: '1' }, { name: 'dumb:c', modified_at: '2' }]
const server = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: tagged }))
    return
  }
  if (req.url === '/api/show') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const name = JSON.parse(body).model
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ capabilities: name.startsWith('thinker') ? ['completion', 'thinking'] : ['completion'] }))
    })
    return
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ot-models-'))
const writes = []
const providers = { ollama: { baseURL: `${baseUrl}/v1`, models: [{ id: 'dumb:c', name: 'dumb:c' }] } }
let revision = 1
const handlers = new Map()
const emit = (name, ...args) => { handlers.get(name)?.(...args) }
const settingsStub = {
  describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers } }],
  async mutate(ns, ops, expected) {
    if (expected !== revision) { const e = new Error('conflict'); e.code = 'SETTINGS_CONFLICT'; throw e }
    writes.push(ops[0].value.map((m) => m.id))
    providers.ollama.models = structuredClone(ops[0].value)
    revision += 1
    emit('settings/document-updated', ns) // 真实 settings 服务写后 describe() 会发此事件（回声）
  },
}

// cordis 语义：effect(execute) 立即运行 execute()；execute 的返回值若是函数，即 disposer。
// ctx.on 注册监听并返回 disposer（fiber 销毁时宿主自动回收，桩里如实返回）。
const disposers = []
const ctx = {
  fiber: { entry: { options: { id: 'ollama-think' } } },
  effect: (execute) => { const dispose = execute(); if (typeof dispose === 'function') disposers.push(dispose) },
  on: (name, fn) => { handlers.set(name, fn); return () => { if (handlers.get(name) === fn) handlers.delete(name) } },
  inject: (_deps, cb) => { cb({ settings: settingsStub }) },
  logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
}

const STARTUP_WAIT = 5000 + 1500
plugin.apply(ctx, { ollamaBaseUrl: baseUrl, ollamaModelsDir: modelsDir })
assert.equal(disposers.length, 1, '应注册恰好一个 disposer')
await sleep(STARTUP_WAIT)
assert.deepEqual(writes.at(-1), ['dumb:c', 'thinker:a'], '启动扫描应把缺失等级的 thinking 模型补上')

// 模拟 ollama pull：清单多一个模型 + 模型目录落文件 → 事件 → 防抖 3s → 重扫
tagged = [...tagged, { name: 'thinker:z', modified_at: '3' }]
fs.writeFileSync(path.join(modelsDir, 'new-model.manifest'), 'x')
await sleep(3000 + 2000)
assert.deepEqual(writes.at(-1), ['dumb:c', 'thinker:a', 'thinker:z'], 'pull 事件应自动追加新 thinking 模型')

// 信号 2：经「模型」设置页添加模型——配置变了、模型目录**没有任何文件事件**。
// 设置页采纳一条新路由模型 = providers 列表多一个无等级条目 + document-updated。
tagged = [...tagged, { name: 'thinker:y', modified_at: '4' }]
providers.ollama.models = [...providers.ollama.models, { id: 'thinker:y', name: 'thinker:y' }]
const writesBeforeSettingsEvent = writes.length
emit('settings/document-updated', 'llm-pi-ai')
await sleep(3000 + 2000)
assert.equal(writes.length, writesBeforeSettingsEvent + 1, 'settings 事件应触发且仅触发一次写入')
assert.deepEqual(writes.at(-1), ['dumb:c', 'thinker:a', 'thinker:z', 'thinker:y'], '应为设置页新增的条目补上等级')
// 回声防护：上面那次 mutate 在桩里同步 emit 了 document-updated；1.5s 窗口内
// 必须被当作自己的回声吞掉，之后不得再有连锁写入（不自激）。
await sleep(3000 + 1500)
assert.equal(writes.length, writesBeforeSettingsEvent + 1, '自写回声不得产生后续写入（无自激循环）')

// 其他命名空间的 settings 事件不应触发
const writesBeforeForeign = writes.length
emit('settings/document-updated', 'ui-chat')
await sleep(3000 + 1200)
assert.equal(writes.length, writesBeforeForeign, '非目标命名空间事件应被忽略')

// 无差异的目录变化不应产生写入
const writesBeforeNoop = writes.length
fs.writeFileSync(path.join(modelsDir, 'touch.txt'), 'y')
await sleep(3000 + 1500)
assert.equal(writes.length, writesBeforeNoop, '无差异时应保持安静（幂等）')

// 卸载后不应再有任何写入
for (const dispose of disposers) dispose()
const writesAfterDispose = writes.length
tagged = [...tagged, { name: 'thinker:later', modified_at: '4' }]
fs.writeFileSync(path.join(modelsDir, 'after-dispose.txt'), 'z')
await sleep(3000 + 1500)
assert.equal(writes.length, writesAfterDispose, 'disposer 运行后事件不得再触发写入')

server.close()
server.closeAllConnections() // 假 Ollama 的 keep-alive 会挂住事件循环，显式断开才能退出
fs.rmSync(modelsDir, { recursive: true, force: true })
console.log('  e2e: startup scan / pull event / settings-page add / echo guard / foreign ns / idempotent / dispose ✓')
console.log('OK')
// undici 的 keep-alive 池会在 server.close() 后继续挂住事件循环数十秒；
// 所有断言已完成，显式退出让 `npm test` 干净收口。
process.exit(0)
