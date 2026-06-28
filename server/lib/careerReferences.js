'use strict';

const DIMENSION_RULES = [
  { key: 'hardRequirements', label: '硬性要求', weight: 0.35, aliases: ['硬性', '任职要求', 'must', 'requirement'] },
  { key: 'coreSkills', label: '核心技能', weight: 0.25, aliases: ['技能', '工具', 'skill', 'tool'] },
  { key: 'experienceDepth', label: '经历深度', weight: 0.20, aliases: ['经历', '项目', '经验', 'experience', 'project'] },
  { key: 'domainFit', label: '岗位/行业相关性', weight: 0.10, aliases: ['行业', '岗位', '业务', 'domain'] },
  { key: 'communicationReadability', label: '表达可读性', weight: 0.10, aliases: ['表达', '可读', '沟通', 'readability'] },
];

const CAREER_REFERENCES = [
  {
    id: 'onet-data-scientists',
    title: 'Data Scientists occupational profile',
    issuer: 'O*NET',
    sourceType: 'occupational_database',
    region: 'US',
    url: 'https://www.onetonline.org/link/summary/15-2051.00',
    reliability: 'high',
    roleKeywords: ['数据分析', '数据科学', '数据挖掘', 'data analyst', 'data scientist', 'sql', 'python', '机器学习', '建模'],
    tags: ['analytics', 'data', 'ai'],
    summary: '数据类岗位通常要求把原始数据转化为可解释的信息，并能通过统计、建模、可视化和业务沟通支持决策。',
    requirements: ['数据清洗与质量检查', '统计分析与建模', 'SQL/Python/R 等工具使用', '数据可视化和业务解释', '实验或指标分析'],
    skills: ['SQL', 'Python', '统计分析', '数据可视化', '业务问题拆解', '模型评估'],
  },
  {
    id: 'bls-data-scientists',
    title: 'Occupational Outlook Handbook: Data Scientists',
    issuer: 'U.S. Bureau of Labor Statistics',
    sourceType: 'labor_market_outlook',
    region: 'US',
    url: 'https://www.bls.gov/ooh/math/data-scientists.htm',
    reliability: 'high',
    roleKeywords: ['数据分析', '数据科学', '数据产品', '商业分析', 'data scientist', 'business analyst'],
    tags: ['analytics', 'outlook'],
    summary: 'BLS 职业展望可作为数据岗位工作内容、教育背景和市场前景的参照，但具体录用标准仍以 JD 为准。',
    requirements: ['收集和整理数据', '选择分析方法', '解释分析结果', '向业务或管理者呈现结论'],
    skills: ['分析工具', '统计推断', '沟通呈现', '问题定义'],
  },
  {
    id: 'onet-market-research-analysts',
    title: 'Market Research Analysts and Marketing Specialists occupational profile',
    issuer: 'O*NET',
    sourceType: 'occupational_database',
    region: 'US',
    url: 'https://www.onetonline.org/link/summary/13-1161.00',
    reliability: 'high',
    roleKeywords: ['市场分析', '用户研究', '运营分析', '增长', '商业分析', 'market research', 'user research', '运营'],
    tags: ['marketing', 'research', 'operations'],
    summary: '市场/用户/运营分析类岗位关注市场、用户、竞品和活动数据，强调研究设计、数据解释和业务建议。',
    requirements: ['市场或用户数据收集', '调研和问卷设计', '竞品或行业分析', '报告撰写', '把洞察转化为行动建议'],
    skills: ['调研方法', 'Excel/SQL', '数据解释', '报告表达', '业务建议'],
  },
  {
    id: 'onet-management-analysts',
    title: 'Management Analysts occupational profile',
    issuer: 'O*NET',
    sourceType: 'occupational_database',
    region: 'US',
    url: 'https://www.onetonline.org/link/summary/13-1111.00',
    reliability: 'high',
    roleKeywords: ['战略', '咨询', '经营分析', '流程优化', '项目管理', 'management analyst', 'business operations'],
    tags: ['consulting', 'operations', 'business'],
    summary: '经营/咨询/流程优化类岗位重视问题诊断、数据与访谈证据、流程改善方案和跨部门沟通。',
    requirements: ['识别组织或流程问题', '收集定量和定性证据', '形成改进建议', '推动沟通和落地'],
    skills: ['问题拆解', '项目管理', '流程分析', '沟通协调', '报告呈现'],
  },
  {
    id: 'onet-accountants-auditors',
    title: 'Accountants and Auditors occupational profile',
    issuer: 'O*NET',
    sourceType: 'occupational_database',
    region: 'US',
    url: 'https://www.onetonline.org/link/summary/13-2011.00',
    reliability: 'high',
    roleKeywords: ['财务', '会计', '审计', '税务', '内控', 'accounting', 'audit', 'finance'],
    tags: ['finance', 'audit'],
    summary: '财务/会计/审计岗位通常强调凭证、账务、报表、内控、合规和数据准确性。',
    requirements: ['财务记录检查', '报表和账务处理', '审计证据整理', '内控或合规意识', 'Excel 等办公工具'],
    skills: ['会计准则理解', '凭证核查', '底稿整理', 'Excel', '细致性', '风险意识'],
  },
  {
    id: 'bls-accountants-auditors',
    title: 'Occupational Outlook Handbook: Accountants and Auditors',
    issuer: 'U.S. Bureau of Labor Statistics',
    sourceType: 'labor_market_outlook',
    region: 'US',
    url: 'https://www.bls.gov/ooh/business-and-financial/accountants-and-auditors.htm',
    reliability: 'high',
    roleKeywords: ['财务分析', '审计', '会计', '内控', 'accountant', 'auditor'],
    tags: ['finance', 'audit', 'outlook'],
    summary: 'BLS 对会计与审计职业的工作内容和能力要求可用于校验简历是否突出准确性、合规和财务资料处理能力。',
    requirements: ['检查财务记录', '评估财务运营', '准备或审阅报表', '发现风险和不一致'],
    skills: ['分析能力', '数字敏感度', '书面表达', '职业审慎'],
  },
  {
    id: 'onet-human-resources-specialists',
    title: 'Human Resources Specialists occupational profile',
    issuer: 'O*NET',
    sourceType: 'occupational_database',
    region: 'US',
    url: 'https://www.onetonline.org/link/summary/13-1071.00',
    reliability: 'high',
    roleKeywords: ['招聘', '人力资源', 'hr', '人才', '员工关系', 'human resources', 'recruiting'],
    tags: ['hr', 'recruiting'],
    summary: '招聘/人力资源岗位关注候选人搜寻、面试协调、制度流程、沟通和合规意识。',
    requirements: ['候选人沟通和筛选', '招聘流程协调', '记录和信息维护', '劳动法规和组织政策意识'],
    skills: ['沟通', '组织协调', '信息记录', '候选人体验', '保密意识'],
  },
  {
    id: 'esco-occupations-skills',
    title: 'ESCO occupations, skills and competences',
    issuer: 'European Commission',
    sourceType: 'skills_taxonomy',
    region: 'EU',
    url: 'https://esco.ec.europa.eu/en',
    reliability: 'high',
    roleKeywords: ['技能', '能力', '职业分类', 'competence', 'skills', 'occupation'],
    tags: ['taxonomy', 'skills'],
    summary: 'ESCO 可作为职业、技能和能力之间映射的参照，适合补充跨行业可迁移技能的评估依据。',
    requirements: ['职业与技能映射', '技能同义词和能力描述', '跨岗位可迁移能力'],
    skills: ['技能归一化', '能力映射', '职业分类'],
  },
  {
    id: 'mohrss-occupation-standards',
    title: '中国职业分类与职业标准公开入口',
    issuer: '人力资源和社会保障部/技能人才评价工作网',
    sourceType: 'official_standard_portal',
    region: 'CN',
    url: 'https://osta.mohrss.gov.cn/',
    reliability: 'high',
    roleKeywords: ['职业标准', '职业分类', '技能等级', '职业资格', '人社部', '国家职业标准'],
    tags: ['china', 'standard', 'skills'],
    summary: '中国职业分类与职业标准适合作为国内岗位能力等级、技能边界和职业规范的基准入口。',
    requirements: ['按职业标准核对能力边界', '区分基础技能和进阶技能', '结合国内岗位名称做归类'],
    skills: ['职业分类', '能力等级', '技能标准', '规范表述'],
  },
  {
    id: 'china-public-recruitment',
    title: '中国公共招聘网/就业在线岗位样本入口',
    issuer: '人力资源和社会保障部相关公共就业服务平台',
    sourceType: 'public_job_market_sample',
    region: 'CN',
    url: 'https://job.mohrss.gov.cn/',
    reliability: 'medium',
    roleKeywords: ['校招', '实习', '招聘', '岗位', '投递', '公共招聘'],
    tags: ['china', 'job-market'],
    summary: '公共招聘平台可用于观察真实岗位描述的常见要求；它是市场样本，不等同于职业标准。',
    requirements: ['对照真实 JD 常见关键词', '观察城市和行业差异', '避免把单个岗位要求泛化为通用标准'],
    skills: ['岗位样本对比', '关键词校验', '市场现实感'],
  },
];

