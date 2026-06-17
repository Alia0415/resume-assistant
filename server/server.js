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
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { callDeepSeekJSON } = require('./lib/deepseek');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST;
const PRO_MODEL = process.env.DEEPSEEK_MODEL_PRO; // 可选：深度改写用的更强模型

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Optional public-deploy protection. Set APP_USERNAME and APP_PASSWORD in the
// hosting platform to require browser Basic Auth for all pages and APIs.
function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireBasicAuth(req, res, next) {
  const expectedUser = process.env.APP_USERNAME;
  const expectedPass = process.env.APP_PASSWORD;
  if (!expectedUser || !expectedPass) return next();

  const header = req.headers.authorization || '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (match) {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : '';
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (constantTimeEqual(user, expectedUser) && constantTimeEqual(pass, expectedPass)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Resume Assistant"');
  return res.status(401).send('Authentication required');
}

app.use(requireBasicAuth);

app.get('/', (req, res) => {
  res.redirect(302, encodeURI('/求职管家.dc.html'));
});

// 托管前端：项目根目录（server 的上一级），包含 求职管家.dc.html 与 support.js
app.use(express.static(path.join(__dirname, '..')));

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
    const { resumeText, jdText, targetSection } = req.body || {};
    if (!requireText(resumeText, '简历文本（resumeText）', res)) return;
    if (!requireText(jdText, '岗位 JD（jdText）', res)) return;
    const section = (typeof targetSection === 'string' && targetSection.trim()) || '全部';

    const messages = [
      {
        role: 'system',
        content:
          '你是严谨的简历改写顾问。' + ANTI_FABRICATION +
          '改写必须保留真实性：只能基于简历已有事实优化措辞、结构与针对性，绝不新增用户没有提供过的经历、技能或数字。' +
          '若某处需要真实数据而简历未提供，请在 rewrittenText 中用 [请补充具体数据] 占位，并把 truthCheckRequired 设为 true。' +
          '凡涉及无法从简历确认的信息，truthCheckRequired 必须为 true。',
      },
      {
        role: 'user',
        content:
          '请针对简历的「' + section + '」部分，结合岗位 JD 给出改写建议，并以 JSON 输出，字段固定为：' +
          '{ "rewriteSuggestions": [ { "section": "", "originalText": "", "rewrittenText": "", "reason": "", "truthCheckRequired": true } ], ' +
          '"overallNotes": [], "questionsForUser": [] }。' +
          '\n每条建议必须给出：对应模块 section、简历中的原文 originalText（尽量摘录真实句子）、改写后 rewrittenText、修改理由 reason、是否需要核实真实性 truthCheckRequired。' +
          '\noverallNotes 为整体注意事项；questionsForUser 为需要我补充真实信息的问题。给出 2-5 条 rewriteSuggestions。' +
          '\n\n【原简历文本】\n' + resumeText +
          '\n\n【岗位 JD】\n' + jdText,
      },
    ];
    // 深度改写优先使用 Pro 模型（如已配置）
    const data = await callDeepSeekJSON(messages, {
      temperature: 0.35,
      maxTokens: 2600,
      model: PRO_MODEL || undefined,
    });
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
    const { userNotes, questions, resumeText, jdText } = req.body || {};
    if (!requireText(userNotes, '补充说明（userNotes）', res)) return;

    const questionText = Array.isArray(questions) ? questions.join('\n') : '';
    const messages = [
      {
        role: 'system',
        content:
          '你是严谨的求职材料润色助手。' + ANTI_FABRICATION +
          '你的任务只是润色用户已经写出的补充说明，让表达更清晰、专业、适合后续写进简历或投递材料。' +
          '禁止新增用户未提供的经历、技能、证书、公司、数据、结果或时间。' +
          '如果用户补充说明里信息不足或需要核实，请保留谨慎表达，必要时用 [请补充/核实...] 占位。只输出一个 JSON 对象。',
      },
      {
        role: 'user',
        content:
          '请润色下面【用户补充说明】，并以 JSON 输出，字段固定为：' +
          '{ "polishedText": "", "truthCheckWarnings": [], "questionsForUser": [] }。' +
          '\npolishedText 要保留用户原意和真实性，可以分点；truthCheckWarnings 写需要用户核实的风险；questionsForUser 写还需要补充的问题。' +
          '\n\n【AI 提出的问题】\n' + (questionText || '（无）') +
          '\n\n【岗位 JD】\n' + (jdText || '（未提供）') +
          '\n\n【简历文本】\n' + (resumeText || '（未提供）') +
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

// 健康检查：前端可用它判断后端与 Key 是否就绪
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasKey: !!(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) });
});

const listenArgs = HOST ? [PORT, HOST] : [PORT];
app.listen(...listenArgs, () => {
  console.log('求职管家后端已启动: http://' + (HOST || 'localhost') + ':' + PORT);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn('⚠ 未检测到 DEEPSEEK_API_KEY，AI 接口会返回未配置错误。请在 server/.env 中填写。');
  }
  if (!process.env.APP_USERNAME || !process.env.APP_PASSWORD) {
    console.warn('未配置 APP_USERNAME/APP_PASSWORD，公网部署时建议开启访问保护。');
  }
});
