# 求职管家 · 后端（DeepSeek 安全代理）

这个后端做两件事：

1. **安全代理 DeepSeek**：前端只调用本服务的 `/api/ai/*`，DeepSeek API Key 只保存在后端环境变量里，**永远不会下发到浏览器**。
2. **托管前端**：直接把项目根目录（含 `求职管家.dc.html`、`support.js`）作为静态文件提供，单机一条命令即可运行整套工具。

---

## 一、准备

- 安装 Node.js 18+（建议 20+）。
- 在 https://platform.deepseek.com 获取你自己的 API Key。

## 二、配置与启动

```bash
cd server
cp .env.example .env        # 然后编辑 .env，填入 DEEPSEEK_API_KEY
npm install
npm start                   # 启动后访问 http://localhost:3000/求职管家.dc.html
```

`.env` 里的关键变量：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 你的 DeepSeek API Key（**必填**） | 无 |
| `DEEPSEEK_MODEL` | 默认模型 | `deepseek-v4-flash` |
| `DEEPSEEK_MODEL_PRO` | 深度改写（rewrite-resume）优先使用的模型 | `deepseek-v4-pro` |
| `PORT` | 服务端口 | `3000` |

> `.env` 已被 `.gitignore` 忽略，不会提交，也不会暴露给前端。

启动后浏览器打开 **http://localhost:3000/求职管家.dc.html** ，前端会自动调用同源的 `/api/ai/*`。

---

## 三、接口

所有接口 `POST`，请求/响应均为 JSON。AI 被严格约束：**只依据用户提供的 JD 与简历，禁止编造经历、技能、证书、公司、城市或企业反馈。**

### `POST /api/ai/analyze-jd`
解析岗位 JD，只抽取不猜测。
```json
请求: { "jdText": "..." }
响应: { "company","position","city","jobType","keywords":[],"hardRequirements":[],
        "softRequirements":[],"responsibilities":[],"preferredExperience":[],
        "deadline","applicationLink","notes" }
```

### `POST /api/ai/match-resume`
简历 × JD 匹配分析（matchScore 仅供参考）。
```json
请求: { "resumeText": "...", "jdText": "..." }
响应: { "matchScore":0,"matchedPoints":[],"missingPoints":[],"weakExpressions":[],
        "suggestedResumeFocus":[],"riskWarnings":[],"questionsForUser":[] }
```

### `POST /api/ai/rewrite-resume`
逐条改写建议（原文 / 改后 / 理由 / 是否需核实）。
```json
请求: { "resumeText":"...", "jdText":"...", "targetSection":"实习经历" }
响应: { "rewriteSuggestions":[{ "section","originalText","rewrittenText","reason","truthCheckRequired" }],
        "overallNotes":[],"questionsForUser":[] }
```

### `POST /api/ai/generate-application-note`
生成投递摘要 / 邮件 / 面试准备 / 跟进待办。
```json
请求: { "company","position","jdText","resumeText" }
响应: { "applicationSummary","emailSubject","emailBody","interviewPrep":[],"followUpTodo":[] }
```

### `GET /api/health`
`{ "ok": true, "hasKey": true|false }` —— 前端用它判断后端与 Key 是否就绪。

---

## 四、错误约定

- 未配置 Key → `400 { "error": "DeepSeek API Key 未配置，请先在后端环境变量中添加 DEEPSEEK_API_KEY。" }`
- 模型返回非 JSON → `502 { "error": "AI 返回的内容无法解析为结构化数据，请重试。" }`
- 入参为空 → `400 { "error": "缺少必填内容：..." }`
- 其它（网络/鉴权/额度）→ `{ "error": "AI 调用失败：..." }`

前端对以上都会展示明确提示，不会崩溃。

---

## 五、部署到服务器（可选）

任意支持 Node 的平台均可（自有服务器 / Render / Railway / Fly.io 等）：

1. 上传整个项目（含 `server/` 与根目录的前端文件）。
2. 在平台的环境变量里配置 `DEEPSEEK_API_KEY`（不要写进代码或提交 `.env`）。
3. 启动命令 `node server/server.js`，确保前端文件在 `server/` 的上一级。

> 若前端与后端分开部署（不同域名），前端的「后端地址」可在工具的 Tweaks/属性里设置 `apiBase`，已默认开启 CORS。
