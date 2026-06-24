'use strict';

/**
 * 多用户认证模块（零额外依赖）
 * ------------------------------------------------------------
 * - 账号存储：AUTH_DATA_DIR/users.json 或 server/data/users.json（已被 .gitignore 忽略，不进仓库）。
 * - 密码哈希：Node 内置 crypto.scrypt + 随机盐，绝不明文保存。
 * - 会话：无状态 HMAC 签名 token，存放在 HttpOnly Cookie 里；
 *   签名密钥来自环境变量 SESSION_SECRET（未配置则用进程内临时密钥并告警）。
 * - 另写可被前端读取的 jm_uid / jm_user Cookie（非凭证），
 *   方便前端按账号隔离本地数据、显示昵称。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve((process.env.AUTH_DATA_DIR || '').trim() || path.join(__dirname, '..', 'data'));
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const SESSION_COOKIE = 'jm_session';
const USER_ID_COOKIE = 'jm_uid';
const USER_COOKIE = 'jm_user';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ---------- 签名密钥 ----------
let _ephemeralSecret = null;
function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.trim()) return s.trim();
  if (!_ephemeralSecret) _ephemeralSecret = crypto.randomBytes(32).toString('hex');
  return _ephemeralSecret;
}
function usingEphemeralSecret() {
  return !(process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim());
}

// ---------- 用户存储（可插拔） ----------
// 线上（腾讯云 CloudBase 云托管）：设置环境变量 TCB_ENV_ID = CloudBase 环境 ID，
//   账号与用户业务数据都持久化到「云数据库」，容器重启 / 重新部署 / 换设备都不会丢。
// 本地开发：不设置 TCB_ENV_ID 时回退到 server/data/*.json（已被 .gitignore 忽略）。
// 注意：集合不会自动创建，需先在 CloudBase 控制台手动创建并设置权限
//       （见 deploy/tencent-cloud/cloudbase-persistence.md）。
const TCB_ENV_ID = (process.env.TCB_ENV_ID || '').trim();
const USE_TCB = !!TCB_ENV_ID;
const TCB_COLLECTION = (process.env.TCB_USERS_COLLECTION || 'jm_users').trim(); // 账号
const TCB_DATA_COLLECTION = (process.env.TCB_DATA_COLLECTION || 'jm_user_data').trim(); // 用户业务数据
const TCB_FILES_COLLECTION = (process.env.TCB_FILES_COLLECTION || 'jm_files').trim(); // 简历原文件元数据
const USERDATA_FILE = path.join(DATA_DIR, 'userdata.json');
const FILESMETA_FILE = path.join(DATA_DIR, 'filesmeta.json');
const FILES_DIR = path.join(DATA_DIR, 'files'); // 本地 fallback 的原文件目录（已被 .gitignore 忽略）

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 单个简历文件上限 10MB
const ALLOWED_EXT = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
// 用户业务数据只允许项目实际使用的顶层字段，避免原样保存任意 JSON。
const DATA_FIELDS = {
  profile: 'object', resumes: 'array', versions: 'array', jobs: 'array',
  analyses: 'object', applications: 'array', feedback: 'array', todos: 'array',
};

function storeMode() {
  return USE_TCB ? 'cloudbase(' + TCB_COLLECTION + ',' + TCB_DATA_COLLECTION + ')' : 'file';
}

function normUsername(u) {
  return String(u || '').trim().toLowerCase();
}
function isDuplicateError(e) {
  const s = ((e && (e.code || e.message)) || '').toString().toLowerCase();
  return s.includes('duplicate') || s.includes('already') || s.includes('exist') || s.includes('conflict');
}

// -- CloudBase（云托管运行时凭证由平台自动注入，无需 SecretId/Key） --
let _tcbApp = null;
function tcbApp() {
  if (!_tcbApp) {
    const tcb = require('@cloudbase/node-sdk');
    _tcbApp = tcb.init({ env: TCB_ENV_ID });
  }
  return _tcbApp;
}
function tcbDb() {
  return tcbApp().database();
}

// -- 本地 JSON 文件实现 --
function loadUsers() {
  try {
    const arr = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}
function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function loadUserDataMap() {
  try {
    const obj = JSON.parse(fs.readFileSync(USERDATA_FILE, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    return {};
  }
}
function saveUserDataMap(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(USERDATA_FILE, JSON.stringify(map, null, 2));
}

// ---------- 账号查询 ----------
function normalizeUserRecord(user, fallbackUsername) {
  if (!user || typeof user !== 'object') return null;
  const username = normUsername(user.username || fallbackUsername || user.uid || user.id || user._id);
  const uid = normUsername(user.uid || user.id || user._id || username);
  const id = uid || username;
  if (!id) return Object.assign({}, user);
  return Object.assign({}, user, {
    id: id,
    uid: id,
    username: username || id,
    displayName: user.displayName || user.username || username || id,
  });
}

async function findUser(username) {
  const key = normUsername(username);
  if (USE_TCB) {
    const res = await tcbDb().collection(TCB_COLLECTION).where({ username: key }).limit(1).get();
    return normalizeUserRecord((res && res.data && res.data[0]) || null, key);
  }
  return normalizeUserRecord(loadUsers().find((u) => u.username === key) || null, key);
}

function idSafe(uid) {
  return String(uid).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// ---------- 数据结构清洗：只保留项目实际使用的顶层字段，绝不原样保存任意 JSON ----------
function sanitizeUserData(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const k of Object.keys(DATA_FIELDS)) {
    const want = DATA_FIELDS[k];
    const v = input[k];
    if (want === 'array' && Array.isArray(v)) out[k] = v;
    else if (want === 'object' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = v;
  }
  if (typeof input._updatedAt === 'number') out._updatedAt = input._updatedAt;
  return out;
}

// ---------- 用户业务数据（按不可变 uid 绑定，整份 db 存为一条文档，带 revision 乐观锁） ----------
async function getUserData(uid) {
  if (!uid) return null;
  const id = String(uid);
  if (USE_TCB) {
    const res = await tcbDb().collection(TCB_DATA_COLLECTION).doc(id).get();
    const doc = res && res.data && res.data[0];
    return doc ? { data: doc.data || null, updatedAt: doc.updatedAt || 0, revision: doc.revision || 0 } : null;
  }
  const map = loadUserDataMap();
  return map[id] || null;
}
function tcbUpdatedCount(r) {
  if (!r) return 0;
  if (typeof r.updated === 'number') return r.updated;
  if (r.stats && typeof r.stats.updated === 'number') return r.stats.updated;
  return 0;
}
function revisionConflict(current) {
  const err = new Error('数据已在别处更新，请刷新后再保存');
  err.code = 'REVISION_CONFLICT';
  err.current = current;
  return err;
}
// 原子的 Compare-and-Set：只有云端 revision 仍等于 baseRevision 时才更新；revision 自增与数据写入
// 在数据库内同一原子操作完成。并发的相同 base 请求只有一个成功，另一个抛 REVISION_CONFLICT（409）。
async function setUserData(uid, data, baseRevision, updatedAt) {
  if (!uid) throw new Error('缺少用户标识');
  const id = String(uid);
  const at = Number(updatedAt) || Date.now();
  const clean = sanitizeUserData(data);
  const base = baseRevision == null ? null : Number(baseRevision);

  if (USE_TCB) {
    const coll = tcbDb().collection(TCB_DATA_COLLECTION);
    if (base != null) {
      // 条件原子更新：仅当该 _id 文档当前 revision === base 时命中并自增（MongoDB 单文档原子）。
      const r = await coll.where({ _id: id, revision: base }).update({ data: clean, updatedAt: at, revision: base + 1 });
      if (tcbUpdatedCount(r) >= 1) return { updatedAt: at, revision: base + 1 };
      // 未命中：文档不存在（仅 base===0 合法新建）或 revision 已变。
      if (base === 0) {
        try {
          await coll.add({ _id: id, uid: id, data: clean, updatedAt: at, revision: 1 }); // _id 唯一约束 → 原子防并发重复创建
          return { updatedAt: at, revision: 1 };
        } catch (e) {
          throw revisionConflict(await getUserData(id)); // 并发已创建 / 已存在 → 冲突
        }
      }
      throw revisionConflict(await getUserData(id));
    }
    // 无 baseRevision（少见，仅兜底）：读当前后写入。
    const cur0 = await getUserData(id);
    const rev0 = ((cur0 && cur0.revision) || 0) + 1;
    await coll.doc(id).set({ uid: id, data: clean, updatedAt: at, revision: rev0 });
    return { updatedAt: at, revision: rev0 };
  }

  // 本地文件后端：同步「读-校验-写」（中间无 await）→ 单进程内原子，并发同 base 仅一个成功。
  const map = loadUserDataMap();
  const cur = map[id];
  const currentRev = (cur && cur.revision) || 0;
  if (base != null && base !== currentRev) throw revisionConflict(cur || null);
  const nextRev = currentRev + 1;
  map[id] = { uid: id, data: clean, updatedAt: at, revision: nextRev };
  saveUserDataMap(map);
  return { updatedAt: at, revision: nextRev };
}

// ---------- 简历原文件：CloudBase 云存储 / 本地 fallback；元数据存 jm_files，按 uid 隔离 ----------
function loadFilesMeta() {
  try { const o = JSON.parse(fs.readFileSync(FILESMETA_FILE, 'utf8')); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
}
function saveFilesMeta(map) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILESMETA_FILE, JSON.stringify(map, null, 2));
}
function allowedExt(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return ALLOWED_EXT[ext] ? ext : null;
}
// 上传：buffer 为文件字节。校验类型/大小，存储并写元数据，返回给前端的安全字段（不含内部 cloudFileID/localPath）。
async function saveResumeFile(uid, fileName, buffer) {
  if (!uid) throw new Error('缺少用户标识');
  const ext = allowedExt(fileName);
  if (!ext) { const e = new Error('仅支持 Word .docx 文件'); e.code = 'BAD_TYPE'; throw e; }
  if (!buffer || !buffer.length) { const e = new Error('文件为空'); e.code = 'BAD_FILE'; throw e; }
  if (buffer.length > MAX_FILE_BYTES) { const e = new Error('文件超过 10MB 限制'); e.code = 'TOO_LARGE'; throw e; }
  const fileId = crypto.randomBytes(12).toString('hex');
  const meta = {
    fileId: fileId, uid: String(uid), fileName: String(fileName).slice(0, 200),
    mime: ALLOWED_EXT[ext], ext: ext, size: buffer.length, uploadedAt: Date.now(),
  };
  if (USE_TCB) {
    const r = await tcbApp().uploadFile({ cloudPath: 'resumes/' + idSafe(uid) + '/' + fileId + '.' + ext, fileContent: buffer });
    meta.cloudFileID = (r && r.fileID) || '';
    try {
      await tcbDb().collection(TCB_FILES_COLLECTION).doc(fileId).set(meta);
    } catch (e) {
      // 元数据写入失败 → 回滚已上传的云文件，避免留下没有元数据的孤儿文件。
      if (meta.cloudFileID) { try { await tcbApp().deleteFile({ fileList: [meta.cloudFileID] }); } catch (_) {} }
      throw e;
    }
  } else {
    const dir = path.join(FILES_DIR, idSafe(uid));
    fs.mkdirSync(dir, { recursive: true });
    meta.localPath = path.join(dir, fileId + '.' + ext);
    fs.writeFileSync(meta.localPath, buffer);
    try {
      const map = loadFilesMeta(); map[fileId] = meta; saveFilesMeta(map);
    } catch (e) {
      try { fs.unlinkSync(meta.localPath); } catch (_) {} // 回滚已写入的本地文件
      throw e;
    }
  }
  return { fileId: meta.fileId, fileName: meta.fileName, mime: meta.mime, size: meta.size, uploadedAt: meta.uploadedAt };
}
async function getFileMeta(fileId) {
  const id = String(fileId || '');
  if (!id) return null;
  if (USE_TCB) {
    const res = await tcbDb().collection(TCB_FILES_COLLECTION).doc(id).get();
    return (res && res.data && res.data[0]) || null;
  }
  return loadFilesMeta()[id] || null;
}
// 取下载方式：云端返回临时 URL，本地返回字节。调用方必须先校验 meta.uid === 登录 uid。
async function getResumeFileDownload(meta) {
  if (USE_TCB) {
    const r = await tcbApp().getTempFileURL({ fileList: [meta.cloudFileID] });
    const item = r && r.fileList && r.fileList[0];
    if (!item || !item.tempFileURL) throw new Error('获取下载地址失败');
    return { url: item.tempFileURL };
  }
  return { buffer: fs.readFileSync(meta.localPath), mime: meta.mime, fileName: meta.fileName };
}
function isNotFoundError(e) {
  const s = ((e && (e.code || e.message)) || '').toString().toLowerCase();
  return (s.includes('not') && s.includes('exist')) || s.includes('nonexist') || s.includes('notfound') || s.includes('404');
}
// 先删文件、再删元数据：文件不存在视为已删除；文件删除真失败则保留元数据并抛错（可重试，不静默忽略）。
async function deleteResumeFile(meta) {
  if (!meta) return; // 重复删除 / 已不存在 → 安全返回
  if (USE_TCB) {
    if (meta.cloudFileID) {
      let fileErr = null;
      try {
        const r = await tcbApp().deleteFile({ fileList: [meta.cloudFileID] });
        const item = r && r.fileList && r.fileList[0];
        const code = item && item.code;
        if (code && String(code).toUpperCase() !== 'SUCCESS' && !isNotFoundError({ code: code })) {
          fileErr = new Error('云存储删除失败：' + code);
        }
      } catch (e) {
        if (!isNotFoundError(e)) fileErr = e; // 文件本就不存在 → 视为已删除
      }
      if (fileErr) {
        console.error('[FILE delete] 云文件删除失败，已保留元数据待重试 fileId=' + meta.fileId + '：' + fileErr.message);
        throw fileErr; // 不静默忽略；元数据保留，调用方可重试
      }
    }
    try { await tcbDb().collection(TCB_FILES_COLLECTION).doc(meta.fileId).remove(); } catch (e) {}
  } else {
    if (meta.localPath) {
      try {
        fs.unlinkSync(meta.localPath);
      } catch (e) {
        if (e.code !== 'ENOENT') { // ENOENT = 文件已不存在，继续清元数据；其它错误则保留元数据待重试
          console.error('[FILE delete] 本地文件删除失败，已保留元数据待重试 fileId=' + meta.fileId + '：' + e.message);
          throw e;
        }
      }
    }
    const map = loadFilesMeta(); delete map[meta.fileId]; saveFilesMeta(map);
  }
}

// ---------- 密码哈希（scrypt + 盐，恒定时间比较） ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  let known;
  try {
    known = Buffer.from(hash, 'hex');
  } catch (e) {
    return false;
  }
  const test = crypto.scryptSync(String(password), salt, 64);
  if (known.length !== test.length) return false;
  return crypto.timingSafeEqual(known, test);
}

// ---------- 创建账号 ----------
// 不可变用户 ID（id / uid）= 规范化用户名；CloudBase 侧用它作为文档 _id，
// 借主键唯一约束在并发下也不会产生重复账号（确定性 ID + 原子写入）。
async function createUser(username, password, displayName) {
  const key = normUsername(username);
  const user = {
    id: key,
    uid: key,
    username: key,
    displayName: String(displayName || username).trim() || key,
    passHash: hashPassword(password),
    createdAt: Date.now(),
  };
  if (USE_TCB) {
    if (await findUser(key)) {
      const err = new Error('该用户名已被注册'); err.code = 'DUP_USER'; throw err;
    }
    try {
      await tcbDb().collection(TCB_COLLECTION).add({ _id: key, ...user });
    } catch (e) {
      // _id 主键冲突说明并发下已被别的请求抢先创建
      if (isDuplicateError(e) || (await findUser(key))) {
        const err = new Error('该用户名已被注册'); err.code = 'DUP_USER'; throw err;
      }
      throw e;
    }
    return user;
  }
  const users = loadUsers();
  if (users.some((u) => u.username === key)) {
    const err = new Error('该用户名已被注册'); err.code = 'DUP_USER'; throw err;
  }
  users.push(user);
  saveUsers(users);
  return user;
}

// ---------- 无状态会话 token ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s, 'base64').toString('utf8');
}
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', getSecret()).update(body).digest());
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', getSecret()).update(body).digest());
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
function createSession(user) {
  const rec = normalizeUserRecord(user);
  if (!rec || !rec.uid) throw new Error('无法创建登录会话：缺少用户标识');
  return signToken({ uid: rec.uid, u: rec.username, exp: Date.now() + SESSION_TTL_MS });
}

// ---------- Cookie 工具 ----------
function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      try {
        out[k] = decodeURIComponent(v);
      } catch (e) {
        out[k] = v;
      }
    }
  });
  return out;
}
function isSecure(req) {
  if (req.secure) return true;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}
function setAuthCookies(req, res, user) {
  const rec = normalizeUserRecord(user);
  if (!rec || !rec.uid) throw new Error('无法设置登录 Cookie：缺少用户标识');
  const opts = {
    path: '/',
    maxAge: SESSION_TTL_MS,
    sameSite: 'lax',
    secure: isSecure(req),
  };
  res.cookie(SESSION_COOKIE, createSession(rec), Object.assign({ httpOnly: true }, opts));
  res.cookie(USER_ID_COOKIE, rec.uid, Object.assign({ httpOnly: false }, opts));
  res.cookie(USER_COOKIE, rec.displayName || rec.username, Object.assign({ httpOnly: false }, opts));
}
function clearAuthCookies(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(USER_ID_COOKIE, { path: '/' });
  res.clearCookie(USER_COOKIE, { path: '/' });
}
function getSession(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[SESSION_COOKIE]);
}

module.exports = {
  SESSION_COOKIE,
  USER_ID_COOKIE,
  USER_COOKIE,
  USERS_FILE,
  getSecret,
  usingEphemeralSecret,
  storeMode,
  loadUsers,
  normalizeUserRecord,
  findUser,
  createUser,
  getUserData,
  setUserData,
  sanitizeUserData,
  saveResumeFile,
  getFileMeta,
  getResumeFileDownload,
  deleteResumeFile,
  verifyPassword,
  createSession,
  setAuthCookies,
  clearAuthCookies,
  getSession,
};
