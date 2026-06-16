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