function asText(value) {
  return String(value == null ? '' : value);
}

function norm(value) {
  return asText(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function hasTerm(text, term) {
  const t = norm(term);
  if (!t) return false;
  return norm(text).indexOf(t) >= 0;
}

function unique(values) {
  const seen = new Set();
  const out = [];
  (values || []).forEach(value => {
    const s = asText(value).trim();
    const key = norm(s);
    if (!s || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  });
  return out;
}

function scoreReference(ref, query) {
  const text = [query.jdText, query.resumeText].filter(Boolean).join('\n');
  const jd = query.jdText || '';
  let score = 0;
  const matchedKeywords = [];

  (ref.roleKeywords || []).forEach(keyword => {
    if (hasTerm(text, keyword)) {
      score += hasTerm(jd, keyword) ? 8 : 4;
      matchedKeywords.push(keyword);
    }
  });
  (ref.tags || []).forEach(tag => {
    if (hasTerm(text, tag)) score += 2;
  });
  (ref.skills || []).concat(ref.requirements || []).forEach(item => {
    if (hasTerm(jd, item)) score += 3;
    else if (hasTerm(text, item)) score += 1;
  });

  return { score, matchedKeywords: unique(matchedKeywords) };
}

function publicReference(ref, matchedKeywords) {
  return {
    id: ref.id,
    title: ref.title,
    issuer: ref.issuer,
    sourceType: ref.sourceType,
    region: ref.region,
    url: ref.url,
    reliability: ref.reliability,
    summary: ref.summary,
    requirements: (ref.requirements || []).slice(0, 6),
    skills: (ref.skills || []).slice(0, 8),
    matchedKeywords: unique(matchedKeywords || []),
  };
}

function findCareerReferences(query, options = {}) {
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 6));
  const scored = CAREER_REFERENCES.map(ref => {
    const s = scoreReference(ref, query || {});
    return Object.assign({ ref }, s);
  }).filter(item => item.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.ref.reliability === b.ref.reliability) return a.ref.id.localeCompare(b.ref.id);
    return a.ref.reliability === 'high' ? -1 : 1;
  });

  const refs = scored.slice(0, limit).map(item => publicReference(item.ref, item.matchedKeywords));
  if (refs.length && !refs.some(ref => ref.id === 'mohrss-occupation-standards')) {
    refs.push(publicReference(CAREER_REFERENCES.find(ref => ref.id === 'mohrss-occupation-standards'), []));
  }
  return refs.slice(0, limit);
}

