# CloudBase 云托管 · 数据持久化

适用于把本项目部署在腾讯云 **CloudBase 云托管**（域名形如 `xxx.run.tcloudbase.com`）。

## 为什么需要这一步

云托管容器的文件系统是**临时**的：容器重启、重新部署、实例切换都会清空 `server/data/`。所以需要把数据存到 **CloudBase 云数据库**。

服务端持久化两类数据：

1. **账号**（用户名、scrypt 密码哈希、昵称）——集合 `jm_users`。
2. **用户业务数据**（简历与简历版本、岗位、岗位匹配结果与修改记录、投递材料、个人信息、待办、反馈等整份 `db`）——集合 `jm_user_data`，每个账号一条文档，按**不可变用户 ID** 绑定。

> 浏览器 localStorage 现在只作为**前端缓存**（加速首屏、离线可用），不再是唯一数据源；登录后会从云数据库加载，增删改后写回云数据库。换设备 / 清缓存 / 换浏览器后，重新登录即可恢复数据。

## 方案（可插拔存储）

- 设置环境变量 `TCB_ENV_ID` → 账号与业务数据都存入 **CloudBase 云数据库**。
- 不设置（本地开发）→ 回退到 `server/data/*.json`。

密码始终 **scrypt 加盐哈希**，库里看不到明文。云托管运行时访问云数据库的临时凭证由平台自动注入，**无需** SecretId / SecretKey。用户身份只取自登录会话（不接受前端传入的用户 ID），保证账号间严格隔离。

## 一、必须在控制台手动创建的集合（不依赖自动创建）

进入 CloudBase 控制台 → 选中环境 → 「数据库」，确认已开通文档型数据库，然后**手动创建以下集合**：

| 集合名 | 用途 | 文档主键 `_id` | 权限设置（关键） |
|--------|------|----------------|------------------|
| `jm_users` | 账号 | 规范化用户名（确定性，靠主键唯一约束防并发重复） | **仅管理端可读写** |
| `jm_user_data` | 用户业务数据（整份 db） | 用户不可变 ID（= 规范化用户名） | **仅管理端可读写** |

> 两个集合的「权限设置」都必须选 **仅管理端可读写（仅创建者及管理员可读写 / 自定义为后端专用）**。前端不直接连库，所有读写都经过后端并以登录态校验，所以前端无任何数据库权限。

## 二、复制「环境 ID」

控制台 → 「环境」→「环境 ID」（形如 `xxxx-1xxxxxxxxx`）。

## 三、在「云托管」服务配置环境变量

服务 → 版本配置 / 环境变量：

| 变量名 | 值 | 说明 |
|--------|----|----|
| `TCB_ENV_ID` | 第二步的环境 ID | **开启云持久化的开关**，必填 |
| `SESSION_SECRET` | 一段随机长字符串 | 登录态签名密钥，**必填**，否则重启后需重新登录 |
| `DEEPSEEK_API_KEY` | 你的 DeepSeek Key | AI 功能 |
| `DEEPSEEK_MODEL` / `DEEPSEEK_MODEL_PRO` | `deepseek-v4-flash` / `deepseek-v4-pro` | 可选 |
| `ALLOW_REGISTRATION` | `true` | 建好账号后可改 `false` 关闭注册 |
| `TCB_USERS_COLLECTION` / `TCB_DATA_COLLECTION` | `jm_users` / `jm_user_data` | 可选，自定义集合名（须与第一步创建的一致） |

生成 `SESSION_SECRET`：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 旧的 `APP_USERNAME` / `APP_PASSWORD` 已被多用户登录取代，可删除。

## 四、重新部署并验证

- 启动日志应出现：`账号存储模式: cloudbase(jm_users,jm_user_data)`。若显示 `file`，说明 `TCB_ENV_ID` 没生效。
- 注册一个账号 → 控制台 `jm_users` 出现一条记录（`passHash` 是哈希，不是明文）。
- 保存一份简历 / 岗位 → 控制台 `jm_user_data` 出现一条以你的用户 ID 为 `_id` 的文档。
- 「重新部署」或重启服务 → 同一账号仍能登录、数据仍在（账号与业务数据都已持久化）。
- 换一台设备 / 换浏览器 / 清空浏览器数据后重新登录 → 数据从云数据库恢复。
- 注册第二个账号 → 看不到第一个账号的任何数据（严格隔离）。

## 关于 SDK 选型（@cloudbase/node-sdk vs @cloudbase/js-sdk）

本项目服务端使用 **`@cloudbase/node-sdk`**，结论：**继续使用**。

- `@cloudbase/node-sdk` 是 CloudBase **服务端**（Node）SDK，目前**仍在持续维护**；处于维护/停更状态的是更早的 `tcb-admin-node`，二者不要混淆。云托管内用它以管理员身份访问云数据库、凭证由平台自动注入，是官方推荐的服务端用法。
- `@cloudbase/js-sdk` v3 是**Web / 客户端** SDK，面向浏览器、采用「终端用户登录 + 数据库安全规则」模型，并不适合在服务端以管理员身份统一读写所有用户的数据。
- 风险与后续：所有 CloudBase 访问已收敛在 `server/lib/auth.js` 一个文件内（`tcbDb()` 与 `getUserData` / `setUserData` / `findUser` / `createUser`）。若将来官方调整服务端 SDK，只需替换该文件的实现，接口不变，迁移成本低。

参考：
- [@cloudbase/node-sdk（npm）](https://www.npmjs.com/package/@cloudbase/node-sdk)
- [CloudBase Node SDK · 初始化文档](https://docs.cloudbase.net/en/api-reference/server/node-sdk/initialization)
- [@cloudbase/js-sdk（npm，Web 端）](https://www.npmjs.com/package/@cloudbase/js-sdk)

## 已知边界

- **简历原始文件**（上传的 docx/pdf 二进制）仍存在浏览器 IndexedDB，属设备本地，换设备需重新上传；但简历**文字内容与版本**已随 `db` 同步到云端，AI 与展示不受影响。如需原文件跨设备，可后续接入「云存储」。
- 业务数据按「整份 db 一条文档」保存，适合个人量级；CloudBase 单文档有大小上限，数据极大时再考虑按实体拆分集合。

## 安全

- 以上敏感值只填在**控制台环境变量**，不写进代码、不提交到 GitHub。
- `server/.env`、`server/data/` 已在 `.gitignore` 中。
- 两个集合权限均为「仅管理端可读写」，前端无法直接读写。
