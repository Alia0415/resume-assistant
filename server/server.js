'use strict';

/**
 * 简历投递工具后端
 * ------------------------------------------------------------
 * - 安全代理 DeepSeek：前端只调用本服务的 /api/ai/*，永远看不到 API Key。
 * - 同时托管前端静态文件（项目根目录），方便单机一键运行。
 * - 所有 AI 接口：校验入参、try/catch、强制 JSON、对非 JSON / 无 Key 做明确兜底。
 * - AI 被严格约束：只能依据用户提供的 JD 与简历，禁止编造经历/技能/证书/公司/反馈。
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { callDeepSeekJSON } = require('./lib/deepseek');
const auth = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST;
const PRO_MODEL = process.env.DEEPSEEK_MODEL_PRO; // 可选：深度改写用的更强模型
const ALLOW_REGISTRATION = String(process.env.ALLOW_REGISTRATION || 'true').toLowerCase() !== 'false';

app.use(cors());
app.use(express.json({ limit: '4mb' })); // 放宽以容纳整份用户数据（/api/data）

// ============================================================
// 账号认证（多用户：注册 / 登录 / 退出）
// 登录态用 HttpOnly 签名 Cookie 保持；密码用 scrypt 加盐哈希存储。
// 以下 /api/auth/* 与 /api/health 公开，放在登录门禁之前。
// ============================================================
const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/;

app.post('/api/auth/register', async (req, res) => {
  if (!ALLOW_REGISTRATION) return res.status(403).json({ error: '当前未开放注册，请联系管理员。' });
  const { username, password, displayName } = req.body || {};
  const name = String(username || '').trim();
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: '用户名需为 2–32 位字母、数字或 _ . - 组合。' });
  if (typeof password !== 'string' || password.length < 6) return res.status(400).json({ error: '密码至少 6 位。' });
  try {
    const user = await auth.createUser(name, password, displayName);
    auth.setAuthCookies(req, res, user);
    return res.json({ ok: true, user: { username: user.username, displayName: user.displayName } });
  } catch (err) {
    if (err && err.code === 'DUP_USER') return res.status(409).json({ error: '该用户名已被注册。' });
    console.error('[AUTH register]', err && err.message);
    return res.status(500).json({ error: '注册失败：' + ((err && err.message) || '服务器内部错误') });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = await auth.findUser(username);
    if (!user) {
      return res.status(404).json({ error: '该账号还没有注册，请先切换到「注册」。', code: 'NO_SUCH_USER' });
    }
    if (!auth.verifyPassword(password || '', user.passHash)) {
      return res.status(401).json({ error: '密码错误，请重新输入。', code: 'BAD_PASSWORD' });
    }
    auth.setAuthCookies(req, res, user);
    return res.json({ ok: true, user: { username: user.username, displayName: user.displayName } });
  } catch (err) {
    console.error('[AUTH login]', err && err.message);
    return res.status(500).json({ error: '登录失败：' + ((err && err.message) || '服务器内部错误') });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearAuthCookies(res);
  return res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = auth.getSession(req);
  if (!session) return res.json({ authenticated: false });
  return res.json({ authenticated: true, username: session.u });
});

// 健康检查：前端可用它判断后端与 Key 是否就绪
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: !!(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) });
});

// ---------- 登录门禁：保护前端页面与所有 AI 接口 ----------
const PUBLIC_PATHS = new Set(['/login.html', '/favicon.ico']);
function requireAuth(req, res, next) {
  let p = req.path;
  try { p = decodeURIComponent(req.path); } catch (e) {}
  if (PUBLIC_PATHS.has(p)) return next();
  const session = auth.getSession(req);
  if (session) { req.user = session; return next(); }
  if (p.startsWith('/api/')) return res.status(401).json({ error: '未登录或登录已过期，请重新登录。', code: 'UNAUTH' });
  return res.redirect(302, '/login.html');
}
app.use(requireAuth);

app.get('/', (req, res) => {
  res.redirect(302, encodeURI('/求职管家.dc.html'));
});

// 托管前端：项目根目录（server 的上一级），包含 求职管家.dc.html 与 support.js
app.use(express.static(path.join(__dirname, '..')));

// ============================================================
// 用户业务数据读写（简历 / 岗位 / 匹配 / 投递材料等整份 db）
// 用户身份只取自登录会话（req.user.uid），绝不接受前端传入的用户 ID，确保严格隔离。
// ============================================================
app.get('/api/data', async (req, res) => {
  const uid = req.user && req.user.uid;
  if (!uid) return res.status(401).json({ error: '未登录或登录已过期，请重新登录。', code: 'UNAUTH' });
  try {
    const rec = await auth.getUserData(uid);
    return res.json({ data: (rec && rec.data) || null, updatedAt: (rec && rec.updatedAt) || 0, revision: (rec && rec.revision) || 0 });
  } catch (err) {
    console.error('[DATA get]', err && err.message);
    return res.status(500).json({ error: '读取数据失败：' + ((err && err.message) || '服务器内部错误') });
  }
});

// 用 baseRevision 做乐观锁：云端 revision 变了就返回 409，前端必须先同步再保存，禁止直接覆盖。
app.put('/api/data', async (req, res) => {
  const uid = req.user && req.user.uid;
  if (!uid) return res.status(401).json({ error: '未登录或登录已过期，请重新登录。', code: 'UNAUTH' });
  const data = req.body && req.body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: '数据格式不正确。' });
  }
  const baseRevision = req.body && req.body.baseRevision;
  try {
    const updatedAt = Number(data._updatedAt) || Date.now();
    const out = await auth.setUserData(uid, data, baseRevision, updatedAt);
    return res.json({ ok: true, updatedAt: out.updatedAt, revision: out.revision });
  } catch (err) {
    if (err && err.code === 'REVISION_CONFLICT') {
      const cur = err.current || {};
      return res.status(409).json({ error: '数据已在其他地方更新，请同步后再保存。', code: 'REVISION_CONFLICT', data: cur.data || null, updatedAt: cur.updatedAt || 0, revision: cur.revision || 0 });
    }
    console.error('[DATA put]', err && err.message);
    return res.status(500).json({ error: '保存数据失败：' + ((err && err.message) || '服务器内部错误') });
  }
});

// ============================================================
// 简历原文件上传 / 下载 / 删除（CloudBase 云存储 / 本地 fallback）
// 身份只取自会话；下载与删除都校验文件归属当前账号，按 uid 隔离。
// ============================================================
app.post('/api/files', express.raw({ type: () => true, limit: '12mb' }), async (req, res) => {
  const uid = req.user && req.user.uid;
  if (!uid) return res.status(401).json({ error: '未登录或登录已过期，请重新登录。', code: 'UNAUTH' });
  let fileName = '';
  try { fileName = decodeURIComponent(req.headers['x-filename'] || ''); } catch (e) { fileName = req.headers['x-filename'] || ''; }
  if (!fileName) return res.status(400).json({ error: '缺少文件名。' });
  const buffer = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buffer || !buffer.length) return res.status(400).json({ error: '文件内容为空。' });
  try {
    const meta = await auth.saveResumeFile(uid, fileName, buffer);
    return res.json({ ok: true, file: meta });
  } catch (err) {
    if (err && (err.code === 'BAD_TYPE' || err.code === 'TOO_LARGE' || err.code === 'BAD_FILE')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[FILE upload]', err && err.message);
    return res.status(500).json({ error: '文件上传失败：' + ((err && err.message) || '服务器内部错误') });
  }
});

app.get('/api/files/:fileId', async (req, res) => {
  const uid = req.user && req.user.uid;
  if (!uid) return res.status(401).json({ error: '未登录或登录已过期，请重新登录。', code: 'UNAUTH' });
  try {
    const meta = await auth.getFileMeta(req.params.fileId);
    if (!meta) return res.status(404).json({ error: '文件不存在。' });
    if (String(meta.uid) !== String(uid)) return res.status(403).json({ error: '无权访问该文件。' });
    const out = await auth.getResumeFileDownload(meta);
    if (out.url) return res.redirect(302, out.url);
    res.setHeader('Content-Type', out.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(out.fileName || 'resume'));
    return res.send(out.buffer);
  } catch (err) {
    console.error('[FILE download]', err && err.message);
    return res.status(500).json({ error: '文件下载失败：' + ((err && err.message) || '服务器内部错误') });
  }
});

app.delete('/api/files/:fileId', async (req, res) => {
  const uid = req.user && req.user.uid;
  if (!uid) return res.status(401).json({ error: '未登录或登录已过期，请重新登录。', code: 'UNAUTH' });
  try {
    const meta = await auth.getFileMeta(req.params.fileId);
    if (!meta) return res.json({ ok: true }); // 已不存在视为成功
    if (String(meta.uid) !== String(uid)) return res.status(403).json({ error: '无权删除该文件。' });
    await auth.deleteResumeFile(meta);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[FILE delete]', err && err.message);
    return res.status(500).json({ error: '文件删除失败：' + ((err && err.message) || '服务器内部错误') });
  }
});

// ---------- 工具：统一错误处理 ----------
function handleError(res, err) {
  // 缺少 API Key —— 返回需求规定的明确文案
  if (err && err.code === 'NO_API_KEY') {
    return res.status(400).json({
      error: 'DeepSeek API Key 未配置，请先在后端环境变量中添加 DEEPSEEK_API_KEY。',
    });
  }
  // 模型返回非 JSON
  if (err && err.code === 'BAD_JSON') {
    return res.status(502).json({
      error: 'AI 返回的内容无法解析为结构化数据，请重试。',
    });
  }
  if (err && err.status === 401) {
    return res.status(401).json({
      error: 'AI 鉴权失败：DeepSeek API Key 无效。请在部署环境变量中重新填写 DEEPSEEK_API_KEY。',
    });
  }
  if (err && err.status === 402) {
    return res.status(402).json({
      error: 'AI 调用失败：DeepSeek 账户余额不足，请检查 DeepSeek 控制台余额。',
    });
  }
  // DeepSeek SDK / 网络 / 鉴权等错误
  const status = (err && err.status) || 500;
  const msg = (err && err.message) || '服务器内部错误';
  console.error('[AI ERROR]', status, msg);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    error: 'AI 调用失败：' + msg,
  });
}

// 入参非空校验
function requireText(value, fieldLabel, res) {
  if (typeof value !== 'string' || value.trim() === '') {
    res.status(400).json({ error: '缺少必填内容：' + fieldLabel });
    return false;
  }
  return true;
}

const ANTI_FABRICATION =
  '严禁编造、补全或夸大用户未明确提供的任何信息，包括但不限于：学校、专业、实习、项目、技能、证书、工作成果、数字、公司、城市、投递结果或企业反馈。' +
  '凡是用户资料里没有的内容，绝不能凭空写出。只输出一个 JSON 对象，不要输出任何多余文字或解释。';

// ============================================================
// 一、解析岗位 JD —— 只抽取，不猜测
// POST /api/ai/analyze-jd  { jdText }
// ============================================================
app.post('/api/ai/analyze-jd', async (req, res) => {
  try {
    const { jdText } = req.body || {};
    if (!requireText(jdText, '岗位 JD（jdText）', res)) return;

    const messages = [
      {
        role: 'system',
        content:
          '你是岗位 JD 信息抽取助手。' + ANTI_FABRICATION +
          '只能依据用户提供的 JD 原文进行抽取，禁止猜测公司、城市、截止时间、投递链接等未在原文出现的信息。缺失字段必须返回空字符串 "" 或空数组 []。',
      },
      {
        role: 'user',
        content:
          '请从下面的岗位 JD 原文中抽取结构化信息，并以 JSON 输出，字段固定为：' +
          '{ "company": "", "position": "", "city": "", "jobType": "", "keywords": [], ' +
          '"hardRequirements": [], "softRequirements": [], "responsibilities": [], ' +
          '"preferredExperience": [], "deadline": "", "applicationLink": "", "notes": "" }。' +
          '\nkeywords 为最关键的技能/能力词（5-12个）；hardRequirements 为硬性任职要求；softRequirements 为软性/加分项要求。' +
          '\n如果某字段在原文中找不到依据，请返回空字符串或空数组，不要编造。' +
          '\n\nJD 原文：\n' + jdText,
      },
    ];
    const data = await callDeepSeekJSON(messages, { temperature: 0.1 });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================
// 二、简历与 JD 匹配分析
// POST /api/ai/match-resume  { resumeText, jdText }
// ============================================================
app.post('/api/ai/match-resume', async (req, res) => {
  try {
    const { resumeText, jdText } = req.body || {};
    if (!requireText(resumeText, '简历文本（resumeText）', res)) return;
    if (!requireText(jdText, '岗位 JD（jdText）', res)) return;

    const messages = [
      {
        role: 'system',
        content:
          '你是严谨的简历匹配顾问。' + ANTI_FABRICATION +
          'matchScore 仅作辅助参考，不是绝对评分，不要包装成权威分数。' +
          '必须区分“来自简历的内容”和“来自 JD 的要求”。' +
          '当简历信息不足以判断时，把需要用户补充的问题放进 questionsForUser，绝不替用户编造。',
      },
      {
        role: 'user',
        content:
          '请基于【我的简历文本】与【岗位 JD】做匹配分析，并以 JSON 输出，字段固定为：' +
          '{ "matchScore": 0, "matchedPoints": [], "missingPoints": [], "weakExpressions": [], ' +
          '"suggestedResumeFocus": [], "riskWarnings": [], "questionsForUser": [] }。' +
          '\nmatchScore 为 0-100 的整数参考值；matchedPoints 为简历中已满足 JD 的点；' +
          'missingPoints 为 JD 要求但简历缺失的点；weakExpressions 为简历中表达偏弱、可加强的句子；' +
          'suggestedResumeFocus 为针对该岗位建议突出的方向；riskWarnings 为可能的风险（如经历不符、跨行等）；' +
          'questionsForUser 为信息不足、需要我补充真实信息的问题。' +
          '\n\n【我的简历文本】\n' + resumeText +
          '\n\n【岗位 JD】\n' + jdText,
      },
    ];
    const data = await callDeepSeekJSON(messages, { temperature: 0.2 });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================
// 三、简历改写建议（保留真实性，逐条原文/改后/理由）
// POST /api/ai/rewrite-resume  { resumeText, jdText, targetSection }
// ============================================================
app.post('/api/ai/rewrite-resume', async (req, res) => {
  try {
    const { resumeText, jdText, targetSection, userNotes } = req.body || {};
    if (!requireText(resumeText, '简历文本（resumeText）', res)) return;
    if (!requireText(jdText, '岗位 JD（jdText）', res)) return;
    const section = (typeof targetSection === 'string' && targetSection.trim()) || '全部';
    const supplement = (typeof userNotes === 'string' && userNotes.trim()) ? userNotes.trim() : '';

    const messages = [
      {
        role: 'system',
        content:
          '你是严谨的简历改写顾问。' + ANTI_FABRICATION +
          '改写必须保留真实性：只能基于简历已有事实、以及用户在【补充确认】中提供的真实信息来优化措辞、结构与针对性，绝不新增这两者之外的经历、技能或数字。' +
          '用户在【补充确认】里提供的信息视为真实，应尽量自然地融入到对应模块的改写中。' +
          '不要整篇重写，不要输出空泛套话；只改最值得改的原文句子。每条建议必须能说明它如何更贴合 JD、更具体、更简洁、更便于 HR/ATS 扫读。' +
          '如果原文定位不稳、事实依据不足、或改后只是同义替换，请不要强行给建议，改为放进 questionsForUser 或 overallNotes。' +
          '若某处需要真实数据而简历与补充均未提供，请在 rewrittenText 中用 [请补充具体数据] 占位，并把 truthCheckRequired 设为 true。' +
          '凡涉及无法从简历或补充确认确认的信息，truthCheckRequired 必须为 true。',
      },
      {
        role: 'user',
        content:
          '请针对简历的「' + section + '」部分，结合岗位 JD 给出改写建议，并以 JSON 输出，字段固定为：' +
          '{ "rewriteSuggestions": [ { "section": "", "originalText": "", "rewrittenText": "", "reason": "", "truthCheckRequired": true, "qualityScore": 4, "confidence": 0.8, "impact": "", "qualityChecks": { "jdFit": 4, "specificity": 4, "truthSafety": 5, "readability": 4 } } ], ' +
          '"overallNotes": [], "questionsForUser": [ { "question": "", "type": "yesno", "detailOnYes": false, "detailHint": "" } ] }。' +
          '\n每条建议必须给出：对应模块 section、简历中的原文 originalText（务必从【原简历文本】中逐字摘录真实句子，便于自动替换）、改写后 rewrittenText、修改理由 reason、是否需要核实真实性 truthCheckRequired。' +
          '\nqualityScore 为 1-5 的整体质量分，低于 4 的建议原则上不要输出；confidence 为 0-1，表示原文定位与事实依据的可信度；impact 用一句话说明对该岗位的提升点。' +
          '\nqualityChecks 逐项 1-5：jdFit=贴合 JD，specificity=具体/量化，truthSafety=真实性安全，readability=简洁可扫读。' +
          '\noverallNotes 为整体注意事项。' +
          '\nquestionsForUser 为仍需用户补充真实信息的问题（如果用户的补充已覆盖，可减少或不再追问），每条是一个对象，目标是让用户用最少的输入就能回答：' +
          'question 为问题原文；type 取 "yesno"（用户只需选「是 / 否」）或 "text"（需要用户填一句话）；' +
          'detailOnYes 仅对 yesno 有意义——若回答「是」后还需要用户补充链接或简短说明（例如“是否发表过文章 / 做过相关项目 / 有作品可展示”），设为 true，否则 false；' +
          'detailHint 为需要补充时输入框的示例提示（如“粘贴文章或项目链接”）。能用是/否问清楚的就用 yesno，不要滥用 text。给出 2-5 条 rewriteSuggestions。' +
          (supplement ? ('\n\n【用户补充的真实信息（来自补充确认，视为真实，请据此改写）】\n' + supplement) : '') +
          '\n\n【原简历文本】\n' + resumeText +
          '\n\n【岗位 JD】\n' + jdText,
      },
    ];
    // 深度改写优先使用 Pro 模型（如已配置）。maxTokens 给足，避免结合补充信息后输出被截断导致 JSON 解析失败。
    const data = await callDeepSeekJSON(messages, {
      temperature: 0.35,
      maxTokens: 4096,
      model: PRO_MODEL || undefined,
    });
    if (data && Array.isArray(data.rewriteSuggestions)) {
      data.rewriteSuggestions = data.rewriteSuggestions.map(s => {
        const score = Math.max(1, Math.min(5, Number(s && s.qualityScore) || 3));
        const confidence = Math.max(0, Math.min(1, Number(s && s.confidence) || 0));
        const checks = (s && typeof s.qualityChecks === 'object' && s.qualityChecks) || {};
        return Object.assign({}, s, {
          qualityScore: score,
          confidence,
          qualityChecks: {
            jdFit: Math.max(1, Math.min(5, Number(checks.jdFit) || score)),
            specificity: Math.max(1, Math.min(5, Number(checks.specificity) || score)),
            truthSafety: Math.max(1, Math.min(5, Number(checks.truthSafety) || (s && s.truthCheckRequired ? 3 : score))),
            readability: Math.max(1, Math.min(5, Number(checks.readability) || score))
          }
        });
      });
    }
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================
// 四、润色用户补充说明（只整理表达，不新增事实）
// POST /api/ai/polish-confirmation-notes  { userNotes, questions, resumeText, jdText }
// ============================================================
app.post('/api/ai/polish-confirmation-notes', async (req, res) => {
  try {
    const { userNotes, questions } = req.body || {};
    if (!requireText(userNotes, '补充说明（userNotes）', res)) return;

    const questionText = Array.isArray(questions)
      ? questions.map((q) => (typeof q === 'string' ? q : (q && q.question) || '')).filter(Boolean).join('\n')
      : '';
    const messages = [
      {
        role: 'system',
        content:
          '你是严谨的求职材料润色助手。' + ANTI_FABRICATION +
          '你的任务只是润色用户写出的这段补充说明本身，让它表达更清晰、专业、通顺，适合后续写进简历或投递材料。' +
          '只能调整措辞、语序、标点和分点排版，必须完整保留用户提供的每一条事实信息，不得增加、删除或改写任何经历、技能、证书、公司、数据、结果或时间，也不得引入用户这段文字之外的任何内容。' +
          '如果用户补充说明里信息不足或需要核实，请保留谨慎表达，必要时用 [请补充/核实...] 占位。只输出一个 JSON 对象。',
      },
      {
        role: 'user',
        content:
          '请只润色下面这段【用户补充说明】的文字表达，并以 JSON 输出，字段固定为：' +
          '{ "polishedText": "", "truthCheckWarnings": [], "questionsForUser": [] }。' +
          '\npolishedText 是润色后的补充说明，必须与原文表达同样的事实、不增不减，可以分点；truthCheckWarnings 写这段说明里需要用户核实的风险；questionsForUser 写还需要用户补充的问题。' +
          '\n\n【AI 提出的问题（仅供理解上下文，不要写进 polishedText）】\n' + (questionText || '（无）') +
          '\n\n【用户补充说明】\n' + userNotes,
      },
    ];
    const data = await callDeepSeekJSON(messages, { temperature: 0.25, maxTokens: 1400 });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

// ============================================================
// 五、生成投递材料（投递摘要 + 邮件 + 面试准备 + 跟进待办）
// POST /api/ai/generate-application-note  { company, position, jdText, resumeText }
// ============================================================
app.post('/api/ai/generate-application-note', async (req, res) => {
  try {
    const { company, position, jdText, resumeText } = req.body || {};
    if (!requireText(resumeText, '简历文本（resumeText）', res)) return;
    if (!requireText(jdText, '岗位 JD（jdText）', res)) return;

    const messages = [
      {
        role: 'system',
        content:
          '你是求职助手，帮助撰写实习/校招投递材料。' + ANTI_FABRICATION +
          '邮件要自然、礼貌、简洁，适合实习投递；只能基于简历真实经历，不得夸大；不得生成任何虚假的投递状态或企业反馈。',
      },
      {
        role: 'user',
        content:
          '请基于以下信息生成投递材料，以 JSON 输出，字段固定为：' +
          '{ "applicationSummary": "", "emailSubject": "", "emailBody": "", "interviewPrep": [], "followUpTodo": [] }。' +
          '\napplicationSummary 为一句话投递定位；emailSubject 为投递邮件标题；emailBody 为完整邮件正文（含称呼与落款占位）；' +
          'interviewPrep 为基于简历真实经历的面试准备要点；followUpTodo 为投递后的跟进待办。' +
          '\n公司：' + (company || '（未提供）') +
          '\n岗位：' + (position || '（未提供）') +
          '\n\n【岗位 JD】\n' + jdText +
          '\n\n【我的简历文本】\n' + resumeText,
      },
    ];
    const data = await callDeepSeekJSON(messages, { temperature: 0.4, maxTokens: 2200 });
    res.json(data);
  } catch (err) {
    handleError(res, err);
  }
});

const listenArgs = HOST ? [PORT, HOST] : [PORT];
app.listen(...listenArgs, () => {
  console.log('求职管家后端已启动: http://' + (HOST || 'localhost') + ':' + PORT);
  console.log('账号存储模式: ' + auth.storeMode());
  if (auth.storeMode() === 'file') {
    console.warn('⚠ 账号存储为本地文件 AUTH_DATA_DIR/users.json 或 server/data/users.json：在未挂载持久磁盘的云托管 / 容器环境重启或重新部署后会丢失。线上请配置 AUTH_DATA_DIR 指向持久磁盘，或设置 TCB_ENV_ID 启用 CloudBase 云数据库持久化。');
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('⚠ 未检测到 DEEPSEEK_API_KEY，AI 接口会返回未配置错误。请在 server/.env 中填写。');
  }
  if (auth.usingEphemeralSecret()) {
    console.warn('⚠ 未配置 SESSION_SECRET，已使用进程内临时密钥：重启后所有登录态会失效。生产环境请在 CloudBase 环境变量设置 SESSION_SECRET。');
  }
});
