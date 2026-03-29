// main.js - In-browser LLM agent with tool support
// Engine: wllama (llama.cpp WASM + GGUF)

import { getToolDefinitions, executeTool } from './tools.js?v=1';

const MODEL_HF_REPO = 'unsloth/Qwen3-4B-Thinking-2507-GGUF';
const MODEL_FILE = 'Qwen3-4B-Thinking-2507-Q3_K_S.gguf';
const MAX_TOOL_ROUNDS = 10;

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const logEl = $('log');
const chatMessages = $('chat-messages');
const chatInput = $('chat-input');
const sendBtn = $('send-btn');
const loadBtn = $('load-btn');
const engineLabel = $('engine-label');
const engineStats = $('engine-stats');

let wllama = null;
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

function updateMsg(bodyEl, content) {
  bodyEl.textContent = content;
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function finalizeMsg(bodyEl) {
  bodyEl.classList.remove('streaming');
}

// --- Build prompt for wllama (ChatML format for Qwen) ---

function buildChatML(msgs, tools) {
  let prompt = '';

  // System message with tools
  if (tools && tools.length > 0) {
    prompt += '<|im_start|>system\n';
    prompt += 'You are a helpful assistant with access to tools.\n\n';
    prompt += '# Tools\n\nYou have access to the following functions:\n\n';
    for (const t of tools) {
      prompt += JSON.stringify(t.function) + '\n';
    }
    prompt += '\nTo call a function, respond with:\n';
    prompt += '<tool_call>\n{"name": "function_name", "arguments": {"param": "value"}}\n</tool_call>\n';
    prompt += '\nYou can call multiple tools. After receiving tool results, continue your response.\n';
    prompt += '<|im_end|>\n';
  }

  for (const m of msgs) {
    if (m.role === 'tool') {
      prompt += '<|im_start|>user\n[Tool result]: ' + m.content + '<|im_end|>\n';
    } else {
      prompt += '<|im_start|>' + m.role + '\n' + (m.content || '') + '<|im_end|>\n';
    }
  }
  prompt += '<|im_start|>assistant\n';
  return prompt;
}

// Parse tool calls from wllama text output
function parseToolCalls(text) {
  const calls = [];
  const regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      calls.push({ name: parsed.name, arguments: parsed.arguments || {} });
    } catch (e) {}
  }
  return calls;
}

function stripToolCalls(text) {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
}

// --- Load wllama (primary: GGUF via WASM) ---

async function loadEngine() {
  loadBtn.disabled = true;
  setStatus('Loading wllama runtime...');
  log('Importing wllama...');

  try {
    const mod = await import('../wllama/index.js');
    const WasmPaths = {
      'single-thread/wllama.wasm': '../wllama/single-thread/wllama.wasm',
      'multi-thread/wllama.wasm': '../wllama/multi-thread/wllama.wasm',
    };

    log('Creating wllama instance...');
    wllama = new mod.Wllama(WasmPaths, {
      logger: {
        debug: () => {},
        log: (...args) => log('[wllama] ' + args.join(' ')),
        warn: (...args) => log('[wllama:warn] ' + args.join(' ')),
        error: (...args) => log('[wllama:err] ' + args.join(' ')),
      }
    });

    setStatus('Downloading model (' + MODEL_FILE + ')...');
    log('Loading ' + MODEL_HF_REPO + '/' + MODEL_FILE);

    await wllama.loadModelFromHF(MODEL_HF_REPO, MODEL_FILE, {
      progressCallback: ({ loaded, total }) => {
        const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
        setStatus('Downloading model... ' + pct + '%');
      }
    });

    engineLabel.textContent = 'Qwen3-4B-Thinking-2507 (Q3_K_S)';
    engineStats.textContent = 'WASM | CPU';
    loadBtn.classList.add('active');

    chatInput.disabled = false;
    sendBtn.disabled = false;
    setStatus('Ready — Qwen3-4B');
    log('Model loaded, ready for inference');

  } catch (err) {
    setStatus('Failed: ' + err.message);
    log('ERROR: ' + err.message);
    loadBtn.disabled = false;
  }
}


// --- Agent Loop ---

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
      const prompt = buildChatML(messages, tools);
      log('Generating (round ' + (round + 1) + ', ' + prompt.length + ' chars prompt)...');
      const startTime = performance.now();

      let fullResponse = '';
      await wllama.createCompletion(prompt, {
        nPredict: 1024,
        sampling: { temp: 0.7, top_k: 40, top_p: 0.9 },
        onNewToken: (token, piece, currentText) => {
          fullResponse = currentText;
          updateMsg(bodyEl, currentText);
        },
        stopTokens: ['<|im_end|>'],
      });

      const elapsed = (performance.now() - startTime) / 1000;
      engineStats.textContent = 'WASM | ' + elapsed.toFixed(1) + 's';
      log('Generated in ' + elapsed.toFixed(1) + 's');

      const toolCalls = parseToolCalls(fullResponse);
      const cleanText = stripToolCalls(fullResponse);

      if (toolCalls.length > 0) {
        if (cleanText) updateMsg(bodyEl, cleanText);
        finalizeMsg(bodyEl);
        messages.push({ role: 'assistant', content: fullResponse });

        for (const tc of toolCalls) {
          log('Tool call: ' + tc.name);
          addMessage('system', 'tool: ' + tc.name);
          const result = await executeTool(tc.name, tc.arguments);
          const resultStr = result.success ? result.result : 'Error: ' + result.error;
          log('Result: ' + resultStr.slice(0, 100));
          messages.push({ role: 'tool', content: resultStr });
        }
        if (!cleanText) bodyEl.parentElement.remove();
        continue;
      } else {
        updateMsg(bodyEl, cleanText || fullResponse);
        finalizeMsg(bodyEl);
        messages.push({ role: 'assistant', content: cleanText || fullResponse });
        break;
      }
    } catch (err) {
      updateMsg(bodyEl, '[Error: ' + err.message + ']');
      finalizeMsg(bodyEl);
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
  if (!text || generating || !wllama) return;
  await agentLoop(text);
}

// --- Events ---

loadBtn.addEventListener('click', loadEngine);
sendBtn.addEventListener('click', sendMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
