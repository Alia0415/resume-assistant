'use strict';

/**
 * DeepSeek 调用封装
 * - API Key 仅从后端环境变量读取，绝不下发到前端。
 * - 使用 OpenAI SDK 的兼容方式调用 DeepSeek（baseURL=https://api.deepseek.com）。
 * - 所有调用都要求模型返回 JSON，并在解析失败时做兜底。
 */

const OpenAI = require('openai');

const BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';

/**
 * 构造 DeepSeek 客户端。
 * 未配置 DEEPSEEK_API_KEY 时抛出带 code 的错误，由上层转成明确提示。
 */
function createDeepSeekClient() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    const err = new Error('DeepSeek API Key 未配置，请先在后端环境变量中添加 DEEPSEEK_API_KEY。');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return new OpenAI({ apiKey: apiKey.trim(), baseURL: BASE_URL });
}

/**
 * 把模型返回的字符串安全解析为 JSON 对象。
 * 兼容 ```json 代码块包裹、前后多余文字等情况；彻底失败时抛出 BAD_JSON。
 */
function safeParseJSON(raw) {
  if (raw == null || String(raw).trim() === '') {
    const err = new Error('AI 返回为空，请稍后重试。');
    err.code = 'BAD_JSON';
    throw err;
  }
  let s = String(raw).trim();
  // 去掉可能的 ```json ... ``` 代码块围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    // 兜底：截取第一个 { 到最后一个 } 再尝试
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch (e2) { /* fall through */ }
    }
    const err = new Error('AI 返回的内容无法解析为 JSON，请重试。');
    err.code = 'BAD_JSON';
    err.raw = String(raw).slice(0, 500);
    throw err;
  }
}

/**
 * 用一组 messages 调用 DeepSeek，返回已解析的 JSON 对象。
 * @param {Array<{role:string, content:string}>} messages
 * @param {{model?:string, temperature?:number, maxTokens?:number}} [options]
 */
async function callDeepSeekJSON(messages, options = {}) {
  const client = createDeepSeekClient();
  const model = options.model || DEFAULT_MODEL;
  const completion = await client.chat.completions.create({
    model,
    messages,
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.3,
    max_tokens: options.maxTokens || 2200,
    response_format: { type: 'json_object' },
  });
  const raw =
    completion &&
    completion.choices &&
    completion.choices[0] &&
    completion.choices[0].message &&
    completion.choices[0].message.content;
  return safeParseJSON(raw);
}

module.exports = {
  createDeepSeekClient,
  callDeepSeekJSON,
  safeParseJSON,
  DEFAULT_MODEL,
  BASE_URL,
};
