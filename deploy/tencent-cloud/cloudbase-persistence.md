# CloudBase 云托管 · 账号数据持久化

适用于把本项目部署在腾讯云 **CloudBase 云托管**（域名形如 `xxx.run.tcloudbase.com`）。

## 为什么需要这一步

- 简历 / 岗位 / 匹配分析等**用户数据保存在浏览器本地**（localStorage，按账号隔离），换设备不互通，但同一浏览器重新部署也不会丢。
- **唯一保存在服务端的是「账号」**（用户名、密码哈希、昵称）。
- 云托管容器的文件系统是**临时**的：容器重启、重新部署、实例切换都会清空 `server/data/`。
- 因此账号必须存到**云数据库**，否则重新部署后已注册账号会消失。

## 方案

后端账号存储是可插拔的：

- 设置环境变量 `TCB_ENV_ID` → 账号存入 **CloudBase 云数据库**集合（默认 `jm_users`），持久化、重启不丢。
- 不设置（本地开发）→ 回退到 `server/data/users.json`。

密码始终以 **scrypt 加盐哈希**保存，云数据库里也看不到明文。
在云托管运行时，访问云数据库的临时凭证由平台自动注入，**无需** SecretId / SecretKey。

## 你需要在腾讯云控制台做的配置

1. **确认环境已开通「云数据库」**
   - 进入 CloudBase 控制台 → 选中你的环境 → 「数据库」。若未开通则开通（文档型数据库）。

2. **复制「环境 ID」**
   - 控制台 → 「环境」→ 「环境 ID」（形如 `xxxx-1xxxxxxxxx`）。下一步要用。

3. **（可选）手动创建集合**
   - 集合名 `jm_users`。不创建也行——后端首次注册时会尝试自动创建。
   - 集合「权限设置」建议选 **仅管理端可读写**（前端不直接连库，只有后端访问）。

4. **在「云托管」服务里配置环境变量**（服务 → 版本配置 / 环境变量）：

   | 变量名 | 值 | 说明 |
   |--------|----|----|
   | `TCB_ENV_ID` | 第 2 步的环境 ID | **开启持久化的开关**，必填 |
   | `SESSION_SECRET` | 一段随机长字符串 | 登录态签名密钥，**必填**，否则重启后需重新登录 |
   | `DEEPSEEK_API_KEY` | 你的 DeepSeek Key | AI 功能 |
   | `DEEPSEEK_MODEL` | `deepseek-v4-flash` | 可选 |
   | `DEEPSEEK_MODEL_PRO` | `deepseek-v4-pro` | 可选 |
   | `ALLOW_REGISTRATION` | `true` | 建好账号后可改 `false` 关闭注册 |
   | `TCB_USERS_COLLECTION` | `jm_users` | 可选，自定义集合名 |

   生成 `SESSION_SECRET`：
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   > 注意：不要再用旧的 `APP_USERNAME` / `APP_PASSWORD`（已被多用户登录取代，可删除）。

5. **重新部署 / 发布新版本。**

## 验证

- 启动日志应出现：`账号存储模式: cloudbase(jm_users)`。若显示 `file`，说明 `TCB_ENV_ID` 没生效。
- 打开站点 → 注册一个账号 → 控制台「数据库 → jm_users」里能看到一条记录（`passHash` 是哈希，不是明文）。
- 在云托管「重新部署」或重启服务 → 用同一账号仍能登录 → 账号已持久化。
- 注册第二个账号 → 两个账号各自的简历/岗位数据互不可见（按账号隔离，键为 `jm_data_v1::<昵称>`）。

## 安全

- 以上值只填在**控制台环境变量**里，不要写进代码、不要提交到 GitHub。
- `server/.env`、`server/data/` 已在 `.gitignore` 中，不会进仓库。
- 集合权限设为「仅管理端可读写」，前端无法直接读写账号库。
