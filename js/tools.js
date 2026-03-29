// tools.js - Tool definitions and execution for LLM agent
// Tools are JavaScript functions the LLM can invoke

const TOOL_REGISTRY = {};

// Register a tool
export function registerTool(name, description, parameters, fn) {
  TOOL_REGISTRY[name] = { name, description, parameters, fn };
}

// Get tool definitions in OpenAI-compatible format for the LLM
export function getToolDefinitions() {
  return Object.values(TOOL_REGISTRY).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }));
}

// Execute a tool call
export async function executeTool(name, args) {
  const tool = TOOL_REGISTRY[name];
  if (!tool) throw new Error('Unknown tool: ' + name);
  try {
    const result = await tool.fn(args);
    return { success: true, result: typeof result === 'string' ? result : JSON.stringify(result) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Check if a response contains tool calls
export function hasToolCalls(response) {
  if (!response || !response.choices || !response.choices[0]) return false;
  const msg = response.choices[0].message || response.choices[0].delta;
  return msg && msg.tool_calls && msg.tool_calls.length > 0;
}

export function getToolCalls(response) {
  const msg = response.choices[0].message || response.choices[0].delta;
  return msg.tool_calls || [];
}

// --- Built-in tools ---

registerTool('get_time', 'Get the current date and time', {
  type: 'object',
  properties: {},
  required: []
}, () => {
  return new Date().toISOString();
});

registerTool('calculate', 'Evaluate a mathematical expression', {
  type: 'object',
  properties: {
    expression: { type: 'string', description: 'Math expression to evaluate (e.g., "2+2", "Math.sqrt(16)")' }
  },
  required: ['expression']
}, (args) => {
  // Sandboxed eval — only math operations
  const expr = args.expression;
  if (/[^0-9+\-*/.()%\s^eE]/.test(expr.replace(/Math\.\w+/g, ''))) {
    throw new Error('Invalid expression — only math operations allowed');
  }
  return String(Function('"use strict"; return (' + expr + ')')());
});

registerTool('fetch_url', 'Fetch text content from a URL', {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'URL to fetch' }
  },
  required: ['url']
}, async (args) => {
  const res = await fetch(args.url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  return text.slice(0, 4000); // Limit response size
});

registerTool('read_clipboard', 'Read text from the clipboard', {
  type: 'object',
  properties: {},
  required: []
}, async () => {
  return await navigator.clipboard.readText();
});

registerTool('write_clipboard', 'Write text to the clipboard', {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Text to write' }
  },
  required: ['text']
}, async (args) => {
  await navigator.clipboard.writeText(args.text);
  return 'Written to clipboard';
});

registerTool('get_page_info', 'Get information about the current page', {
  type: 'object',
  properties: {},
  required: []
}, () => {
  return {
    url: location.href,
    title: document.title,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    userAgent: navigator.userAgent
  };
});

registerTool('run_javascript', 'Execute JavaScript code and return the result', {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'JavaScript code to execute. Must return a value.' }
  },
  required: ['code']
}, async (args) => {
  try {
    const fn = new Function('"use strict"; return (async () => { ' + args.code + ' })()');
    const result = await fn();
    return result !== undefined ? String(result) : 'undefined';
  } catch (e) {
    throw new Error('JS error: ' + e.message);
  }
});

registerTool('local_storage_get', 'Read a value from localStorage', {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Storage key' }
  },
  required: ['key']
}, (args) => {
  return localStorage.getItem(args.key) || 'null';
});

registerTool('local_storage_set', 'Write a value to localStorage', {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Storage key' },
    value: { type: 'string', description: 'Value to store' }
  },
  required: ['key', 'value']
}, (args) => {
  localStorage.setItem(args.key, args.value);
  return 'Stored';
});
