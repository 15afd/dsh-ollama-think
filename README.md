# dsh-ollama-think

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：让本地 Ollama 模型**自动获得推理等级选项**。事件驱动，零定时轮询，零第三方依赖。

## 背景：为什么需要它

dsh 的模型选择器只给声明了 `reasoningEfforts` 的模型显示推理等级（off/low/medium/high），而底层适配器 `dsh-llm-pi-ai` 没有全局开关——**逐模型声明**。对云端目录无所谓，但对本地 Ollama：你每 `ollama pull` 一个新模型，都得手改 profile 的 `cordis.patch.yml` 才能选等级。

这个插件把整件事自动化了。

## 它做什么

- **问 Ollama 本身**哪些模型会推理：`GET /api/tags` 列模型，`POST /api/show` 看顶层 `capabilities` 是否含 `thinking`（Ollama 对推理模型如实上报）。
- 在 `llm-pi-ai` 配置里找到 `baseURL` 指向该 Ollama（默认 `localhost:11434`）的路由。
- 有差异时，经 dsh 宿主设置服务的**正规写路径**（`ctx.settings.mutate`，「模型」设置页同一条通道，带 revision 冲突检测、只写字面量）把 `reasoningEfforts` 补写进 profile 配置：
  - 会 thinking 且不在路由列表里的模型 → 自动追加；
  - 在列表里但缺等级的 → 补上 `off/low/medium/high`；
  - **你手动改过的任何形状 → 永不触碰；只增不删。**
- `dsh-llm-pi-ai` 监听配置热重载：**写入后下一轮对话即生效，不用重启 dsh**。

## 触发时机（无轮询，空闲零开销）

| 时机 | 说明 |
|---|---|
| dsh 启动 | 约 5 秒后扫一次；失败则退避重试（10s/30s/60s/2min/5min 共 5 次，成功即永不再跑）——照顾 Ollama 比 dsh 慢启动的情形 |
| `ollama pull` / `rm` | `fs.watch` 模型目录（默认 `~/.ollama/models`，尊重 `$OLLAMA_MODELS`），OS 内核投递事件，防抖 3 秒后重扫一次 |

除此之外没有任何定时器、没有任何后台请求。

## 安装

前提（两条，都是常见姿势）：

1. dsh ≥ 0.1.x（自带 `dsh-llm-pi-ai` 适配器），并且其中已有一条指向本机 Ollama 的路由：`api: openai-completions` + `baseURL: http://localhost:11434/v1`（「模型」设置页或 profile 的 `cordis.patch.yml` 手写皆可——绝大多数用过本地模型的用户已经有了）；
2. 本机跑着 Ollama（默认端口 11434）。若你两者都没有：先按 1 配好路由再装本插件——找不到匹配路由时本插件安静无操作，不会写任何东西。

```bash
# 方式 A：从 GitHub 直装（https 形式，不需要配 SSH key）
dsh plugin --profile desktop add git+https://github.com/<你的用户名>/dsh-ollama-think.git

#   （已配好 GitHub SSH 的用户也可以用简写：github:<你的用户名>/dsh-ollama-think）

# 方式 B：发布到 npm 后
dsh plugin --profile desktop add dsh-ollama-think

# 方式 C：源码本地试用
dsh plugin --profile desktop add link:/绝对路径/dsh-ollama-think
```

> 装完若终端提示 `allowBuilds`，那是 pnpm 拦构建脚本的通用提醒——本插件没有任何构建脚本，正常不会出现。

装完**重启 dsh 一次**挂载插件；此后 `ollama pull` 任何带思考能力的新模型，几秒内自动出现在选择器里并带推理等级，无需再重启。

> profile 名按你的实际情况替换（桌面端默认 `desktop`）。插件自带的 bundle patch 会自动把自己 insert 进配置树，无需手写任何 YAML。

### 验证装好了

任选其一：

- 重启后跑 `ollama pull qwen3:0.6b`（或任意 thinking 模型），约 10 秒内在 dsh「模型」选择器里看到它且带推理等级；
- 看 profile 的 `cordis.patch.yml`：ollama 路由下的模型条目多出 `reasoningEfforts` 块；
- 宿主日志出现一行 `ollama-think: reasoningEfforts synced ...`。

## 配置（可选，全部有合理默认）

在 profile 的 `cordis.patch.yml` 里加同 id 条目覆盖：

```yaml
- id: ollama-think
  name: dsh-ollama-think
  config:
    ollamaBaseUrl: http://127.0.0.1:11434  # 探测端点 + 路由匹配
    ollamaModelsDir: D:\ollama-models      # 监听目录；默认 $OLLAMA_MODELS 或 ~/.ollama/models
    routeId: ollama-local                  # 点名 llm-pi-ai 路由键，跳过 baseURL 匹配
    settingsNs: llm-pi-ai                  # 被写的配置命名空间
    autoAddMissing: false                  # 只补等级、不自动追加新模型（默认 true）
    enabled: false                         # 空转整个插件（默认 true）
```

## 已知边界

- 补的等级词汇固定 `off/low/medium/high`，线上走默认 OpenAI 式 `reasoning_effort` 参数。个别模型（常见于部分 qwen3 系）要靠 `enable_thinking` 才生效时，手动给该模型加 `compat.thinkingFormat: qwen` 即可——插件见等级已存在就不再触碰。
- 若你的 Ollama 的 OpenAI 兼容层完全忽略 `reasoning_effort`，选择器会出现等级但实际思考长度不变；这是模型/版本侧行为，与本插件无关。
- 只认 `dsh-llm-pi-ai` 适配器（`api: openai-completions` 的 Ollama 路由）；如果你把 Ollama 挂在了别的 LLM 适配器下，告诉我，欢迎提 issue。

## 开发

```bash
node --check index.js          # 语法
npm run check
```

核心是纯函数 `computeNextModels(models, facts, autoAddMissing)`（幂等、只增不删），仓库内测试用假 Ollama + 忠实复刻 cordis `ctx.effect` 语义的宿主桩做端到端验证。

## License

MIT
