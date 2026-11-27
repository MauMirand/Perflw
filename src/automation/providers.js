'use strict';
/* Provider adapter layer. Extends the original runtime boundary (ollama.js) to several LLM services.
   Every adapter exposes the same two calls:
     listModels({ connection, apiKey, signal })  → [{ id, contextWindow }]
     chat({ connection, apiKey, model, system, messages, tools, maxTokens, cache, signal, onDelta })
       → { text, toolCalls: [{ id, name, arguments }], usage: { inputTokens, outputTokens, cachedTokens } | null }
   Messages use one neutral shape: { role: 'user' | 'assistant' | 'tool', content, toolCalls?, toolCallId?, name?, images? }.
   images (user messages only): [{ mime: 'image/png' | 'image/jpeg' | 'image/webp', data: <base64> }] for vision models.
   Provider-specific wire formats stay inside this file. API keys are passed in per call, never stored here,
   and are scrubbed from every error message. */

const { createOllamaRuntime } = require('./ollama');

const TIMEOUT_MS = 180000;

/* What each provider type supports. `tools` and `caching` describe the API, not every model:
   adapters still report a clear error when a particular model refuses a feature. */
const PROVIDER_TYPES = Object.freeze({
  ollama: { label: 'Ollama (local)', needsKey: false, fixedBase: 'http://127.0.0.1:11434', discovery: true, streaming: true, tools: 'model', caching: 'none', defaultContext: 4096, local: true },
  openai: { label: 'OpenAI', needsKey: true, fixedBase: 'https://api.openai.com/v1', discovery: true, streaming: true, tools: true, caching: 'automatic', defaultContext: 128000, local: false },
  anthropic: { label: 'Anthropic', needsKey: true, fixedBase: 'https://api.anthropic.com/v1', discovery: true, streaming: true, tools: true, caching: 'explicit', defaultContext: 200000, local: false },
  gemini: { label: 'Google Gemini', needsKey: true, fixedBase: 'https://generativelanguage.googleapis.com/v1beta', discovery: true, streaming: true, tools: true, caching: 'none', defaultContext: 1000000, local: false },
  'openai-compatible': { label: 'Custom (OpenAI-compatible)', needsKey: false, fixedBase: null, discovery: 'optional', streaming: true, tools: 'configured', caching: 'none', defaultContext: 8192, local: false }
});

class ProviderError extends Error {
  constructor(kind, message, status = null) { super(message); this.name = 'ProviderError'; this.kind = kind; this.status = status; }
}

/* Removes the key (and anything that looks like a bearer secret) from text shown to people or logs. */
function redact(text, apiKey) {
  let value = String(text ?? '');
  if (apiKey && apiKey.length >= 4) value = value.split(apiKey).join('[redacted]');
  return value.replace(/\b(sk|pk|rk|key|AIza)[-_A-Za-z0-9]{12,}\b/g, '[redacted]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]');
}

function abortError() { const error = new Error('Run cancelled.'); error.name = 'AbortError'; return error; }

/* fetch with a cancel signal and an overall timeout; maps transport failures to ProviderErrors. */
async function send(fetchImpl, url, init, { signal, apiKey, label, timeoutMs = TIMEOUT_MS }) {
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    // The cancel link stays attached on success: a streamed body is still being read after the headers
    // arrive, and stopping the run must end that stream too.
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new ProviderError('timeout', `${label} did not respond in time.`);
    // Node/Electron fetch may wrap the socket error (or several, one per address) inside `cause`.
    const code = error?.cause?.code || error?.cause?.errors?.[0]?.code || error?.code || '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new ProviderError('network', `${label}: the endpoint address could not be found. Check the base URL and your internet connection.`);
    if (code === 'ECONNREFUSED') throw new ProviderError('network', `${label}: the endpoint refused the connection. Check that the service is running and the base URL is right.`);
    if (/invalid url|failed to parse url/i.test(error?.message || '')) throw new ProviderError('invalid_request', `${label}: the base URL is not valid.`);
    throw new ProviderError('network', `${label} could not be reached (${redact(error?.message || 'network error', apiKey)}).`);
  }
}

