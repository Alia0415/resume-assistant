'use strict';

const dns = require('dns').promises;
const net = require('net');

const USER_AGENT = process.env.JOB_CRAWLER_USER_AGENT || 'ResumeAssistantBot/1.0 (+self-hosted personal job assistant; respects robots.txt)';
const FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.JOB_CRAWLER_TIMEOUT_MS) || 12000);
const MAX_HTML_BYTES = Math.max(200000, Number(process.env.JOB_CRAWLER_MAX_HTML_BYTES) || 2 * 1024 * 1024);
const CACHE_TTL_MS = Math.max(0, Number(process.env.JOB_CRAWLER_CACHE_TTL_MS) || 5 * 60 * 1000);
const HOST_COOLDOWN_MS = Math.max(0, Number(process.env.JOB_CRAWLER_HOST_COOLDOWN_MS) || 2500);

const resultCache = new Map();
const hostLastFetch = new Map();

function makeError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function normalizeUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch (e) {
    throw makeError('BAD_URL', '请输入有效的岗位链接。', 400);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw makeError('BAD_URL', '只支持 http/https 公开网页链接。', 400);
  }
  url.hash = '';
  return url;
}

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(n => Number(n));
    const a = parts[0], b = parts[1];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    const s = ip.toLowerCase();
    return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:');
  }
  return false;
}

async function assertPublicUrl(input) {
  const url = normalizeUrl(input);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw makeError('PRIVATE_URL', '为避免内网探测，不能抓取 localhost 或内网地址。', 400);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw makeError('PRIVATE_URL', '为避免内网探测，不能抓取内网地址。', 400);
    return url;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (e) {
    throw makeError('DNS_FAILED', '无法解析这个域名，请检查岗位链接是否可访问。', 400);
  }
  if (!records.length || records.some(r => isPrivateIp(r.address))) {
    throw makeError('PRIVATE_URL', '为避免内网探测，不能抓取解析到内网的地址。', 400);
  }
  return url;
}

async function readLimitedText(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (e) {}
      throw makeError('TOO_LARGE', '页面内容过大，已停止抓取。', 413);
    }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

async function fetchText(url, options = {}) {
  let current = await assertPublicUrl(url);
  const maxRedirects = typeof options.maxRedirects === 'number' ? options.maxRedirects : 4;
  for (let i = 0; i <= maxRedirects; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(current.href, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.8,*/*;q=0.5',
        },
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw makeError('TIMEOUT', '抓取超时，请稍后重试或换一个岗位链接。', 504);
      throw makeError('FETCH_FAILED', '无法访问这个岗位链接：' + ((e && e.message) || '网络错误'), 502);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = await assertPublicUrl(new URL(response.headers.get('location'), current).href);
      continue;
    }
    if (!response.ok) {
      throw makeError('HTTP_ERROR', '岗位页面返回 HTTP ' + response.status + '，暂时无法抓取。', response.status);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const text = await readLimitedText(response, options.maxBytes || MAX_HTML_BYTES);
    return { text, contentType, finalUrl: current.href };
  }
  throw makeError('TOO_MANY_REDIRECTS', '岗位链接跳转次数过多，已停止抓取。', 400);
}

function stripComment(line) {
  const i = line.indexOf('#');
  return (i >= 0 ? line.slice(0, i) : line).trim();
}

function robotsPatternMatches(path, pattern) {
  if (!pattern) return false;
  let source = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  if (source.endsWith('\\$')) source = source.slice(0, -2) + '$';
  return new RegExp('^' + source).test(path);
}

function robotsAllows(robotsText, targetUrl, userAgent) {
  const path = targetUrl.pathname + targetUrl.search;
  const groups = [];
  let current = null;
  String(robotsText || '').split(/\r?\n/).forEach(raw => {
    const line = stripComment(raw);
    if (!line) return;
    const idx = line.indexOf(':');
    if (idx < 0) return;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ type: key, value });
    }
  });

  const ua = String(userAgent || '').toLowerCase().split('/')[0];
  let matched = groups.filter(g => g.agents.some(a => a === ua));
  if (!matched.length) matched = groups.filter(g => g.agents.some(a => a === '*'));
  if (!matched.length) return true;

  let best = null;
  matched.forEach(group => {
    group.rules.forEach(rule => {
      if (rule.type === 'disallow' && !rule.value) return;
      if (!robotsPatternMatches(path, rule.value)) return;
      const len = rule.value.length;
      if (!best || len > best.len || (len === best.len && rule.type === 'allow')) {
        best = { type: rule.type, len };
      }
    });
  });
  return !best || best.type === 'allow';
}

async function checkRobots(targetUrl) {
  const robotsUrl = new URL('/robots.txt', targetUrl);
  try {
    const out = await fetchText(robotsUrl.href, {
      accept: 'text/plain,*/*;q=0.5',
      timeoutMs: Math.min(FETCH_TIMEOUT_MS, 6000),
      maxBytes: 300000,
      maxRedirects: 2,
    });
    return robotsAllows(out.text, targetUrl, USER_AGENT);
  } catch (e) {
    if (e && (e.code === 'HTTP_ERROR' || e.status === 404 || e.status === 403)) return true;
    return true;
  }
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

