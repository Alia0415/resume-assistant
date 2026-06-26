'use strict';

const { crawlJobUrl, htmlToText, assertPublicUrl } = require('./jobCrawler');

const SEARCH_TIMEOUT_MS = Math.max(3000, Number(process.env.JOB_BOARD_SEARCH_TIMEOUT_MS) || 10000);
const DEFAULT_LIMIT = Math.max(3, Math.min(30, Number(process.env.JOB_BOARD_DEFAULT_LIMIT) || 12));
const MAX_LIMIT = Math.max(5, Math.min(50, Number(process.env.JOB_BOARD_MAX_LIMIT) || 24));
const CRAWL_DETAIL_LIMIT = Math.max(0, Math.min(12, Number(process.env.JOB_BOARD_CRAWL_DETAIL_LIMIT) || 6));
const GENERIC_PAGE_TIMEOUT_MS = Math.max(2000, Math.min(SEARCH_TIMEOUT_MS, Number(process.env.JOB_BOARD_PAGE_TIMEOUT_MS) || 5000));
const SEARCH_PROVIDER = (process.env.JOB_BOARD_SEARCH_PROVIDER || 'official-sources').trim();
const DEFAULT_OFFICIAL_SOURCES = process.env.JOB_BOARD_OFFICIAL_SOURCES || '';

const SKILL_TERMS = [
  'Excel', 'SQL', 'Python', 'R', 'Tableau', 'Power BI', 'SPSS', 'SAS', 'Pandas', 'NumPy',
  '机器学习', '数据分析', '数据可视化', '数据建模', '数据清洗', '经营分析', '商业分析', '用户研究',
  '财务分析', '审计', '会计', '内控', '税务', '预算', '报表', '凭证', '底稿', '函证',
  '产品运营', '内容运营', '用户运营', '活动运营', '增长', 'A/B测试', '竞品分析', '需求分析',
  '项目管理', '沟通协调', '跨部门', '文档撰写', '英语', 'PPT', 'Word',
  'JavaScript', 'TypeScript', 'Java', 'C++', 'Go', 'Node.js', 'React', 'Vue', 'Spring',
  'Linux', 'Git', 'Docker', 'Kubernetes', 'MySQL', 'PostgreSQL', 'Redis',
];

const KEYWORD_TRANSLATIONS = [
  ['数据分析', 'data analyst'],
  ['商业分析', 'business analyst'],
  ['财务分析', 'financial analyst'],
  ['财务', 'finance'],
  ['审计', 'audit'],
  ['会计', 'accounting'],
  ['产品', 'product'],
  ['运营', 'operations'],
  ['用户研究', 'user research'],
  ['人力', 'human resources'],
  ['招聘', 'recruiting'],
  ['前端', 'frontend'],
  ['后端', 'backend'],
  ['软件', 'software'],
  ['实习', 'intern'],
  ['校招', 'graduate'],
  ['远程', 'remote'],
];

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const hex = code[1] && code[1].toLowerCase() === 'x';
      const n = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(named, code) ? named[code] : m;
  });
}

function stripTags(value) {
  return cleanText(decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')));
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch (e) {
    return '';
  }
}

function normalizeSourceUrls(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/\r?\n|,/);
  return raw.map(safeUrl).filter(Boolean).slice(0, 12);
}