/* Turns a non-2xx response into an actionable ProviderError without leaking secrets. */
async function failure(response, { label, apiKey, model }) {
  let detail = '';
  try {
    const text = await response.text();
    try { const body = JSON.parse(text); detail = body?.error?.message || body?.error?.status || (typeof body?.error === 'string' ? body.error : '') || body?.message || ''; }
    catch { detail = text.slice(0, 300); }
  } catch { /* no body */ }
  detail = redact(detail, apiKey).trim();
  const status = response.status; const suffix = detail ? ` (${detail})` : '';
  if (status === 401 || status === 403) return new ProviderError('auth', `${label} rejected the API key. Check or replace the key in the provider settings${suffix}.`, status);
  if (status === 404) return new ProviderError('not_found', model ? `${label} does not offer the model “${model}”, or the endpoint path is wrong${suffix}.` : `${label}: endpoint not found. Check the base URL${suffix}.`, status);
  if (status === 429) return new ProviderError('rate_limit', `${label} is rate-limiting requests or the account is out of quota. Wait and try again${suffix}.`, status);
  if (status === 413 || /context|too long|maximum.*tokens|token limit/i.test(detail)) return new ProviderError('context_length', `${label}: the request is larger than the model accepts. Reduce context or choose a model with a larger window${suffix}.`, status);
  if (status === 400 || status === 422) return new ProviderError('invalid_request', `${label} rejected the request${suffix}.`, status);
  if (status >= 500) return new ProviderError('server', `${label} had a server error (${status}). Try again later${suffix}.`, status);
  return new ProviderError('provider', `${label} answered with status ${status}${suffix}.`, status);
}

/* Server-sent events: yields each `data:` payload (and its event name). */
async function* sse(body) {
  const decoder = new TextDecoder(); let buffer = '';
  const parse = block => {
    let event = 'message'; const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    return data.length ? { event, data: data.join('\n') } : null;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, index); buffer = buffer.slice(buffer[index] === '\r' ? index + 4 : index + 2);
      const item = parse(block); if (item) yield item;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) { const item = parse(buffer); if (item) yield item; }
}
const json = text => { try { return JSON.parse(text); } catch { return null; } };
const parseArgs = value => {
  if (value && typeof value === 'object') return value;
  const parsed = json(value || '{}');
  return parsed && typeof parsed === 'object' ? parsed : { __invalid: String(value) };
};

