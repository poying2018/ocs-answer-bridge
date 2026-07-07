# OCS AI Proxy

一个部署在 [Cloudflare Workers](https://workers.cloudflare.com/) 上的 OCS（Open College Study，[ocsjs/ocsjs](https://github.com/ocsjs/ocsjs)）网课答题代理。它在 OCS 客户端与任意 OpenAI 兼容的 AI API 之间充当中转层，并配套 D1 题库缓存、题型自适应格式化与网页端请求调试模板。

> **核心功能来源声明**：本项目的核心中转思路（将 OCS `AnswererWrapper` 的 GET 请求转发到 OpenAI Chat Completions 兼容 API）源自 **[uucz/ocs-ai-proxy](https://github.com/uucz/ocs-ai-proxy/blob/main/README.md)**。本仓库在其基础上进行了以下增强：
>
> - 引入 **Cloudflare D1** 作为持久化题库缓存，命中缓存直接返回，避免对相同题目重复消耗 API 额度；
> - **题型自适应格式化**：单选题给出选项与内容、多选题强制列出全部正确选项、判断题仅答「正确/错误」、论述题不分 A/B/C/D 点；
> - **多选题完整性兜底**：当题目含多选信号词但首答仅返回一个选项时，自动以强调指令重试一次；
> - 选择题答案超长时自动压缩为选项字母，适配 OCS 端显示；
> - 提供 **网页端请求模板**（`request-template.html`），无需后端即可手动构造请求、查看缓存命中状态、健康检查与缓存统计。

## 特性

- 兼容任意 OpenAI Chat Completions 格式的服务（OpenAI / DeepSeek / Moonshot / 硅基流动 / 小米 `mimo` 等），仅需修改 `API_BASE`；
- D1 缓存闭环（查询 → 未命中调模型 → 写回），重复题目零额度消耗；
- 跨域友好：响应携带 `Access-Control-Allow-Origin: *`，前端可直接 `fetch` 调用；
- 轻量：单文件 `worker.js`，无构建步骤；
- 附带 `/health` 健康检查与 `/stats` 缓存统计端点。

## 工作原理

```
OCS 客户端 (AnswererWrapper)
   │  GET /?key=...&title=...&options=...
   ▼
Cloudflare Worker (worker.js)
   ├─ 鉴权 (AUTH_KEY)
   ├─ 查 D1 缓存 (title + options 唯一键)
   │     ├─ 命中 → 直接返回 answer, source:"cache"
   │     └─ 未命中 → 调用 AI API
   │            ├─ 多选兜底重试（如需）
   │            ├─ 答案格式化 / 超长压缩
   │            └─ 写回 D1 → 返回 answer, source:"ai"
   ▼
OCS 客户端解析 res.answer
```

## 目录结构

```
ocs-ai-proxy/
├── worker.js            # Cloudflare Worker 主程序（核心逻辑）
├── wrangler.toml        # Wrangler 部署配置（含 D1 绑定与明文变量）
├── schema.sql           # D1 建表语句
├── deploy.ps1           # 一键部署脚本（PowerShell，需 Windows + wrangler）
├── request-template.html# 网页端请求调试模板（浏览器直接打开）
├── ocs-config.json      # OCS 客户端 AnswererWrapper 配置示例
├── .gitignore
└── README.md
```

## 环境变量

| 变量名 | 说明 | 是否加密 | 默认值 |
|--------|------|----------|--------|
| `API_KEY` | 上游 AI 服务的 API Key | ✅ 必须加密（`wrangler secret put`） | — |
| `API_BASE` | API 基础地址 | 否（`[vars]`） | `https://api.siliconflow.cn` |
| `MODEL` | 模型名称 | 否（`[vars]`） | `deepseek-ai/DeepSeek-V3` |
| `AUTH_KEY` | 访问鉴权 Key（OCS 配置中作为参数传入） | ✅ 建议加密 | — |
| `SYSTEM_PROMPT` | 系统提示词（控制答题格式） | 否 | 内置题型自适应提示词 |
| `DB` | D1 数据库绑定（由 `wrangler.toml` 声明） | — | — |

> 自定义域名需在 Cloudflare Dashboard 手动绑定到本 Worker（中国用户无法访问 `*.workers.dev`）。

## 部署

### 方式一：Wrangler CLI

```bash
# 1. 安装 wrangler 并登录
npm install -g wrangler
wrangler login

# 2. 创建 D1 数据库，并将返回的 database_id 填入 wrangler.toml
wrangler d1 create ocs

# 3. 初始化表
wrangler d1 execute ocs --remote --file=schema.sql

# 4. 设置加密变量
wrangler secret put API_KEY
wrangler secret put AUTH_KEY

# 5. 部署
wrangler deploy
```

### 方式二：一键部署脚本（Windows PowerShell）

```powershell
.\deploy.ps1 -CFToken "你的Cloudflare_API_Token" -ApiKey "你的AI_API_Key" -AuthKey "你的AUTH_KEY"
```

> `deploy.ps1` 中的 `ApiKey` / `AuthKey` 默认值仅为占位符，请通过参数显式传入真实值，切勿将真实密钥提交到仓库。

### 方式三：Cloudflare Dashboard

将 `worker.js` 内容粘贴进 Worker 编辑器，并在 Settings → Variables 中配置上述环境变量与 D1 绑定。

## OCS 客户端配置

将以下 JSON 填入 OCS 题库设置（AnswererWrapper）。将 `<YOUR_DOMAIN>` 与 `<YOUR_AUTH_KEY>` 替换为你的值：

```json
[
  {
    "name": "AI 答题",
    "url": "https://<YOUR_DOMAIN>/?key=<YOUR_AUTH_KEY>&title=${title}&options=${options}",
    "method": "get",
    "type": "fetch",
    "handler": "return (res)=> res.answer ? [undefined, res.answer] : undefined"
  }
]
```

也可直接复制 `ocs-config.json` 使用。

## 网页端请求模板

浏览器直接打开 `request-template.html`：

- 填写 **API 地址** 与 **鉴权 Key**（对应 Worker 的 `API_BASE` 域名与 `AUTH_KEY`）；
- 输入 **题目** 与（可选）**选项**，实时生成可复制的请求 URL；
- 点击「发送请求」查看答案与 `source` 徽章（命中缓存 / 模型生成）；
- 「健康检查」「缓存统计」按钮用于快速排查。

## 请求参数

Worker 接受以下 GET 参数：

| 参数 | 说明 |
|------|------|
| `key` | 鉴权 Key，需与 `AUTH_KEY` 一致（未配置 `AUTH_KEY` 时留空放行） |
| `title` | 题目内容（必填） |
| `options` | 选项内容，换行分隔（选填；留空即纯问答） |

返回 `application/json`：`{ "answer": "...", "source": "cache" | "ai" }`。

## License

[MIT](https://github.com/uucz/ocs-ai-proxy/blob/main/README.md) — 本项目沿用原项目 MIT 许可。