function buildReferencePrompt(references) {
  if (!references || !references.length) return '（未检索到相关外部职业资料；请只基于简历与 JD 分析。）';
  return references.map((ref, index) => {
    return [
      '[' + ref.id + '] ' + ref.title,
      '发布/维护方：' + ref.issuer + '；地区：' + ref.region + '；可信等级：' + ref.reliability,
      '来源链接：' + ref.url,
      '摘要：' + ref.summary,
      '常见要求：' + (ref.requirements || []).join('；'),
      '相关技能：' + (ref.skills || []).join('；'),
      '命中关键词：' + ((ref.matchedKeywords || []).join('，') || '通用岗位基准'),
    ].join('\n');
  }).join('\n\n');
}

function clampScore(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function canonicalDimension(raw, index) {
  const text = norm([raw && raw.key, raw && raw.label].filter(Boolean).join(' '));
  let rule = DIMENSION_RULES[index] || DIMENSION_RULES[DIMENSION_RULES.length - 1];
  for (const candidate of DIMENSION_RULES) {
    if (candidate.key.toLowerCase() === text) { rule = candidate; break; }
    if (candidate.aliases.some(alias => text.indexOf(alias.toLowerCase()) >= 0)) { rule = candidate; break; }
  }
  return rule;
}

function normalizeScoreDimensions(dimensions) {
  const byKey = new Map();
  (Array.isArray(dimensions) ? dimensions : []).forEach((raw, index) => {
    const rule = canonicalDimension(raw || {}, index);
    if (byKey.has(rule.key)) return;
    byKey.set(rule.key, {
      key: rule.key,
      label: rule.label,
      weight: rule.weight,
      score: clampScore(raw && raw.score, 50),
      reason: asText(raw && raw.reason).slice(0, 180),
      evidence: unique(Array.isArray(raw && raw.evidence) ? raw.evidence : []).slice(0, 3),
    });
  });
  DIMENSION_RULES.forEach(rule => {
    if (!byKey.has(rule.key)) {
      byKey.set(rule.key, {
        key: rule.key,
        label: rule.label,
        weight: rule.weight,
        score: 50,
        reason: '模型未返回该维度，按中性分计入。',
        evidence: [],
      });
    }
  });
  return DIMENSION_RULES.map(rule => byKey.get(rule.key));
}

function weightedScore(dimensions, fallback) {
  const totalWeight = dimensions.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
  if (!totalWeight) return clampScore(fallback, 0);
  const score = dimensions.reduce((sum, item) => sum + (Number(item.score) || 0) * (Number(item.weight) || 0), 0) / totalWeight;
  return clampScore(score, fallback);
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') {
      return asText(item.text || item.claim || item.point || item.reason || JSON.stringify(item)).trim();
    }
    return asText(item).trim();
  }).filter(Boolean).slice(0, 12);
}