function cleanText(value) {
  return decodeEntities(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToText(html) {
  return cleanText(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '\n')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n')
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n'));
}

function getTagText(html, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = String(html || '').match(re);
  return m ? cleanText(m[1].replace(/<[^>]+>/g, ' ')) : '';
}

function getMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<meta\\b[^>]*(?:name|property)=["\\\']' + escaped + '["\\\'][^>]*>', 'i');
  const tag = String(html || '').match(re);
  if (!tag) return '';
  const content = tag[0].match(/\bcontent=["']([^"']*)["']/i);
  return content ? cleanText(content[1]) : '';
}

function getCanonical(html, finalUrl) {
  const tag = String(html || '').match(/<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i);
  if (!tag) return finalUrl;
  const href = tag[0].match(/\bhref=["']([^"']+)["']/i);
  if (!href) return finalUrl;
  try { return new URL(decodeEntities(href[1]), finalUrl).href; } catch (e) { return finalUrl; }
}

function parseJsonMaybe(raw) {
  const text = decodeEntities(raw).trim();
  try { return JSON.parse(text); } catch (e) {}
  try { return JSON.parse(text.replace(/,\s*([}\]])/g, '$1')); } catch (e) {}
  return null;
}

function flattenJsonLd(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach(item => flattenJsonLd(item, out));
    return out;
  }
  if (typeof value === 'object') {
    out.push(value);
    if (value['@graph']) flattenJsonLd(value['@graph'], out);
  }
  return out;
}

function extractJobPosting(html) {
  const blocks = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) blocks.push(m[1]);
  for (const block of blocks) {
    const parsed = parseJsonMaybe(block);
    const nodes = flattenJsonLd(parsed);
    const job = nodes.find(node => {
      const type = node && node['@type'];
      const types = Array.isArray(type) ? type : [type];
      return types.some(t => String(t || '').toLowerCase() === 'jobposting');
    });
    if (job) return job;
  }
  return null;
}

function firstString(value) {
  if (Array.isArray(value)) return firstString(value[0]);
  if (value && typeof value === 'object') return firstString(value.name || value.title || value.value);
  return cleanText(value || '');
}

