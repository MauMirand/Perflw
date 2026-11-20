'use strict';
/* Agent runtime adapter: local Ollama.
   This is the only file that talks to a model. It is deliberately fixed to the loopback address, so the
   app's only network traffic is to the Ollama service on this computer. To add another runtime later,
   implement the same two functions ({ listModels, runAgent }) and pass it to the IPC layer in main.js. */

const BASE = 'http://127.0.0.1:11434';
const IDLE_TIMEOUT_MS = 180000;
/* How long Ollama keeps a model loaded after a request. Its own default (5 minutes) holds gigabytes of RAM / VRAM
   while the app sits idle; 2 minutes still keeps a conversation or a batch of pictures warm. */
const KEEP_ALIVE = '2m';

function friendly(error) {
  if (error && error.name === 'AbortError') return error;
  const code = error?.cause?.code || error?.code || '';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || /fetch failed/i.test(error?.message || ''))
    return new Error('Ollama is not running on this computer. Start Ollama and try again.');
  return error instanceof Error ? error : new Error('The agent runtime failed.');
}
function isCloudModel(model) {
  return Boolean(model.remote_host || model.remote_model) || /[:-]cloud$/i.test(model.name || '');
}

function createOllamaRuntime({ fetchImpl = fetch, base = BASE } = {}) {
  async function listModels() {
    try {
      const response = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`Ollama answered with status ${response.status}.`);
      const body = await response.json();
      const models = (Array.isArray(body.models) ? body.models : [])
        .filter(model => model && typeof model.name === 'string')
        .map(model => ({ name: model.name, size: model.details?.parameter_size || '', cloud: isCloudModel(model) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { available: true, models, error: null };
    } catch (error) {
      const message = error.name === 'TimeoutError' ? 'Ollama did not respond.' : friendly(error).message;
      return { available: false, models: [], error: message };
    }
  }

  /* One chat turn with a full message list. Streams text through onDelta when no tools are offered;
     with tools it makes a single non-streamed request so tool calls arrive complete.
     Resolves to { text, toolCalls, usage } (usage counts are Ollama-reported, not estimates). */
  async function chat({ model, name = 'The agent', messages, tools = null, options = null, keepAlive = KEEP_ALIVE, signal, onDelta = () => {} }) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    let idle; let timedOut = false;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => { timedOut = true; controller.abort(); }, IDLE_TIMEOUT_MS); };
    const stream = !(tools && tools.length);
    try {
      arm();
      const body = { model, messages, stream, keep_alive: keepAlive };
      if (!stream) body.tools = tools;
      if (options) body.options = options;
      const response = await fetchImpl(`${base}/api/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).error || ''; } catch { /* no body */ }
        if (/does not support tools/i.test(detail)) { const error = new Error(`The model “${model}” does not support tools in Ollama. Turn off tool permissions for ${name} or choose another model.`); error.kind = 'unsupported'; throw error; }
        if (response.status === 404 || /not found/i.test(detail)) throw new Error(`The model “${model}” is not installed in Ollama. Pull it or pick another model for ${name}.`);
        throw new Error(detail ? `Ollama error: ${detail}` : `Ollama answered with status ${response.status}.`);
      }
      let usage = null;
      const usageOf = part => (part.prompt_eval_count !== undefined || part.eval_count !== undefined
        ? { inputTokens: part.prompt_eval_count ?? null, outputTokens: part.eval_count ?? null } : null);
      if (!stream) {
        const part = await response.json();
        if (part.error) throw new Error(`Ollama error: ${part.error}`);
        const text = typeof part.message?.content === 'string' ? part.message.content : '';
        if (text) onDelta(text);
        const toolCalls = (Array.isArray(part.message?.tool_calls) ? part.message.tool_calls : []).map((call, index) => ({
          id: `call_${index}`, name: call.function?.name || '', arguments: call.function?.arguments && typeof call.function.arguments === 'object' ? call.function.arguments : {}
        }));
        return { text, toolCalls, usage: usageOf(part) };
      }
      const decoder = new TextDecoder(); let buffer = ''; let text = '';
      const consume = line => {
        if (!line.trim()) return;
        let part;
        try { part = JSON.parse(line); } catch { return; }
        if (part.error) throw new Error(`Ollama error: ${part.error}`);
        const piece = part.message?.content;
        if (typeof piece === 'string' && piece) { text += piece; onDelta(piece); }
        if (part.done) usage = usageOf(part) || usage;
      };
      for await (const chunk of response.body) {
        arm();
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      }
      consume(buffer + decoder.decode());
      return { text, toolCalls: [], usage };
    } catch (error) {
      if (timedOut) throw new Error(`${name} stopped responding. Check that Ollama can load “${model}”.`);
      if (signal?.aborted) { const cancelled = new Error('Run cancelled.'); cancelled.name = 'AbortError'; throw cancelled; }
      throw friendly(error);
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener('abort', abort);
    }
  }

  /* Model details from /api/show (context length), or null when Ollama does not report it. */
  async function modelInfo(model) {
    try {
      const response = await fetchImpl(`${base}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const body = await response.json();
      const info = body.model_info || {};
      const key = Object.keys(info).find(name => name.endsWith('.context_length'));
      const capabilities = Array.isArray(body.capabilities) ? body.capabilities : null;
      return { contextLength: key ? Number(info[key]) || null : null, tools: capabilities ? capabilities.includes('tools') : null };
    } catch { return null; }
  }

  /* Runs one agent turn and resolves to the full response text. Streams partial text through onDelta. */
  async function runAgent({ agent, system, prompt, signal, onDelta = () => {} }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    return (await chat({ model: agent.model, name: agent.name, messages, signal, onDelta })).text;
  }

  return { name: 'Ollama (local)', base, listModels, runAgent, chat, modelInfo };
}

module.exports = { createOllamaRuntime };
