# 求职管家

个人使用的简历投递助手网页，包含前端页面和 Node/Express 后端。后端负责代理 DeepSeek API，真实 API Key 只应保存在本地或服务器环境变量中，不能提交到 GitHub。

## 项目结构

- `求职管家.dc.html`：前端主页面
- `support.js`：前端辅助脚本
- `server/`：Node/Express 后端
- `server/lib/deepseek.js`：DeepSeek API 调用封装
- `server/.env.example`：环境变量示例文件

## 本地启动

```powershell
cd server
copy .env.example .env
npm install
npm start
```

复制 `.env.example` 后，请只在本地 `server/.env` 中填写 `DEEPSEEK_API_KEY`。`.env` 已被 `.gitignore` 忽略，不应提交到仓库。

启动后访问：

```text
http://localhost:3000/求职管家.dc.html
```

## 安全说明

- 不要把真实 DeepSeek API Key 写入前端 HTML、JS、README 或服务端代码。
- 不要提交 `server/.env`、`.env`、`.env.local` 或 `server/.env.local`。
- 不要提交 `node_modules/`、`dist/`、`build/` 或运行时上传文件。

## 部署到公网

推荐部署为一个 Node Web Service，让 Express 同时提供前端页面和 `/api/ai/*` 后端接口。本仓库已包含 `render.yaml`，可用于 Render Blueprint。

Render 环境变量至少需要配置：

- `DEEPSEEK_API_KEY`：你的真实 DeepSeek API Key
- `SESSION_SECRET`：一段随机长字符串，用于保持登录态稳定
- `ALLOW_REGISTRATION`：是否开放注册，建好账号后建议改为 `false`

不要把以上值写进代码或提交到 GitHub。公网部署现在使用应用内多用户注册 / 登录；创建好自己的账号后，建议把 `ALLOW_REGISTRATION=false`，避免陌生人注册并消耗你的 DeepSeek 额度。

如果部署到 Render，`render.yaml` 已配置 `AUTH_DATA_DIR=/var/data/resume-assistant` 和持久磁盘，用来保存本地文件模式下的账号与业务数据。其它容器平台也需要挂载持久目录，或按 `deploy/tencent-cloud/cloudbase-persistence.md` 配置 CloudBase 云数据库。

如果手动创建 Web Service：

- Root Directory: `server`
- Build Command: `npm ci`
- Start Command: `npm start`
- Node Version: `20`

腾讯云轻量应用服务器 / CVM 部署请看：

```text
deploy/tencent-cloud/README.md
```