function configuredOfficialUrls(value) {
  return uniqueBy(
    normalizeSourceUrls(DEFAULT_OFFICIAL_SOURCES).concat(normalizeSourceUrls(value)),
    item => item
  ).slice(0, 20);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  (items || []).forEach(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

function interleaveLists(lists) {
  const out = [];
  const arrays = (lists || []).filter(list => Array.isArray(list) && list.length);
  let index = 0;
  while (arrays.some(list => index < list.length)) {
    arrays.forEach(list => {
      if (index < list.length) out.push(list[index]);
    });
    index += 1;
  }
  return out;
}

function buildSearchQuery(options) {
  const keywords = cleanText(options && options.keywords);
  const city = cleanText(options && options.city);
  const parts = [keywords, city, '招聘', '实习', '校招', '岗位职责', '任职要求'].filter(Boolean);
  return parts.join(' ');
}

function buildApiSearchTerms(options) {
  const raw = cleanText(options && options.keywords);
  const terms = [];
  if (raw) terms.push(raw);
  KEYWORD_TRANSLATIONS.forEach(([cn, en]) => {
    if (raw.indexOf(cn) >= 0) terms.push(en);
  });
  if (!terms.length) terms.push('intern');
  return uniqueBy(terms, item => item.toLowerCase()).slice(0, 4);
}

function termMatchesText(term, text) {
  const hay = String(text || '').toLowerCase();
  const clean = String(term || '').toLowerCase().trim();
  if (!clean) return false;
  if (/^[a-z0-9+#.]+$/i.test(clean)) {
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9+#.])' + escaped + '([^a-z0-9+#.]|$)', 'i').test(String(text || ''));
  }
  if (hay.indexOf(clean) >= 0) return true;
  const parts = clean.split(/\s+/).filter(Boolean);
  return parts.length > 1 && parts.every(part => termMatchesText(part, text));
}

function matchesSearchIntent(options, fields) {
  const raw = cleanText(options && options.keywords);
  if (!raw) return true;
  const text = fields.map(x => String(x || '')).join(' ');
  const terms = buildApiSearchTerms(options).filter(term => term !== raw);
  if (terms.some(term => termMatchesText(term, text))) return true;
  const rawParts = raw.split(/[\s,，/、]+/).map(x => x.trim()).filter(Boolean);
  if (!rawParts.length) return true;
  const asciiParts = rawParts.filter(part => /^[a-z0-9+#.]+$/i.test(part));
  if (asciiParts.length >= 2) return asciiParts.every(part => termMatchesText(part, text));
  return rawParts.some(part => part.length >= 2 && termMatchesText(part, text));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: Object.assign({
        'User-Agent': 'ResumeAssistantBot/1.0 (+self-hosted personal job assistant)',
        'Accept': 'application/rss+xml,application/xml,text/xml,text/html;q=0.8,*/*;q=0.5',
      }, options.headers || {}),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      signal: controller.signal,
      headers: Object.assign({
        'User-Agent': 'ResumeAssistantBot/1.0 (+self-hosted personal job assistant)',
        'Accept': 'application/json,text/plain;q=0.8,*/*;q=0.5',
      }, options.headers || {}),
      body: options.body,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function detectAtsSource(inputUrl) {
  const href = safeUrl(inputUrl);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'careers.tencent.com') {
    return { type: 'tencent', url: href };
  }
  if (host === 'talent.baidu.com') {
    return { type: 'baidu', url: href };
  }
  if (host === 'zhaopin.jd.com') {
    return { type: 'jd', url: href };
  }
  if (host === 'zhaopin.meituan.com') {
    return { type: 'meituan', url: href };
  }
  if (host === 'careers.citics.com' || host === 'global-kong.citics.com') {
    return { type: 'citics', url: href };
  }
  if (host.endsWith('greenhouse.io')) {
    let board = '';
    const idx = parts.indexOf('boards');
    if (idx >= 0 && parts[idx + 1]) board = parts[idx + 1];
    else if (parts[0] && !['jobs', 'embed'].includes(parts[0])) board = parts[0];
    if (board) return { type: 'greenhouse', board, url: href };
  }
  if (host === 'jobs.lever.co' || host === 'api.lever.co') {
    const org = parts[0] === 'v0' && parts[1] === 'postings' ? parts[2] : parts[0];
    if (org) return { type: 'lever', org, url: href };
  }
  if (host === 'jobs.ashbyhq.com' || host === 'api.ashbyhq.com') {
    const idx = parts.indexOf('job-board');
    const org = idx >= 0 ? parts[idx + 1] : parts[0];
    if (org) return { type: 'ashby', org, url: href };
  }
  return { type: 'career-page', url: href };
}

function officialJob(job) {
  return Object.assign({
    id: '',
    company: '',
    role: '',
    city: '',
    direction: '',
    link: '',
    jd: '',
    source: '企业官网',
    crawledAt: Date.now(),
    fetchedAt: Date.now(),
    datePosted: '',
    validThrough: '',
    boardWarnings: ['来自企业官网或官方招聘系统；请打开原链接核对最新状态。'],
  }, job || {});
}

async function fetchGreenhouseJobs(source) {
  const data = await fetchJson('https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(source.board) + '/jobs?content=true');
  return (data.jobs || []).map(job => officialJob({
    id: apiJobId('greenhouse', job.id || job.absolute_url || job.title),
    company: cleanText(source.board),
    role: cleanText(job.title || ''),
    city: cleanText(job.location && job.location.name),
    direction: cleanText(((job.departments || [])[0] && (job.departments || [])[0].name) || ((job.offices || [])[0] && (job.offices || [])[0].name) || ''),
    link: safeUrl(job.absolute_url || ''),
    jd: htmlSnippet(job.content || ''),
    source: 'Greenhouse 官方招聘系统',
    datePosted: cleanText(job.updated_at || ''),
  }));
}

async function fetchLeverJobs(source) {
  const data = await fetchJson('https://api.lever.co/v0/postings/' + encodeURIComponent(source.org) + '?mode=json');
  return (Array.isArray(data) ? data : []).map(job => {
    const listText = (job.lists || []).map(list => [list.text, list.content].filter(Boolean).join('\n')).join('\n\n');
    return officialJob({
      id: apiJobId('lever', job.id || job.hostedUrl || job.text),
      company: cleanText(source.org),
      role: cleanText(job.text || ''),
      city: cleanText(job.categories && job.categories.location),
      direction: cleanText([job.categories && job.categories.team, job.categories && job.categories.commitment].filter(Boolean).join(' / ')),
      link: safeUrl(job.hostedUrl || job.applyUrl || ''),
      jd: cleanText([job.descriptionPlain || htmlSnippet(job.description || ''), htmlSnippet(listText)].filter(Boolean).join('\n\n')),
      source: 'Lever 官方招聘系统',
      datePosted: job.createdAt ? String(new Date(job.createdAt).toISOString()) : '',
    });
  });
}

async function fetchAshbyJobs(source) {
  const data = await fetchJson('https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(source.org) + '?includeCompensation=true');
  return (data.jobs || []).map(job => officialJob({
    id: apiJobId('ashby', job.id || job.applyUrl || job.title),
    company: cleanText(source.org),
    role: cleanText(job.title || ''),
    city: cleanText(job.locationName || job.location || ''),
    direction: cleanText([job.departmentName, job.employmentType].filter(Boolean).join(' / ')),
    link: safeUrl(job.applyUrl || job.jobUrl || job.externalLink || ('https://jobs.ashbyhq.com/' + source.org + '/' + job.id)),
    jd: htmlSnippet(job.descriptionHtml || job.description || ''),
    source: 'Ashby 官方招聘系统',
    datePosted: cleanText(job.publishedDate || ''),
  }));
}

async function fetchTencentPostDetail(postId) {
  if (!postId) return null;
  try {
    const url = 'https://careers.tencent.com/tencentcareer/api/post/ByPostId?timestamp=' +
      Date.now() + '&postId=' + encodeURIComponent(postId) + '&language=zh-cn';
    const data = await fetchJson(url, {
      headers: {
        'Referer': 'https://careers.tencent.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    return data && data.Data ? data.Data : null;
  } catch (e) {
    return null;
  }
}

function tencentPostLink(post) {
  const raw = safeUrl(String((post && post.PostURL) || '').replace(/^http:/i, 'https:'));
  if (raw) return raw;
  const postId = post && (post.PostId || post.RecruitPostId);
  return postId ? 'https://careers.tencent.com/jobdesc.html?postId=' + encodeURIComponent(postId) : 'https://careers.tencent.com/';
}

async function fetchTencentJobs(source, options = {}) {
  const limit = Math.max(3, Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT));
  const pageSize = Math.max(limit, Math.min(30, limit * 2));
  const keyword = cleanText(options.keywords || '');
  const url = 'https://careers.tencent.com/tencentcareer/api/post/Query?timestamp=' + Date.now() +
    '&countryId=&cityId=&bgIds=&productId=&categoryId=&parentCategoryId=&attrId=' +
    '&keyword=' + encodeURIComponent(keyword) +
    '&pageIndex=1&pageSize=' + encodeURIComponent(pageSize) +
    '&language=zh-cn&area=cn';
  const data = await fetchJson(url, {
    headers: {
      'Referer': source && source.url ? source.url : 'https://careers.tencent.com/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  const posts = (data && data.Data && Array.isArray(data.Data.Posts)) ? data.Data.Posts : [];
  const jobs = [];
  for (const post of posts.slice(0, pageSize)) {
    const detail = await fetchTencentPostDetail(post.PostId);
    const merged = Object.assign({}, post, detail || {});
    const jd = cleanText([
      merged.Responsibility,
      merged.Requirement,
      merged.Introduction,
      merged.DepartmentIntroduction,
    ].filter(Boolean).join('\n\n'));
    jobs.push(officialJob({
      id: apiJobId('tencent', merged.PostId || merged.RecruitPostId || merged.RecruitPostName),
      company: cleanText(merged.ComName || '腾讯'),
      role: cleanText(merged.RecruitPostName || ''),
      city: cleanText([merged.CountryName, merged.LocationName].filter(Boolean).join(' / ')),
      direction: cleanText([merged.BGName, merged.ProductName, merged.CategoryName, merged.RequireWorkYearsName].filter(Boolean).join(' / ')),
      link: tencentPostLink(merged),
      jd,
      source: '腾讯招聘官网',
      datePosted: cleanText(merged.LastUpdateTime || ''),
      boardWarnings: ['来自腾讯招聘官网公开岗位接口；请打开原链接核对最新状态。'],
    }));
  }
  return jobs;
}

function parseWindowInitialData(html, varName) {
  const re = new RegExp('window\\.' + varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*([\\s\\S]*?)<\\/script>', 'i');
  const m = String(html || '').match(re);
  if (!m) return null;
  let raw = m[1].replace(/;\s*$/, '');
  const nextStatement = raw.indexOf('; window.');
  if (nextStatement >= 0) raw = raw.slice(0, nextStatement);
  try {
    return Function('"use strict"; return (' + raw + ');')();
  } catch (e) {
    return null;
  }
}

async function fetchBaiduJobs(source, options = {}) {
  const limit = Math.max(3, Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT));
  const keyword = cleanText(options.keywords || '');
  const url = 'https://talent.baidu.com/jobs/social-list' + (keyword ? '?search=' + encodeURIComponent(keyword) : '');
  const html = await fetchWithTimeout(url, {
    timeoutMs: SEARCH_TIMEOUT_MS,
    headers: {
      'Referer': source && source.url ? source.url : 'https://talent.baidu.com/jobs/social-list',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  const data = parseWindowInitialData(html, '__INITIAL_DATA__') || {};
  const list = data.listData && Array.isArray(data.listData.listDetailData) ? data.listData.listDetailData : [];
  return list.slice(0, Math.max(limit, 20)).map(job => officialJob({
    id: apiJobId('baidu', job.postId || job.jobId || job.name),
    company: '百度',
    role: cleanText(job.name || ''),
    city: cleanText(job.workPlace || ''),
    direction: cleanText([job.postType, job.bgShortName, job.projectType].filter(Boolean).join(' / ')),
    link: 'https://talent.baidu.com/jobs/social-list' + (keyword ? '?search=' + encodeURIComponent(keyword) : ''),
    jd: cleanText([job.workContent, job.serviceCondition].filter(Boolean).join('\n\n')),
    source: '百度招聘官网',
    datePosted: cleanText(job.publishDate || job.updateDate || ''),
    boardWarnings: ['来自百度招聘官网公开页面数据；请打开原链接核对最新状态。'],
  }));
}

async function fetchJdJobs(source, options = {}) {
  const limit = Math.max(3, Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT));
  const body = new URLSearchParams({
    pageIndex: '1',
    pageSize: String(Math.max(limit, 20)),
    workCityJson: '[]',
    jobTypeJson: '[]',
    depTypeJson: '[]',
    jobSearch: cleanText(options.keywords || ''),
  });
  const data = await fetchJson('https://zhaopin.jd.com/web/job/job_list', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 ResumeAssistantBot/1.0',
      'Origin': 'https://zhaopin.jd.com',
      'Referer': source && source.url ? source.url : 'https://zhaopin.jd.com/web/job/job_info_list/3',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  return (Array.isArray(data) ? data : []).map(job => officialJob({
    id: apiJobId('jd', job.positionId || job.requirementId || job.reqNumber || job.positionNameOpen),
    company: cleanText(job.positionDeptName || '京东'),
    role: cleanText(job.positionNameOpen || job.positionName || ''),
    city: cleanText(job.workCity || ''),
    direction: cleanText([job.jobType, job.positionDeptName].filter(Boolean).join(' / ')),
    link: 'https://zhaopin.jd.com/web/job/job_info_list/3',
    jd: cleanText([job.workContent, job.qualification].filter(Boolean).join('\n\n')),
    source: '京东招聘官网',
    datePosted: cleanText(job.formatPublishTime || (job.publishTime ? new Date(job.publishTime).toISOString().slice(0, 10) : '')),
    boardWarnings: ['来自京东招聘官网公开岗位接口；请打开原链接核对最新状态。'],
  }));
}

async function fetchMeituanJobs(source, options = {}) {
  const limit = Math.max(3, Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT));
  const payload = {
    page: { pageNo: 1, pageSize: Math.max(limit, 20) },
    keywords: cleanText(options.keywords || ''),
  };
  const data = await fetchJson('https://zhaopin.meituan.com/api/official/job/getJobList', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 ResumeAssistantBot/1.0',
      'Origin': 'https://zhaopin.meituan.com',
      'Referer': source && source.url ? source.url : 'https://zhaopin.meituan.com/web/social',
    },
    body: JSON.stringify(payload),
  });
  const list = data && data.data && Array.isArray(data.data.list) ? data.data.list : [];
  return list.map(job => officialJob({
    id: apiJobId('meituan', job.jobUnionId || job.name),
    company: '美团',
    role: cleanText(job.name || ''),
    city: cleanText((job.cityList || []).map(x => x && x.name).filter(Boolean).join('、')),
    direction: cleanText([job.jobFamily, job.jobFamilyGroup, (job.department || []).map(x => x && x.name).filter(Boolean).join('、')].filter(Boolean).join(' / ')),
    link: job.jobUnionId ? 'https://zhaopin.meituan.com/web/position/detail?jobUnionId=' + encodeURIComponent(job.jobUnionId) : 'https://zhaopin.meituan.com/web/social',
    jd: cleanText([job.jobDuty, job.jobRequirement, job.highLight, job.departmentIntro].filter(Boolean).join('\n\n')),
    source: '美团招聘官网',
    datePosted: job.refreshTime ? new Date(job.refreshTime).toISOString().slice(0, 10) : '',
    boardWarnings: ['来自美团招聘官网公开岗位接口；请打开原链接核对最新状态。'],
  }));
}

async function fetchCiticsPositionList(payload) {
  const body = new URLSearchParams(Object.assign({ sysNo: 'CSE001' }, payload || {}));
  return fetchJson('https://global-kong.citics.com/api/v1/recruit/getPositionList', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh',
      'User-Agent': 'Mozilla/5.0 ResumeAssistantBot/1.0',
      'Origin': 'https://careers.citics.com',
      'Referer': 'https://careers.citics.com/',
    },
    body,
  });
}

function citicsJobLink(job, pageName, resumeType) {
  const params = new URLSearchParams({
    deptNo: String(job.deptNo || ''),
    positionNo: String(job.positionNo || ''),
    pageName,
    resumeType: String(resumeType),
  });
  return 'https://careers.citics.com/positonDetail?' + params.toString();
}

async function fetchCiticsJobs(source, options = {}) {
  const pageSize = Math.max(20, Math.min(100, (Number(options.limit) || DEFAULT_LIMIT) * 5));
  const requests = [
    {
      pageName: 'socialHeadquarters',
      resumeType: 1,
      payload: { recruitType: '05', deptype: 'Headquarter', positionName: '', pageNo: 1, pageSize },
    },
    {
      pageName: 'interns',
      resumeType: 0,
      payload: { recruitType: '08', deptype: 'Headquarter', practice: 1, batchId: 58, positionName: '', pageNo: 1, pageSize },
    },
    {
      pageName: 'socialBranch',
      resumeType: 2,
      payload: { recruitType: '05', deptype: 'Branch', positionName: '', pageNo: 1, pageSize },
    },
  ];
  const batches = await Promise.all(requests.map(async req => {
    let data;
    try {
      data = await fetchCiticsPositionList(req.payload);
    } catch (e) {
      return [];
    }
    const list = Array.isArray(data && data.positionList) ? data.positionList : [];
    return list.map(job =>
      officialJob({
        id: apiJobId('citics', [job.deptNo, job.positionNo, job.positionName].join('|')),
        company: cleanText(job.companyName || '中信证券'),
        role: cleanText(job.positionName || ''),
        city: cleanText(job.workplace || ''),
        direction: cleanText([job.deptName, req.pageName === 'interns' ? '实习' : '社会招聘'].filter(Boolean).join(' / ')),
        link: citicsJobLink(job, req.pageName, req.resumeType),
        jd: cleanText([job.positionDesc, job.qualification, job.deptdescrip].filter(Boolean).join('\n\n')),
        source: '中信证券招聘官网',
        validThrough: cleanText(job.reqendDate || ''),
        boardWarnings: ['来自中信证券招聘官网公开岗位接口；请打开原链接核对最新状态。'],
      })
    );
  }));
  return uniqueBy(interleaveLists(batches), item => item.link || item.id);
}

async function fetchCareerPageHtml(inputUrl) {
  const url = await assertPublicUrl(inputUrl);
  const text = await fetchWithTimeout(url.href, { timeoutMs: GENERIC_PAGE_TIMEOUT_MS });
  return { html: text, url };
}

function extractCareerLinks(html, baseUrl) {
  const out = [];
  const base = new URL(baseUrl);
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    let href = '';
    try { href = new URL(decodeEntities(m[1]), base).href; } catch (e) { continue; }
    const url = new URL(href);
    const sameHost = url.hostname === base.hostname;
    const atsHost = /greenhouse\.io|lever\.co|ashbyhq\.com/i.test(url.hostname);
    if (!sameHost && !atsHost) continue;
    const text = stripTags(m[2]);
    const hay = (href + ' ' + text).toLowerCase();
    if (!/(job|jobs|career|careers|position|opening|apply|招聘|职位|岗位|校招|社招|实习)/i.test(hay)) continue;
    out.push({ title: text, link: href, snippet: '', source: '企业官网链接' });
  }
  return uniqueBy(out, item => item.link).slice(0, CRAWL_DETAIL_LIMIT);
}

function looksLikeJobDetailUrl(inputUrl) {
  const href = safeUrl(inputUrl);
  if (!href) return false;
  const url = new URL(href);
  const hay = (url.pathname + '?' + url.searchParams.toString()).toLowerCase();
  return /(jobdesc|job-detail|jobdetail|positiondetail|positondetail|posting|requisition|postid=|positionno=|jobid=|reqid=|jobs?\/\d|positions?\/\d)/i.test(hay);
}

async function fetchCareerPageJobs(source, options = {}) {
  const fetched = await fetchCareerPageHtml(source.url);
  const links = extractCareerLinks(fetched.html, fetched.url.href);
  const jobs = [];
  for (const link of links) {
    const ats = detectAtsSource(link.link);
    if (ats && ats.type !== 'career-page') {
      const nested = await fetchOfficialSource(ats, options);
      jobs.push(...nested);
      continue;
    }
    jobs.push(await crawlCandidate(link));
  }
  if (!jobs.length && looksLikeJobDetailUrl(source.url)) {
    const crawled = await crawlJobUrl(source.url);
    const job = normalizeBoardJob(crawled && crawled.job, { link: source.url, source: '企业官网' });
    if (job && (job.role || job.jd)) jobs.push(job);
  }
  return jobs;
}

async function fetchOfficialSource(source, options = {}) {
  if (!source) return [];
  if (source.type === 'tencent') return fetchTencentJobs(source, options);
  if (source.type === 'baidu') return fetchBaiduJobs(source, options);
  if (source.type === 'jd') return fetchJdJobs(source, options);
  if (source.type === 'meituan') return fetchMeituanJobs(source, options);
  if (source.type === 'citics') return fetchCiticsJobs(source, options);
  if (source.type === 'greenhouse') return fetchGreenhouseJobs(source);
  if (source.type === 'lever') return fetchLeverJobs(source);
  if (source.type === 'ashby') return fetchAshbyJobs(source);
  return fetchCareerPageJobs(source, options);
}

async function fetchOfficialJobs(options) {
  const urls = configuredOfficialUrls(options && options.sourceUrls);
  const sources = urls.map(detectAtsSource).filter(Boolean);
  const batches = await Promise.all(sources.map(async source => {
    try {
      return await fetchOfficialSource(source, options);
    } catch (e) {
      // A failed source should not become a fake job card on the board.
      return [];
    }
  }));
  return uniqueBy(interleaveLists(batches), item => item.link || item.id);
}

function parseRssItems(xml) {
  const out = [];
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    const block = m[0];
    const take = tag => {
      const mm = block.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
      return mm ? stripTags(mm[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')) : '';
    };
    const link = safeUrl(take('link'));
    if (!link) continue;
    out.push({
      title: take('title'),
      link,
      snippet: take('description'),
      publishedAt: take('pubDate'),
      source: '公开搜索',
    });
  }
  return out;
}

async function searchPublicJobs(options) {
  if (SEARCH_PROVIDER === 'none') return [];
  const query = buildSearchQuery(options || {});
  if (!query) return [];
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&format=rss';
  try {
    const xml = await fetchWithTimeout(url);
    return parseRssItems(xml).slice(0, MAX_LIMIT);
  } catch (e) {
    return [];
  }
}

function htmlSnippet(value) {
  return htmlToText(decodeEntities(String(value || ''))).slice(0, 4000);
}

function apiJobId(source, value) {
  return stableJobId(source + '|' + value);
}

async function searchRemotiveJobs(options) {
  const terms = buildApiSearchTerms(options);
  const all = [];
  for (const term of terms) {
    const url = 'https://remotive.com/api/remote-jobs?search=' + encodeURIComponent(term);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ResumeAssistantBot/1.0' } });
      if (!res.ok) continue;
      const data = await res.json();
      (data.jobs || []).slice(0, 20).forEach(job => {
        if (!matchesSearchIntent(options, [job.title, job.description, job.category, job.tags])) return;
        all.push({
          id: apiJobId('remotive', job.id || job.url || job.title),
          company: cleanText(job.company_name || ''),
          role: cleanText(job.title || ''),
          city: cleanText(job.candidate_required_location || 'Remote'),
          direction: cleanText(job.category || ''),
          link: safeUrl(job.url || ''),
          jd: htmlSnippet(job.description || ''),
          source: 'Remotive',
          crawledAt: Date.now(),
          fetchedAt: Date.now(),
          datePosted: cleanText(job.publication_date || ''),
          validThrough: '',
          boardWarnings: ['来自公开岗位 API；请打开原链接核对最新状态。'],
        });
      });
    } catch (e) {}
  }
  return uniqueBy(all, item => item.link || item.id);
}

async function searchRemoteOkJobs(options) {
  const terms = buildApiSearchTerms(options).map(x => x.toLowerCase());
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: {
        'User-Agent': 'ResumeAssistantBot/1.0',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).slice(1).filter(job => {
      const hay = [job.position, job.company, job.description, (job.tags || []).join(' ')].join(' ').toLowerCase();
      return terms.some(term => hay.indexOf(term) >= 0 || term.split(/\s+/).every(part => hay.indexOf(part) >= 0)) &&
        matchesSearchIntent(options, [job.position, job.company, job.description, (job.tags || []).join(' ')]);
    }).slice(0, 30).map(job => ({
      id: apiJobId('remoteok', job.id || job.url || job.position),
      company: cleanText(job.company || ''),
      role: cleanText(job.position || ''),
      city: cleanText(job.location || 'Remote'),
      direction: Array.isArray(job.tags) ? job.tags.slice(0, 3).join(' / ') : '',
      link: safeUrl(job.url || job.apply_url || ''),
      jd: htmlSnippet(job.description || [job.position, (job.tags || []).join(', ')].join('\n')),
      source: 'RemoteOK',
      crawledAt: Date.now(),
      fetchedAt: Date.now(),
      datePosted: cleanText(job.date || ''),
      validThrough: '',
      boardWarnings: ['来自公开岗位 API；请打开原链接核对最新状态。'],
    }));
  } catch (e) {
    return [];
  }
}

async function searchOpenApiJobs(options) {
  if (SEARCH_PROVIDER === 'none' || SEARCH_PROVIDER === 'bing-rss') return [];
  const lists = await Promise.all([searchRemotiveJobs(options), searchRemoteOkJobs(options)]);
  return uniqueBy(lists.flat(), item => item.link || item.id);
}

function fallbackJobFromCandidate(candidate, warning) {
  const link = safeUrl(candidate && candidate.link);
  const host = link ? new URL(link).hostname.replace(/^www\./, '') : '';
  const title = cleanText(candidate && candidate.title);
  return {
    id: stableJobId(link || title),
    company: host || '未知来源',
    role: inferRole(title),
    city: '',
    direction: '',
    link,
    jd: cleanText([title, candidate && candidate.snippet].filter(Boolean).join('\n')),
    source: candidate && candidate.source ? candidate.source : '公开搜索',
    crawledAt: Date.now(),
    fetchedAt: Date.now(),
    boardWarnings: warning ? [warning] : ['未能打开岗位详情页，已使用搜索摘要。'],
  };
}

function inferRole(title) {
  const s = cleanText(title);
  if (!s) return '未命名岗位';
  const parts = s.split(/\s[-_|·｜]\s|[-_|·｜]/).map(x => x.trim()).filter(Boolean);
  return (parts[0] || s).slice(0, 80);
}

function stableJobId(value) {
  const s = String(value || '') || String(Date.now());
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'jb_' + (h >>> 0).toString(36);
}

function normalizeBoardJob(job, candidate) {
  const link = safeUrl((job && job.link) || (candidate && candidate.link));
  const host = link ? new URL(link).hostname.replace(/^www\./, '') : '';
  const warnings = []
    .concat((job && job.crawlerWarnings) || [])
    .concat((job && job.boardWarnings) || [])
    .filter(Boolean);
  return {
    id: stableJobId(link || [job && job.company, job && job.role, job && job.jd].join('|')),
    company: cleanText((job && job.company) || host || '未知公司'),
    role: cleanText((job && job.role) || inferRole(candidate && candidate.title)),
    city: cleanText((job && job.city) || ''),
    direction: cleanText((job && job.direction) || ''),
    link,
    jd: cleanText((job && job.jd) || (candidate && candidate.snippet) || ''),
    source: cleanText((job && job.source) || (candidate && candidate.source) || host || '公开来源'),
    crawledAt: (job && job.crawledAt) || Date.now(),
    fetchedAt: Date.now(),
    datePosted: cleanText((job && job.datePosted) || (candidate && candidate.publishedAt) || ''),
    validThrough: cleanText((job && job.validThrough) || ''),
    boardWarnings: warnings,
  };
}

async function crawlCandidate(candidate) {
  try {
    const out = await crawlJobUrl(candidate.link);
    return normalizeBoardJob(out && out.job, candidate);
  } catch (e) {
    return fallbackJobFromCandidate(candidate, (e && e.message) || '岗位详情页抓取失败。');
  }
}

async function discoverJobs(options = {}) {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT));
  if (SEARCH_PROVIDER === 'bing-rss' || SEARCH_PROVIDER === 'hybrid') {
    const searchCandidates = await searchPublicJobs(options);
    const jobs = [];
    for (const candidate of searchCandidates.slice(0, limit)) {
      jobs.push(await crawlCandidate(candidate));
    }
    return uniqueBy(jobs, item => item.link || item.id).slice(0, limit);
  }
  const jobs = await fetchOfficialJobs(options);
  const filtered = jobs.filter(job =>
    matchesSearchIntent(options, [job.company, job.role, job.direction, job.city, job.jd]) &&
    matchesCityIntent(options, job)
  );
  return uniqueBy(filtered, item => item.link || item.id).slice(0, limit);
}

function matchesCityIntent(options, job) {
  const city = cleanText(options && options.city);
  if (!city) return true;
  const hay = [job && job.city, job && job.direction, job && job.jd].join(' ');
  const needles = city.split(/[\s,，/、]+/).map(x => x.trim()).filter(Boolean);
  return !needles.length || needles.some(part => termMatchesText(part, hay));
}

function containsTerm(text, term) {
  const hay = String(text || '').toLowerCase();
  const needle = String(term || '').toLowerCase();
  return !!needle && hay.indexOf(needle) >= 0;
}

function extractSkillTerms(text) {
  const out = [];
  SKILL_TERMS.forEach(term => {
    if (containsTerm(text, term)) out.push(term);
  });
  const english = String(text || '').match(/\b[A-Za-z][A-Za-z+#.]{1,18}\b/g) || [];
  english.forEach(term => {
    if (/^(and|or|the|with|for|to|of|in|on|a|an)$/i.test(term)) return;
    if (term.length < 2) return;
    out.push(term);
  });
  return uniqueBy(out, item => item.toLowerCase()).slice(0, 30);
}

function scoreOneJob(resumeText, job) {
  const resume = cleanText(resumeText);
  const jd = cleanText([job.role, job.direction, job.jd].filter(Boolean).join('\n'));
  const terms = extractSkillTerms(jd);
  const matched = terms.filter(term => containsTerm(resume, term));
  const missing = terms.filter(term => !containsTerm(resume, term)).slice(0, 8);
  const overlap = terms.length ? matched.length / terms.length : 0;
  const roleTerms = extractSkillTerms(job.role || '');
  const roleHit = roleTerms.length ? roleTerms.filter(term => containsTerm(resume, term)).length / roleTerms.length : 0;
  const evidenceBoost = Math.min(14, Math.floor((resume.length / 450) * 4));
  const score = Math.max(15, Math.min(96, Math.round(34 + overlap * 46 + roleHit * 10 + evidenceBoost)));
  const warnings = [];
  if (!terms.length) warnings.push('JD 信息较少，匹配度可信度偏低。');
  if (score < 55) warnings.push('简历中暂未明显体现多项岗位关键词。');
  return {
    matchScore: score,
    matchedKeywords: matched.slice(0, 10),
    missingKeywords: missing,
    summary: matched.length
      ? '简历已覆盖 ' + matched.slice(0, 4).join('、') + (matched.length > 4 ? ' 等能力。' : '。')
      : '暂未在简历中识别到明显匹配关键词。',
    warnings,
    method: 'fast_keyword_overlap',
  };
}

function scoreJobs(resumeText, jobs) {
  return (jobs || []).map(job => Object.assign({}, job, { boardMatch: scoreOneJob(resumeText, job) }));
}

async function refreshJobBoard(options = {}) {
  const jobs = await discoverJobs(options);
  const resumeText = cleanText(options.resumeText || '');
  return {
    jobs: resumeText ? scoreJobs(resumeText, jobs) : jobs,
    fetchedAt: Date.now(),
    query: {
      keywords: cleanText(options.keywords || ''),
      city: cleanText(options.city || ''),
      limit: Math.max(1, Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT)),
      sourceCount: configuredOfficialUrls(options.sourceUrls).length,
    },
    provider: SEARCH_PROVIDER,
  };
}

module.exports = {
  refreshJobBoard,
  discoverJobs,
  scoreJobs,
  scoreOneJob,
  parseRssItems,
};
