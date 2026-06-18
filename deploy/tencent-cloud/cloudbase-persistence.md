# CloudBase 云托管 · 数据持久化

适用于把本项目部署在腾讯云 **CloudBase 云托管**（域名形如 `xxx.run.tcloudbase.com`）。

## 为什么需要这一步

云托管容器的文件系统是**临时**的：容器重启、重新部署、实例切换都会清空 `server/data/`。所以需要把数据存到 **CloudBase 云数据库 + 云存储**。

服务端持久化三类数据：

1. **账号**（用户名、scrypt 密码哈希、昵称）——云数据库集合 `jm_users`。
2. **用户业务数据**（简历文字与版本、岗位、岗位匹配结果与修改记录、投递材料、个人信息、待办、反馈等整份 `db`）——云数据库集合 `jm_user_data`，每账号一条文档，按**不可变用户 ID** 绑定，带 `revision` 乐观锁。
3. **简历原文件**（PDF / DOC / DOCX 本体）——**云存储**，路径按 `resumes/<uid>/<fileId>` 隔离；其元数据（fileId、原文件名、MIME、大小、上传时间、归属 uid）存云数据库集合 `jm_files`。

> 浏览器 localStorage / IndexedDB 现在只作为**前端缓存**（加速、离线可用），不再是唯一数据源。换设备 / 清缓存 / 换浏览器后重新登录即可从云端恢复简历文字、岗位、分析结果与原始简历文件。

## 安全与隔离要点

- 密码始终 **scrypt 加盐哈希**，库里无明文。
- 云托管运行时访问云数据库 / 云存储的临时凭证由平台**自动注入**，无需 SecretId / SecretKey，前端永远拿不到管理端凭证。
- 所有读写的用户身份只取自**登录会话**（不接受前端传入的用户 ID）；文件下载 / 删除都校验归属当前账号。
- 简历原文件只允许 **PDF / DOC / DOCX**，单文件上限 **10MB**。
- `/api/data` 有请求体上限，且后端只保存项目实际使用的字段（白名单），不会原样保存任意 JSON。
- 数据保存用 `revision` 乐观锁，且是**原子 Compare-and-Set**：云端用「带 `revision` 条件的原子更新 + `_id` 唯一约束」实现，并发的相同 `baseRevision` 请求只有一个成功，其余返回 409；前端不直接覆盖，改为同步最新版本。

## 一、必须在控制台手动创建的集合（不依赖自动创建）

进入 CloudBase 控制台 → 选中环境 → 「数据库」，确认已开通文档型数据库，然后**手动创建以下集合**：

| 集合名 | 用途 | 文档主键 `_id` | 权限设置（关键） |
|--------|------|----------------|------------------|
| `jm_users` | 账号 | 规范化用户名（确定性，主键唯一约束防并发重复） | **仅管理端可读写** |
| `jm_user_data` | 用户业务数据（整份 db） | 用户不可变 ID（= 规范化用户名） | **仅管理端可读写** |
| `jm_files` | 简历原文件元数据 | fileId | **仅管理端可读写** |

> 三个集合的「权限设置」都必须选 **仅管理端可读写**。前端不直接连库 / 连存储，所有读写都经过后端并以登录态校验。

## 二、开通云存储

控制台 → 选中环境 → 「存储」，确认已开通**云存储**（用于保存简历原文件）。无需手动建目录，后端会按 `resumes/<uid>/` 写入。建议存储默认权限同样保持**仅管理端可读写**（前端通过后端鉴权后下载，不直接访问存储）。

## 三、复制「环境 ID」

控制台 → 「环境」→「环境 ID」（形如 `xxxx-1xxxxxxxxx`）。

## 四、在「云托管」服务配置环境变量

| 变量名 | 值 | 说明 |
|--------|----|----|
| `TCB_ENV_ID` | 第三步的环境 ID | **开启云持久化的开关**，必填 |
| `SESSION_SECRET` | 一段随机长字符串 | 登录态签名密钥，**必填**，否则重启后需重新登录 |
| `DEEPSEEK_API_KEY` | 你的 DeepSeek Key | AI 功能 |
| `DEEPSEEK_MODEL` / `DEEPSEEK_MODEL_PRO` | `deepseek-v4-flash` / `deepseek-v4-pro` | 可选 |
| `ALLOW_REGISTRATION` | `true` | 建好账号后可改 `false` 关闭注册 |
| `TCB_USERS_COLLECTION` / `TCB_DATA_COLLECTION` / `TCB_FILES_COLLECTION` | `jm_users` / `jm_user_data` / `jm_files` | 可选，自定义集合名（须与第一步一致） |

