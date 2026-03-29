// main.js - In-browser LLM agent with tool support
// Primary: WebLLM (WebGPU), Fallback: llama.cpp WASM

import { getToolDefinitions, executeTool } from './tools.js?v=1';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const logEl = $('log');
const chatMessages = $('chat-messages');
const chatInput = $('chat-input');
const sendBtn = $('send-btn');
const loadWebllmBtn = $('load-webllm');
const loadWasmBtn = $('load-wasm');
const engineLabel = $('engine-label');
const engineStats = $('engine-stats');

let engine = null;
let engineType = null;
let messages = [];
let generating = false;

function setStatus(msg) { statusEl.textContent = msg; }

function log(msg) {
  console.log('[capital] ' + msg);
  const line = document.createElement('div');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// --- Chat UI ---

function addMessage(role, content, streaming = false) {
  // Remove empty state
  const empty = chatMessages.querySelector('.chat-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = 'msg';
  const roleEl = document.createElement('div');
  roleEl.className = 'msg-role ' + role;
  roleEl.textContent = role;
  const bodyEl = document.createElement('div');
  bodyEl.className = 'msg-body' + (streaming ? ' streaming' : '');
  bodyEl.textContent = content;
  el.appendChild(roleEl);
  el.appendChild(bodyEl);
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bodyEl;
}

function updateStreamingMessage(bodyEl, content) {
  bodyEl.textContent = content;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function finalizeMessage(bodyEl) {
  bodyEl.classList.remove('streaming');
}

// --- WebLLM Engine ---

async function loadWebLLM() {
  loadWebllmBtn.disabled = true;
  loadWasmBtn.disabled = true;
  setStatus('Loading WebLLM runtime...');
  log('Importing WebLLM from CDN...');

  try {
    // Check WebGPU support
    if (!navigator.gpu) {
      throw new Error('WebGPU not supported in this browser. Try Chrome 113+ or Edge.');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter found. GPU may not be supported.');
    }
    log('WebGPU adapter: ' + (adapter.info?.device || 'available'));

    // Import WebLLM
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    log('WebLLM module loaded');

    // Create engine with progress callback
    setStatus('Downloading model (this may take a while)...');
    log('Initializing engine...');

    const initProgressCallback = (report) => {
      setStatus(report.text || 'Loading...');
      log(report.text || 'progress...');
    };

    // Use a small, fast model as default — user can provide their own later
    // Phi-3.5-mini-instruct is ~2.3GB quantized, good balance of size/quality
    const selectedModel = 'Phi-3.5-mini-instruct-q4f16_1-MLC';

    engine = await webllm.CreateMLCEngine(selectedModel, {
      initProgressCallback: initProgressCallback,
    });

    engineType = 'webllm';
    engineLabel.textContent = 'WebLLM (' + selectedModel.split('-q')[0] + ')';
    engineStats.textContent = 'WebGPU accelerated';
    loadWebllmBtn.classList.add('active');

    chatInput.disabled = false;
    sendBtn.disabled = false;
    setStatus('Ready');
    log('WebLLM engine ready');

  } catch (err) {
    setStatus('WebLLM failed: ' + err.message);
    log('ERROR: ' + err.message);
    loadWebllmBtn.disabled = false;
    loadWasmBtn.disabled = false;
  }
}

// --- WASM (llama.cpp) Engine ---

async function loadWASM() {
  loadWebllmBtn.disabled = true;
  loadWasmBtn.disabled = true;
  setStatus('Loading WASM engine...');
  log('WASM fallback — CPU inference');

  try {
    // Placeholder: llama.cpp WASM requires a compiled module + model file
    // The user will provide the model; this sets up the interface
    setStatus('WASM engine: waiting for model');
    log('WASM engine initialized (no model loaded yet)');
    log('To use: provide a GGUF model file via the model loader');

    engineType = 'wasm';
    engineLabel.textContent = 'WASM (llama.cpp)';
    engineStats.textContent = 'CPU only - no model loaded';
    loadWasmBtn.classList.add('active');

    // For now, enable chat with a stub that explains the situation
    engine = {
      type: 'wasm-stub',
      chat: async function(msgs) {
        return { choices: [{ message: { content: 'WASM engine is ready but no model is loaded yet. Provide a GGUF model to enable inference.' } }] };
      }
    };

    chatInput.disabled = false;
    sendBtn.disabled = false;
    setStatus('WASM ready (no model)');
    log('Load a GGUF model to begin inference');

  } catch (err) {
    setStatus('WASM failed: ' + err.message);
    log('ERROR: ' + err.message);
    loadWebllmBtn.disabled = false;
    loadWasmBtn.disabled = false;
  }
}

// --- Agent Loop: generate -> tool calls -> execute -> feed back -> repeat ---

const MAX_TOOL_ROUNDS = 10;

async function agentLoop(userText) {
  generating = true;
  sendBtn.disabled = true;
  chatInput.value = '';

  addMessage('user', userText);
  messages.push({ role: 'user', content: userText });

  const tools = getToolDefinitions();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const bodyEl = addMessage('assistant', '', true);

    try {
      if (engineType === 'webllm') {
        // First try non-streaming to detect tool calls
        log('Generating (round ' + (round + 1) + ')...');
        const startTime = performance.now();

        const response = await engine.chat.completions.create({
          messages: messages,
          tools: tools.length > 0 ? tools : undefined,
          temperature: 0.7,
          max_tokens: 1024,
        });

        const choice = response.choices[0];
        const elapsed = (performance.now() - startTime) / 1000;
        const usage = response.usage || {};
        const tps = usage.completion_tokens ? (usage.completion_tokens / elapsed).toFixed(1) : '?';
        engineStats.textContent = 'WebGPU | ' + tps + ' tok/s';

        if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
          // LLM wants to call tools
          const content = choice.message.content || '';
          if (content) updateStreamingMessage(bodyEl, content);

          messages.push(choice.message);

          // Execute each tool call
          for (const tc of choice.message.tool_calls) {
            const fnName = tc.function.name;
            let fnArgs = {};
            try { fnArgs = JSON.parse(tc.function.arguments); } catch (e) {}

            log('Tool call: ' + fnName + '(' + JSON.stringify(fnArgs).slice(0, 80) + ')');
            addMessage('system', 'tool: ' + fnName);

            const result = await executeTool(fnName, fnArgs);
            const resultStr = result.success ? result.result : 'Error: ' + result.error;
            log('Tool result: ' + resultStr.slice(0, 100));

            messages.push({
              role: 'tool',
              content: resultStr,
              tool_call_id: tc.id
            });
          }

          finalizeMessage(bodyEl);
          if (!content) bodyEl.parentElement.remove(); // Remove empty assistant msg
          continue; // Next round — LLM processes tool results

        } else {
          // Normal text response — done
          const content = choice.message.content || '';
          updateStreamingMessage(bodyEl, content);
          finalizeMessage(bodyEl);
          messages.push({ role: 'assistant', content: content });
          log('Generated in ' + elapsed.toFixed(1) + 's');
          break;
        }

      } else if (engineType === 'wasm') {
        const result = await engine.chat(messages);
        const content = result.choices[0].message.content;
        updateStreamingMessage(bodyEl, content);
        finalizeMessage(bodyEl);
        messages.push({ role: 'assistant', content: content });
        break;
      }

    } catch (err) {
      updateStreamingMessage(bodyEl, '[Error: ' + err.message + ']');
      finalizeMessage(bodyEl);
      log('ERROR: ' + err.message);
      break;
    }
  }

  generating = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || generating || !engine) return;
  await agentLoop(text);
}

// --- Event Listeners ---

loadWebllmBtn.addEventListener('click', loadWebLLM);
loadWasmBtn.addEventListener('click', loadWASM);
sendBtn.addEventListener('click', sendMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