function parseLocation(value) {
  const items = Array.isArray(value) ? value : [value];
  const parts = [];
  items.forEach(item => {
    const address = item && (item.address || item);
    if (typeof address === 'string') parts.push(address);
    else if (address && typeof address === 'object') {
      parts.push(address.addressLocality, address.addressRegion, address.addressCountry);
    }
  });
  const seen = new Set();
  return cleanText(parts.filter(Boolean).filter(part => {
    const key = cleanText(part).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(' '));
}

function inferRoleFromTitle(title) {
  const s = cleanText(title);
  if (!s) return '';
  return s.split(/\s[-_|·｜]\s|[-_|·｜]/)[0].trim().slice(0, 80);
}

function parseJobHtml(html, finalUrl) {
  const pageTitle = getMeta(html, 'og:title') || getTagText(html, 'title');
  const description = getMeta(html, 'description') || getMeta(html, 'og:description');
  const siteName = getMeta(html, 'og:site_name');
  const canonicalUrl = getCanonical(html, finalUrl);
  const job = extractJobPosting(html);
  const bodyText = htmlToText(html);

  let role = '';
  let company = '';
  let city = '';
  let jdText = '';
  let datePosted = '';
  let validThrough = '';
  let employmentType = '';
  const warnings = [];

  if (job) {
    role = firstString(job.title);
    company = firstString(job.hiringOrganization);
    city = parseLocation(job.jobLocation || job.applicantLocationRequirements);
    jdText = htmlToText(job.description || '');
    datePosted = firstString(job.datePosted);
    validThrough = firstString(job.validThrough);
    employmentType = firstString(job.employmentType);
  } else {
    warnings.push('页面没有发现 schema.org JobPosting 结构化数据，已使用正文文本兜底。');
  }

  if (!role) role = inferRoleFromTitle(pageTitle);
  if (!company) company = siteName || '';
  if (description && jdText.indexOf(description) < 0 && jdText.length < 1000) jdText = description + '\n\n' + jdText;
  if (!jdText) jdText = bodyText;
  if (!jdText || jdText.length < 60) warnings.push('页面正文较短，可能需要你手动补充 JD。');

  jdText = jdText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter((line, index, arr) => line && arr.indexOf(line) === index)
    .join('\n')
    .slice(0, 12000);

  const host = new URL(finalUrl).hostname.replace(/^www\./, '');
  return {
    role,
    company,
    city,
    direction: employmentType || '',
    jdText,
    sourceName: siteName || host,
    link: canonicalUrl || finalUrl,
    pageTitle,
    datePosted,
    validThrough,
    employmentType,
    warnings,
  };
}

function cacheSet(key, value) {
  if (!CACHE_TTL_MS) return;
  resultCache.set(key, { at: Date.now(), value });
  if (resultCache.size > 100) {
    const first = resultCache.keys().next().value;
    resultCache.delete(first);
  }
}

function cacheGet(key) {
  if (!CACHE_TTL_MS) return null;
  const hit = resultCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    resultCache.delete(key);
    return null;
  }
  return Object.assign({}, hit.value, { fromCache: true });
}

async function crawlJobUrl(inputUrl) {
  const safeUrl = await assertPublicUrl(inputUrl);
  const cacheKey = safeUrl.href;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const host = safeUrl.hostname.toLowerCase();
  const last = hostLastFetch.get(host) || 0;
  if (HOST_COOLDOWN_MS && Date.now() - last < HOST_COOLDOWN_MS) {
    throw makeError('HOST_COOLDOWN', '刚刚抓取过这个网站，请稍等几秒再试。', 429);
  }

  const allowed = await checkRobots(safeUrl);
  if (!allowed) {
    throw makeError('ROBOTS_BLOCKED', '该网站 robots.txt 不允许抓取这个页面，请手动粘贴 JD。', 403);
  }

  hostLastFetch.set(host, Date.now());
  const fetched = await fetchText(safeUrl.href);
  const contentType = fetched.contentType || '';
  if (contentType && !/text\/html|application\/xhtml\+xml|application\/xml|text\/plain/.test(contentType)) {
    throw makeError('BAD_CONTENT_TYPE', '这个链接不是可解析的网页内容。', 415);
  }
  const parsed = parseJobHtml(fetched.text, fetched.finalUrl);
  const result = {
    ok: true,
    fetchedAt: Date.now(),
    fromCache: false,
    robotsAllowed: true,
    finalUrl: fetched.finalUrl,
    job: {
      company: parsed.company || '',
      role: parsed.role || '',
      city: parsed.city || '',
      direction: parsed.direction || '',
      link: parsed.link || fetched.finalUrl,
      jd: parsed.jdText || '',
      source: parsed.sourceName ? ('网页抓取 · ' + parsed.sourceName) : '网页抓取',
      crawledAt: Date.now(),
      datePosted: parsed.datePosted || '',
      validThrough: parsed.validThrough || '',
      crawlerWarnings: parsed.warnings || [],
    },
    meta: {
      pageTitle: parsed.pageTitle || '',
      sourceName: parsed.sourceName || '',
      contentLength: fetched.text.length,
      warnings: parsed.warnings || [],
    },
  };
  cacheSet(cacheKey, result);
  return result;
}

module.exports = {
  crawlJobUrl,
  parseJobHtml,
  htmlToText,
  robotsAllows,
  assertPublicUrl,
};