生成 `SESSION_SECRET`：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> 旧的 `APP_USERNAME` / `APP_PASSWORD` 已被多用户登录取代，可删除。

重新部署后，启动日志应出现：`账号存储模式: cloudbase(jm_users,jm_user_data)`。若显示 `file`，说明 `TCB_ENV_ID` 没生效。

## 测试说明：本地 vs 云端（务必区分）

本仓库的自动化 / 手动测试分两类，**不能混为一谈**：

- **本地服务端持久化测试**：未设置 `TCB_ENV_ID` 时，后端走「本地文件后端」（`server/data/*.json` + `server/data/files/`）。它与云端**共用同一套接口和同步逻辑**，因此能验证：注册 / 登录 / 退出、账号与业务数据隔离、整库同步、清空 localStorage 后从服务端恢复、revision 409、字段白名单、文件上传/下载/删除与归属校验。**但它跑在本地磁盘上，不能证明 CloudBase 云数据库 / 云存储本身可用。**
- **CloudBase 真实环境集成测试**：必须在云托管运行时（凭证由平台注入）才能跑通真正的云数据库 / 云存储读写。**只有完成下面的清单，才能说“云端验证通过”。**

## CloudBase 真实环境验证清单（部署后执行）

1. 控制台手动创建 `jm_users`、`jm_user_data`、`jm_files`，权限均设为**仅管理端可读写**；开通**云存储**。
2. 配置 `TCB_ENV_ID`、`SESSION_SECRET` 及其它必要环境变量，重新部署。
3. 启动日志显示 `账号存储模式: cloudbase(jm_users,jm_user_data)`。
4. 注册一个账号，并上传一份简历原文件（PDF/DOC/DOCX）——云存储 `resumes/<uid>/` 下出现文件，`jm_files` 出现对应元数据。
5. 保存岗位与匹配数据——`jm_user_data` 出现以你的用户 ID 为 `_id` 的文档（`passHash` 不出现在此集合；账号在 `jm_users`）。
6. 在云托管「重新部署」或重启服务，用同一账号重新登录。
7. 清空浏览器 localStorage 与 IndexedDB（开发者工具 → Application → Clear storage）。
8. 确认简历文字、岗位、分析结果都恢复；点击下载能从云存储取回**原始简历文件**。
9. 用第二个账号登录，确认**无法读取、下载或删除**第一个账号的任何数据 / 文件。
10. 查看云端运行日志，确认没有数据库、权限或存储相关错误。

## 关于 SDK 选型（@cloudbase/node-sdk vs @cloudbase/js-sdk）

本项目服务端使用 **`@cloudbase/node-sdk`**，结论：**继续使用**。

- `@cloudbase/node-sdk` 是 CloudBase **服务端**（Node）SDK，目前**仍在持续维护**；处于维护/停更状态的是更早的 `tcb-admin-node`，二者不要混淆。云托管内用它以管理员身份访问云数据库与云存储、凭证由平台自动注入，是官方推荐的服务端用法。
- `@cloudbase/js-sdk` v3 是 **Web / 客户端** SDK，面向浏览器、采用「终端用户登录 + 安全规则」模型，不适合在服务端以管理员身份统一读写所有用户的数据与文件。
- 风险与后续：所有 CloudBase 访问已收敛在 `server/lib/auth.js`（`tcbApp()` / `tcbDb()` 及账号、数据、文件相关函数）。若将来官方调整服务端 SDK，只需替换该文件实现，接口不变，迁移成本低。

参考：
- [@cloudbase/node-sdk（npm）](https://www.npmjs.com/package/@cloudbase/node-sdk)
- [CloudBase Node SDK · 初始化文档](https://docs.cloudbase.net/en/api-reference/server/node-sdk/initialization)
- [@cloudbase/js-sdk（npm，Web 端）](https://www.npmjs.com/package/@cloudbase/js-sdk)

## 已知边界

- 业务数据按「整份 db 一条文档」保存，适合个人量级；CloudBase 单文档有大小上限，数据极大时再考虑按实体拆分集合。
- 简历原文件已支持云存储跨设备恢复；IndexedDB 仅作本机缓存，命中则秒开，未命中则回源云存储。

## 安全

- 以上敏感值只填在**控制台环境变量**，不写进代码、不提交到 GitHub。
- `server/.env`、`server/data/`（含本地 fallback 的 `files/`、`*.json`）已在 `.gitignore` 中。
- 三个集合与云存储权限均为「仅管理端可读写」，前端无法直接读写。