// ───────────────────────── OpenAI and OpenAI-compatible (Chat Completions)
function openAiAdapter(fetchImpl, { compatible }) {
  const base = connection => (compatible ? String(connection.baseUrl || '').replace(/\/+$/, '') : PROVIDER_TYPES.openai.fixedBase);
  const headers = apiKey => ({ 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) });
  const label = connection => connection.label || (compatible ? 'The custom endpoint' : 'OpenAI');
  const NON_CHAT = /embedding|whisper|tts|dall-e|davinci|babbage|moderation|image|audio|realtime|transcribe|search|computer-use/i;

  async function listModels({ connection, apiKey, signal }) {
    const response = await send(fetchImpl, `${base(connection)}/models`, { headers: headers(apiKey) }, { signal, apiKey, label: label(connection), timeoutMs: 15000 });
    if (!response.ok) throw await failure(response, { label: label(connection), apiKey });
    const body = await response.json().catch(() => null);
    const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    return items.map(item => ({ id: String(item.id || item.name || ''), contextWindow: Number(item.context_length || item.context_window || 0) || null }))
      .filter(item => item.id && (compatible || !NON_CHAT.test(item.id))).sort((a, b) => a.id.localeCompare(b.id));
  }
  function wireMessages(system, messages) {
    const out = system ? [{ role: 'system', content: system }] : [];
    for (const message of messages) {
      if (message.role === 'tool') out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
      else if (message.role === 'assistant' && message.toolCalls?.length) out.push({ role: 'assistant', content: message.content || null, tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } })) });
      else if (message.role === 'user' && message.images?.length) out.push({ role: 'user', content: [{ type: 'text', text: message.content }, ...message.images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } }))] });
      else out.push({ role: message.role, content: message.content });
    }
    return out;
  }
  async function chat({ connection, apiKey, model, system, messages, tools, maxTokens, temperature = null, signal, onDelta = () => {} }) {
    const stream = !(tools && tools.length);
    const body = { model, messages: wireMessages(system, messages), stream, ...(temperature != null ? { temperature } : {}) };
    if (!stream) body.tools = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    if (maxTokens) body[compatible ? 'max_tokens' : 'max_completion_tokens'] = maxTokens;
    if (stream && !compatible) body.stream_options = { include_usage: true };
    const response = await send(fetchImpl, `${base(connection)}/chat/completions`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) }, { signal, apiKey, label: label(connection) });
    if (!response.ok) throw await failure(response, { label: label(connection), apiKey, model });
    const usageOf = usage => (usage ? { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null } : null);
    if (!stream) {
      const data = await response.json();
      const message = data?.choices?.[0]?.message || {};
      const text = typeof message.content === 'string' ? message.content : '';
      if (text) onDelta(text);
      const toolCalls = (message.tool_calls || []).map(call => ({ id: call.id, name: call.function?.name || '', arguments: parseArgs(call.function?.arguments) }));
      return { text, toolCalls, usage: usageOf(data?.usage), truncated: data?.choices?.[0]?.finish_reason === 'length' };
    }
    let text = ''; let usage = null; let truncated = false;
    try {
      for await (const { data } of sse(response.body)) {
        if (data === '[DONE]') break;
        const part = json(data); if (!part) continue;
        if (part.error) throw new ProviderError('provider', `${label(connection)}: ${redact(part.error.message || 'stream error', apiKey)}`);
        const piece = part.choices?.[0]?.delta?.content;
        if (typeof piece === 'string' && piece) { text += piece; onDelta(piece); }
        if (part.choices?.[0]?.finish_reason === 'length') truncated = true;
        if (part.usage) usage = usageOf(part.usage);
      }
    } catch (error) { if (signal?.aborted) throw abortError(); throw error; }
    return { text, toolCalls: [], usage, truncated };
  }
  return { listModels, chat };
}

// ───────────────────────── Anthropic (Messages API)
function anthropicAdapter(fetchImpl) {
  const BASE = PROVIDER_TYPES.anthropic.fixedBase;
  const headers = apiKey => ({ 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' });
  const label = connection => connection.label || 'Anthropic';
  async function listModels({ connection, apiKey, signal }) {
    const response = await send(fetchImpl, `${BASE}/models?limit=100`, { headers: headers(apiKey) }, { signal, apiKey, label: label(connection), timeoutMs: 15000 });
    if (!response.ok) throw await failure(response, { label: label(connection), apiKey });
    const body = await response.json().catch(() => null);
    return (Array.isArray(body?.data) ? body.data : []).map(item => ({ id: String(item.id), contextWindow: Number(item.max_input_tokens) || null })).filter(item => item.id);
  }
  /* Neutral messages → alternating user/assistant turns; consecutive tool results share one user turn. */
  function wireMessages(messages) {
    const out = [];
    const push = (role, blocks) => { const last = out[out.length - 1]; if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: blocks }); };
    for (const message of messages) {
      if (message.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content, ...(message.isError ? { is_error: true } : {}) }]);
      // Replaying the provider's own blocks keeps thinking blocks intact, which tool use on current models requires.
      else if (message.role === 'assistant' && Array.isArray(message.native)) push('assistant', message.native);
      else if (message.role === 'assistant') push('assistant', [...(message.content ? [{ type: 'text', text: message.content }] : []), ...(message.toolCalls || []).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments || {} }))]);
      else push('user', [...(message.images || []).map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } })), { type: 'text', text: message.content }]);
    }
    return out;
  }
  async function chat({ connection, apiKey, model, system, messages, tools, maxTokens, cache, temperature = null, signal, onDelta = () => {} }) {
    const stream = !(tools && tools.length);
    const body = { model, max_tokens: maxTokens || 4096, messages: wireMessages(messages), stream, ...(temperature != null ? { temperature } : {}) };
    // Explicit prompt caching marks the stable system prefix; the API ignores prefixes below its minimum size.
    if (system) body.system = cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
    if (!stream) body.tools = tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    const response = await send(fetchImpl, `${BASE}/messages`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) }, { signal, apiKey, label: label(connection) });
    if (!response.ok) throw await failure(response, { label: label(connection), apiKey, model });
    const usageOf = usage => (usage ? { inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0), outputTokens: usage.output_tokens ?? null, cachedTokens: usage.cache_read_input_tokens ?? null } : null);
    const refusal = stopReason => { if (stopReason === 'refusal') throw new ProviderError('refusal', `${label(connection)} declined this request.`); };
    if (!stream) {
      const data = await response.json();
      refusal(data.stop_reason);
      const blocks = Array.isArray(data.content) ? data.content : [];
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('');
      if (text) onDelta(text);
      const toolCalls = blocks.filter(block => block.type === 'tool_use').map(block => ({ id: block.id, name: block.name, arguments: block.input || {} }));
      return { text, toolCalls, usage: usageOf(data.usage), native: blocks, truncated: data.stop_reason === 'max_tokens' };
    }
    let text = ''; let usage = null; let truncated = false;
    try {
      for await (const { data } of sse(response.body)) {
        const part = json(data); if (!part) continue;
        if (part.type === 'error') throw new ProviderError('provider', `${label(connection)}: ${redact(part.error?.message || 'stream error', apiKey)}`);
        if (part.type === 'message_start') usage = usageOf(part.message?.usage);
        if (part.type === 'content_block_delta' && part.delta?.type === 'text_delta') { text += part.delta.text; onDelta(part.delta.text); }
        if (part.type === 'message_delta') {
          refusal(part.delta?.stop_reason); if (part.delta?.stop_reason === 'max_tokens') truncated = true;
          if (part.usage?.output_tokens !== undefined) usage = { ...(usage || { inputTokens: null, cachedTokens: null }), outputTokens: part.usage.output_tokens };
        }
      }
    } catch (error) { if (signal?.aborted) throw abortError(); throw error; }
    return { text, toolCalls: [], usage, truncated };
  }
  return { listModels, chat };
}

