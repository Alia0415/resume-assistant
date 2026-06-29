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
| `JOB_CRAWLER_USER_AGENT` | 岗位页面抓取使用的 User-Agent | `ResumeAssistantBot/1.0...` |
| `JOB_CRAWLER_TIMEOUT_MS` | 单次抓取超时 | `12000` |
| `JOB_CRAWLER_CACHE_TTL_MS` | 同一岗位链接抓取结果缓存时间 | `300000` |
| `JOB_BOARD_DEFAULT_LIMIT` | 职位看板默认刷新数量 | `12` |
| `JOB_BOARD_CRAWL_DETAIL_LIMIT` | 普通企业官网 Careers 页最多深抓的岗位链接数 | `6` |
| `JOB_BOARD_OFFICIAL_SOURCES` | 默认企业官网/官方 ATS 来源，一行一个或逗号分隔；前端也内置“大厂 / 券商”来源按钮 | 无 |
| `JOB_BOARD_SEARCH_PROVIDER` | 职位发现方式；默认只抓企业官方来源。可设 `bing-rss` 做调试，但不建议用于真实看板 | `official-sources` |
| `SESSION_SECRET` | 登录会话签名密钥，生产环境必须固定配置 | 进程内临时密钥 |
| `ALLOW_REGISTRATION` | 是否开放注册；建好账号后建议设为 `false` | `true` |
| `AUTH_DATA_DIR` | 本地文件账号/数据目录；容器平台应指向持久磁盘 | `server/data` |
| `TCB_ENV_ID` | CloudBase 环境 ID；设置后账号与业务数据写入云数据库 | 无 |

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
简历 × JD 匹配分析（matchScore 由服务端按维度权重汇总，仍仅供参考）。
```json
请求: { "resumeText": "...", "jdText": "...", "experienceLibraryText": "可选，用户全部经历素材" }
响应: { "matchScore":0,"matchedPoints":[],"missingPoints":[],"weakExpressions":[],
        "suggestedResumeFocus":[],"riskWarnings":[],"questionsForUser":[],
        "experienceSuggestions":[],"lessUsefulExperiences":[],
        "scoreDimensions":[],"evidenceItems":[],"authoritativeReferences":[],
        "referenceCoverage":{},"scoreBasis":{} }
```

匹配前后端会自动从 `server/lib/careerReferences.js` 的职业资料库中检索相关来源，并把命中的资料片段作为外部参照传给模型。模型负责给出维度判断和证据，服务端再按固定权重汇总 `matchScore`。
如果传入 `experienceLibraryText`，模型只会把它用于发现“当前简历之外可补充使用的真实经历素材”，结果放在 `experienceSuggestions`；对当前 JD 用处不大的经历放在 `lessUsefulExperiences`，都不会计入当前简历已匹配项。

### `GET /api/reference/search?q=...`
检索本地职业资料库，主要用于调试和后续前端预览。
```json
响应: { "references": [ { "id":"","title":"","issuer":"","url":"","summary":"" } ] }
```

### `POST /api/jobs/fetch-url`
实时抓取公开岗位页面，优先解析页面里的 schema.org `JobPosting` 结构化数据，失败时退回到正文文本抽取。
```json
请求: { "url": "https://example.com/jobs/123" }
响应: { "ok": true, "job": { "company":"","role":"","city":"","link":"","jd":"","source":"" },
        "meta": { "pageTitle":"","warnings":[] } }
```

抓取器会校验 URL，阻止内网地址，尊重 robots.txt，设置超时、页面大小上限、同域名冷却和短缓存。它不会绕过登录、验证码、付费墙或招聘网站反爬限制；抓取不到时请手动粘贴 JD。

### `POST /api/jobs/board-refresh`
职位看板刷新：从企业官网招聘页或官方 ATS 抓取真实职位，并用当前简历做快速匹配。已适配腾讯、百度、京东、美团、中信证券官网，以及 Greenhouse、Lever、Ashby；其他企业官网入口会按公开页面尽力解析。看板匹配是轻量关键词匹配，适合批量预筛；保存岗位后仍可调用 `/api/ai/match-resume` 做深度分析。
```json
请求: { "keywords":"AI Engineer", "city":"", "sourceUrls":"https://careers.tencent.com/\nhttps://careers.citics.com/", "limit":12, "resumeText":"..." }
响应: { "jobs": [ { "company":"","role":"","city":"","jd":"","link":"",
          "boardMatch": { "matchScore":82,"matchedKeywords":[],"missingKeywords":[] } } ],
        "fetchedAt": 0, "provider": "official-sources" }
```

如果没有在请求里传 `sourceUrls`，也没有配置 `JOB_BOARD_OFFICIAL_SOURCES`，接口会拒绝刷新，避免用泛搜索结果冒充企业官网职位。

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
`{ "ok": true, "hasKey": true|false, "referenceCount": 10 }` —— 前端用它判断后端、Key 与资料库是否就绪。

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
2. 在平台的环境变量里配置 `DEEPSEEK_API_KEY` 与固定的 `SESSION_SECRET`（不要写进代码或提交 `.env`）。
3. 首次部署可保留 `ALLOW_REGISTRATION=true` 注册自己的账号；账号建好后建议改为 `false`。
4. 确保账号数据可持久化：Render 可使用仓库里的 `render.yaml` 挂载 `AUTH_DATA_DIR=/var/data/resume-assistant`；CloudBase 云托管请配置 `TCB_ENV_ID` 并创建集合。
5. 启动命令 `node server/server.js`，确保前端文件在 `server/` 的上一级。

> 若前端与后端分开部署（不同域名），前端的「后端地址」可在工具的 Tweaks/属性里设置 `apiBase`，已默认开启 CORS。
