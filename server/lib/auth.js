'use strict';

/**
 * 多用户认证模块（零额外依赖）
 * ------------------------------------------------------------
 * - 账号存储：server/data/users.json（已被 .gitignore 忽略，不进仓库）。
 * - 密码哈希：Node 内置 crypto.scrypt + 随机盐，绝不明文保存。
 * - 会话：无状态 HMAC 签名 token，存放在 HttpOnly Cookie 里；
 *   签名密钥来自环境变量 SESSION_SECRET（未配置则用进程内临时密钥并告警）。
 * - 另写一个可被前端读取的 jm_user Cookie（仅含用户名，非凭证），
 *   方便前端按账号隔离本地数据、显示昵称。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const SESSION_COOKIE = 'jm_session';
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
const USERDATA_FILE = path.join(DATA_DIR, 'userdata.json');

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

// -- CloudBase 云数据库（云托管运行时凭证由平台自动注入，无需 SecretId/Key） --
let _tcbApp = null;
function tcbDb() {
  if (!_tcbApp) {
    const tcb = require('@cloudbase/node-sdk');
    _tcbApp = tcb.init({ env: TCB_ENV_ID });
  }
  return _tcbApp.database();
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
async function findUser(username) {
  const key = normUsername(username);
  if (USE_TCB) {
    const res = await tcbDb().collection(TCB_COLLECTION).where({ username: key }).limit(1).get();
    return (res && res.data && res.data[0]) || null;
  }
  return loadUsers().find((u) => u.username === key) || null;
}

// ---------- 用户业务数据（按不可变 uid 绑定，整份 db 存为一条文档） ----------
async function getUserData(uid) {
  if (!uid) return null;
  const id = String(uid);
  if (USE_TCB) {
    const res = await tcbDb().collection(TCB_DATA_COLLECTION).doc(id).get();
    const doc = res && res.data && res.data[0];
    return doc ? { data: doc.data || null, updatedAt: doc.updatedAt || 0 } : null;
  }
  const map = loadUserDataMap();
  return map[id] || null;
}
async function setUserData(uid, data, updatedAt) {
  if (!uid) throw new Error('缺少用户标识');
  const id = String(uid);
  const at = Number(updatedAt) || Date.now();
  if (USE_TCB) {
    // doc(id).set 为按 _id 的 upsert：存在则整份替换，不存在则创建。
    await tcbDb().collection(TCB_DATA_COLLECTION).doc(id).set({ uid: id, data: data, updatedAt: at });
    return { updatedAt: at };
  }
  const map = loadUserDataMap();
  map[id] = { data: data, updatedAt: at };
  saveUserDataMap(map);
  return { updatedAt: at };
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
  return signToken({ uid: user.id, u: user.username, exp: Date.now() + SESSION_TTL_MS });
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
  const opts = {
    path: '/',
    maxAge: SESSION_TTL_MS,
    sameSite: 'lax',
    secure: isSecure(req),
  };
  res.cookie(SESSION_COOKIE, createSession(user), Object.assign({ httpOnly: true }, opts));
  res.cookie(USER_COOKIE, user.displayName || user.username, Object.assign({ httpOnly: false }, opts));
}
function clearAuthCookies(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(USER_COOKIE, { path: '/' });
}
function getSession(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[SESSION_COOKIE]);
}

module.exports = {
  SESSION_COOKIE,
  USER_COOKIE,
  USERS_FILE,
  getSecret,
  usingEphemeralSecret,
  storeMode,
  loadUsers,
  findUser,
  createUser,
  getUserData,
  setUserData,
  verifyPassword,
  createSession,
  setAuthCookies,
  clearAuthCookies,
  getSession,
};