// ───────────────────────── Google Gemini (generateContent)
function geminiAdapter(fetchImpl) {
  const BASE = PROVIDER_TYPES.gemini.fixedBase;
  const headers = apiKey => ({ 'content-type': 'application/json', 'x-goog-api-key': apiKey });
  const label = connection => connection.label || 'Google Gemini';
  async function listModels({ connection, apiKey, signal }) {
    const response = await send(fetchImpl, `${BASE}/models?pageSize=200`, { headers: headers(apiKey) }, { signal, apiKey, label: label(connection), timeoutMs: 15000 });
    if (!response.ok) throw await failure(response, { label: label(connection), apiKey });
    const body = await response.json().catch(() => null);
    return (Array.isArray(body?.models) ? body.models : [])
      .filter(item => (item.supportedGenerationMethods || []).includes('generateContent'))
      .map(item => ({ id: String(item.name || '').replace(/^models\//, ''), contextWindow: Number(item.inputTokenLimit) || null })).filter(item => item.id);
  }
  // Gemini accepts an OpenAPI subset: drop JSON-Schema keywords it rejects.
  const schema = value => {
    if (Array.isArray(value)) return value.map(schema);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, item] of Object.entries(value)) if (key !== 'additionalProperties' && key !== '$schema') out[key] = schema(item);
    return out;
  };
  function wireContents(messages) {
    const out = []; const names = new Map();
    const push = (role, parts) => { const last = out[out.length - 1]; if (last && last.role === role) last.parts.push(...parts); else out.push({ role, parts }); };
    for (const message of messages) {
      if (message.role === 'assistant') {
        for (const call of message.toolCalls || []) names.set(call.id, call.name);
        if (Array.isArray(message.native)) { push('model', message.native); continue; } // keeps thought signatures
        push('model', [...(message.content ? [{ text: message.content }] : []), ...(message.toolCalls || []).map(call => ({ functionCall: { name: call.name, args: call.arguments || {} } }))]);
      } else if (message.role === 'tool') push('user', [{ functionResponse: { name: message.name || names.get(message.toolCallId) || 'tool', response: { content: message.content } } }]);
      else push('user', [{ text: message.content }, ...(message.images || []).map(image => ({ inline_data: { mime_type: image.mime, data: image.data } }))]);
    }
    return out;
  }
  async function chat({ connection, apiKey, model, system, messages, tools, maxTokens, temperature = null, signal, onDelta = () => {} }) {
    const stream = !(tools && tools.length);
    const body = { contents: wireContents(messages), ...(temperature != null ? { generationConfig: { temperature } } : {}) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (maxTokens) body.generationConfig = { maxOutputTokens: maxTokens };
    if (!stream) body.tools = [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, ...(Object.keys(tool.parameters?.properties || {}).length ? { parameters: schema(tool.parameters) } : {}) })) }];
    const path = `${BASE}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
    const response = await send(fetchImpl, path, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body) }, { signal, apiKey, label: label(connection) });
    if (!response.ok) throw await failure(response, { label: label(connection), apiKey, model });
    const usageOf = meta => (meta ? { inputTokens: meta.promptTokenCount ?? null, outputTokens: meta.candidatesTokenCount ?? null, cachedTokens: meta.cachedContentTokenCount ?? null } : null);
    const blocked = data => { const reason = data?.promptFeedback?.blockReason; if (reason) throw new ProviderError('refusal', `${label(connection)} blocked this request (${reason}).`); };
    if (!stream) {
      const data = await response.json();
      blocked(data);
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('');
      if (text) onDelta(text);
      const toolCalls = parts.filter(part => part.functionCall).map((part, index) => ({ id: `call_${index}`, name: part.functionCall.name, arguments: part.functionCall.args || {} }));
      return { text, toolCalls, usage: usageOf(data.usageMetadata), native: parts, truncated: data?.candidates?.[0]?.finishReason === 'MAX_TOKENS' };
    }
    let text = ''; let usage = null;
    try {
      for await (const { data } of sse(response.body)) {
        const part = json(data); if (!part) continue;
        if (part.error) throw new ProviderError('provider', `${label(connection)}: ${redact(part.error.message || 'stream error', apiKey)}`);
        blocked(part);
        for (const piece of part.candidates?.[0]?.content?.parts || []) if (typeof piece.text === 'string' && piece.text) { text += piece.text; onDelta(piece.text); }
        if (part.usageMetadata) usage = usageOf(part.usageMetadata);
      }
    } catch (error) { if (signal?.aborted) throw abortError(); throw error; }
    return { text, toolCalls: [], usage };
  }
  return { listModels, chat };
}

// ───────────────────────── Ollama (wraps the original runtime)
function ollamaAdapter(fetchImpl, base) {
  const runtime = createOllamaRuntime({ fetchImpl, ...(base ? { base } : {}) });
  async function listModels() {
    const listed = await runtime.listModels();
    if (!listed.available) throw new ProviderError('network', listed.error || 'Ollama is not available.');
    return listed.models.map(model => ({ id: model.name, contextWindow: null, size: model.size, bytes: model.bytes, cloud: model.cloud }));
  }
  function wireMessages(system, messages) {
    const out = system ? [{ role: 'system', content: system }] : [];
    for (const message of messages) {
      if (message.role === 'tool') out.push({ role: 'tool', content: message.content, tool_name: message.name });
      else if (message.role === 'assistant' && message.toolCalls?.length) out.push({ role: 'assistant', content: message.content || '', tool_calls: message.toolCalls.map(call => ({ function: { name: call.name, arguments: call.arguments || {} } })) });
      else out.push({ role: message.role, content: message.content, ...(message.images?.length ? { images: message.images.map(image => image.data) } : {}) });
    }
    return out;
  }
  async function chat({ model, system, messages, tools, numCtx, numPredict = null, format = null, think = null, temperature = null, signal, onDelta, agentName }) {
    try {
      const result = await runtime.chat({
        model, name: agentName, messages: wireMessages(system, messages), signal, onDelta, format, think,
        tools: tools && tools.length ? tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) : null,
        options: numCtx || temperature != null || numPredict ? { ...(numCtx ? { num_ctx: numCtx } : {}), ...(temperature != null ? { temperature } : {}), ...(numPredict ? { num_predict: numPredict } : {}) } : null
      });
      return { ...result, usage: result.usage ? { ...result.usage, cachedTokens: null } : null };
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof ProviderError) throw error;
      throw new ProviderError(error.kind || (/not running/i.test(error.message) ? 'network' : /not installed/i.test(error.message) ? 'not_found' : 'provider'), error.message);
    }
  }
  return { listModels, chat, modelInfo: runtime.modelInfo };
}

function createProviders({ fetchImpl = fetch, ollamaBase = null } = {}) {
  const adapters = {
    ollama: ollamaAdapter(fetchImpl, ollamaBase),
    openai: openAiAdapter(fetchImpl, { compatible: false }),
    'openai-compatible': openAiAdapter(fetchImpl, { compatible: true }),
    anthropic: anthropicAdapter(fetchImpl),
    gemini: geminiAdapter(fetchImpl)
  };
  const adapterFor = type => adapters[type] || (() => { throw new ProviderError('invalid_request', 'Unknown provider type.'); })();

  /* Does this connection/model accept tool definitions? false when unknown, so tools are never promised falsely. */
  async function supportsTools(connection, model) {
    const type = PROVIDER_TYPES[connection.type];
    if (!type) return false;
    if (type.tools === true) return true;
    if (type.tools === 'configured') return Boolean(connection.supportsTools);
    if (connection.type === 'ollama') { const info = await adapters.ollama.modelInfo(model); return Boolean(info && info.tools); }
    return false;
  }
  /* Context window for a model: connection override → provider-reported → provider default. */
  async function contextWindow(connection, model, { apiKey } = {}) {
    if (Number(connection.contextWindow) > 0) return { tokens: Number(connection.contextWindow), source: 'connection setting' };
    if (connection.type === 'ollama') {
      const info = await adapters.ollama.modelInfo(model);
      // Ollama silently truncates at num_ctx; the runner asks for the agent's budget explicitly (see ecosystem.js).
      return info && info.contextLength ? { tokens: info.contextLength, source: 'Ollama model info' } : { tokens: PROVIDER_TYPES.ollama.defaultContext, source: 'Ollama default' };
    }
    try {
      const listed = await adapterFor(connection.type).listModels({ connection, apiKey });
      const found = listed.find(item => item.id === model);
      if (found && found.contextWindow) return { tokens: found.contextWindow, source: 'provider model list' };
    } catch { /* fall back to the type default */ }
    return { tokens: PROVIDER_TYPES[connection.type].defaultContext, source: 'provider default (estimate)' };
  }
  async function testConnection(connection, apiKey) {
    const type = PROVIDER_TYPES[connection.type];
    if (!type) return { ok: false, message: 'Unknown provider type.' };
    if (type.needsKey && !apiKey) return { ok: false, message: `${type.label} needs an API key. Add one and test again.` };
    if (connection.type === 'openai-compatible' && !/^https?:\/\//i.test(connection.baseUrl || '')) return { ok: false, message: 'Enter the endpoint base URL, for example http://localhost:1234/v1.' };
    try {
      const models = await adapterFor(connection.type).listModels({ connection, apiKey });
      const model = connection.model;
      if (model && models.length && !models.some(item => item.id === model))
        return { ok: true, models, message: `Connected to ${type.label}, but the model “${model}” is not in its model list. Pick a listed model or keep it if you know it exists.` };
      return { ok: true, models, message: `Connected to ${type.label}. ${models.length} model${models.length === 1 ? '' : 's'} available.` };
    } catch (error) {
      // Some OpenAI-compatible servers have no /models route: a 404 there is not a failed connection.
      if (connection.type === 'openai-compatible' && error.kind === 'not_found')
        return { ok: true, models: [], message: 'Connected, but this endpoint does not list models. Enter the model name manually.' };
      return { ok: false, message: redact(error.message, apiKey) };
    }
  }
  return { types: PROVIDER_TYPES, adapterFor, supportsTools, contextWindow, testConnection };
}

module.exports = { createProviders, PROVIDER_TYPES, ProviderError, redact, sse };