function normalizeEvidenceItems(items, references) {
  const allowed = new Set((references || []).map(ref => ref.id));
  return (Array.isArray(items) ? items : []).map(item => {
    const sourceIds = unique(Array.isArray(item && item.sourceIds) ? item.sourceIds : [])
      .filter(id => allowed.has(id))
      .slice(0, 4);
    return {
      claim: asText(item && item.claim).slice(0, 180),
      resumeEvidence: asText(item && item.resumeEvidence).slice(0, 220),
      jdEvidence: asText(item && item.jdEvidence).slice(0, 220),
      sourceIds,
      confidence: Math.max(0, Math.min(1, Number(item && item.confidence) || 0)),
    };
  }).filter(item => item.claim).slice(0, 8);
}

function normalizeExperienceSuggestions(items) {
  return (Array.isArray(items) ? items : []).map(item => {
    if (typeof item === 'string') {
      const text = item.trim();
      return text ? {
        title: '可用经历素材',
        source: '',
        usableInfo: text.slice(0, 260),
        whyUseful: '',
        suggestedUse: '据实补充到相关经历或作为面试案例准备。',
        confidence: 0,
      } : null;
    }
    return {
      title: asText(item && (item.title || item.section || item.name)).slice(0, 80),
      source: asText(item && (item.source || item.experienceSource)).slice(0, 120),
      usableInfo: asText(item && (item.usableInfo || item.info || item.evidence)).slice(0, 320),
      whyUseful: asText(item && (item.whyUseful || item.reason)).slice(0, 260),
      suggestedUse: asText(item && (item.suggestedUse || item.suggestion)).slice(0, 260),
      confidence: Math.max(0, Math.min(1, Number(item && item.confidence) || 0)),
    };
  }).filter(item => item && item.usableInfo).slice(0, 8);
}

function normalizeMatchResult(data, references) {
  const out = Object.assign({}, data || {});
  out.matchedPoints = stringArray(out.matchedPoints);
  out.missingPoints = stringArray(out.missingPoints);
  out.weakExpressions = stringArray(out.weakExpressions);
  out.suggestedResumeFocus = stringArray(out.suggestedResumeFocus);
  out.riskWarnings = stringArray(out.riskWarnings);
  out.questionsForUser = stringArray(out.questionsForUser);
  out.experienceSuggestions = normalizeExperienceSuggestions(out.experienceSuggestions);
  out.scoreDimensions = normalizeScoreDimensions(out.scoreDimensions);
  out.matchScore = weightedScore(out.scoreDimensions, out.matchScore);
  out.evidenceItems = normalizeEvidenceItems(out.evidenceItems, references);
  out.authoritativeReferences = (references || []).map(ref => publicReference(ref, ref.matchedKeywords));
  out.referenceCoverage = {
    matchedCount: out.authoritativeReferences.length,
    status: out.authoritativeReferences.length ? 'matched' : 'empty',
    note: out.authoritativeReferences.length
      ? '已将相关职业资料作为评估参照；具体判断仍以用户简历和当前 JD 为准。'
      : '未命中本地资料库，当前结果仅基于简历和 JD。',
  };
  out.scoreBasis = {
    method: 'server_weighted_dimensions',
    note: '服务端按固定维度权重汇总 matchScore，AI 负责给出各维度判断和证据。',
    dimensions: DIMENSION_RULES.map(rule => ({ key: rule.key, label: rule.label, weight: rule.weight })),
  };
  return out;
}

module.exports = {
  CAREER_REFERENCES,
  DIMENSION_RULES,
  findCareerReferences,
  buildReferencePrompt,
  normalizeMatchResult,
};
