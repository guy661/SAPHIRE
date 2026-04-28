require('dotenv').config();
const OpenAI = require('openai');

const COLORS = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    reset: '\x1b[0m'
};

const EMOJIS = {
    info: '✅',
    warn: '⚠️',
    error: '❌',
    debug: '🐞',
    fetch: '📥',
    semantic: '🧠',
    db: '🐘',
    server: '🚀',
    task: '🛠️',
    bull: '🐂'
};

class Logger {
    constructor(prefix, color = 'white', emoji = '') {
        this.prefix = prefix;
        this.color = COLORS[color] || COLORS.white;
        this.emoji = emoji;
    }

    _log(level, message) {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`[${this.prefix}] ${this.emoji} [${timestamp}] ${message}`);
    }

    info(message) {
        this._log('INFO', message);
    }

    warn(message) {
        console.warn(`[${this.prefix}] ${this.emoji} [${new Date().toLocaleTimeString()}] [WARN] ${message}`);
    }

    error(message, errorObj = null) {
        let errorMessage = message;
        if (errorObj) {
            if (process.env.NODE_ENV === 'development') {
                errorMessage += ` | Stack: ${errorObj.stack}`;
            } else {
                errorMessage += ` | Error: ${errorObj.message}`;
            }
        }
        console.error(`[${this.prefix}] ${this.emoji} [${new Date().toLocaleTimeString()}] [ERROR] ${errorMessage}`);
    }

    debug(message) {
        if (process.env.NODE_ENV === 'development') {
            this._log('DEBUG', message);
        }
    }
}

// --- OLLAMA CONFIGURATION ---
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';

const aiLogger = new Logger('LocalAI', 'magenta', EMOJIS.semantic);

aiLogger.info(`Initializing Pure Local AI (Ollama) at ${OLLAMA_BASE_URL} with model ${OLLAMA_MODEL}`);

const ollamaClient = new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: 'ollama', // Required by SDK, unused by Ollama
});

// --- UNIFIED AI FUNCTIONS (Ollama Only) ---

/**
 * Executes a prompt against the local Ollama instance.
 */
async function callLocalAI(prompt, temperature = 0, jsonMode = false) {
    try {
        const response = await ollamaClient.chat.completions.create({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: temperature,
            response_format: jsonMode ? { type: 'json_object' } : { type: 'text' },
            max_tokens: 8192
        });
        
        return response.choices[0].message.content;
    } catch (error) {
        aiLogger.error(`Ollama Generative Error: ${error.message}`);
        throw error;
    }
}

/**
 * Executes a chat against the local Ollama instance.
 * Handles format conversion from Gemini-style history/tools to OpenAI/Ollama style.
 */
async function callLocalAIChat(chatHistory, tools, temperature = 0.5) {
    // 1. Convert History (Gemini -> OpenAI)
    const messages = chatHistory.map(entry => {
        const content = entry.parts.map(p => p.text).join('');
        let role = 'user';
        if (entry.role === 'model') role = 'assistant';
        if (entry.role === 'system') role = 'system';
        
        return {
            role: role,
            content: content
        };
    });

    // 2. Convert Tools (Gemini -> OpenAI)
    let openaiTools = undefined;
    if (tools && tools.length > 0) {
        openaiTools = [];
        tools.forEach(toolGroup => {
            if (toolGroup.functionDeclarations) {
                toolGroup.functionDeclarations.forEach(fn => {
                    openaiTools.push({
                        type: 'function',
                        function: {
                            name: fn.name,
                            description: fn.description,
                            parameters: fn.parameters
                        }
                    });
                });
            }
        });
    }

    try {
        const response = await ollamaClient.chat.completions.create({
            model: OLLAMA_MODEL,
            messages: messages,
            temperature: temperature,
            tools: openaiTools,
            tool_choice: openaiTools ? 'auto' : 'none'
        });

        const choice = response.choices[0];
        const message = choice.message;

        // 3. Handle Tool Calls (OpenAI -> Gemini format)
        if (message.tool_calls && message.tool_calls.length > 0) {
            return message.tool_calls.map(tc => ({
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments)
            }));
        }

        return message.content;

    } catch (error) {
        aiLogger.error(`Ollama Chat Error: ${error.message}`);
        throw error;
    }
}

/**
 * Returns concurrency limit. 
 * Since we are local, we simulate a queue of parallel tasks feeding into Ollama.
 * Increased to 10 for aggressive parallelism with small chunks.
 */
function getApiKeyCount() {
    return 10; 
}

const genericLogger = new Logger('Retry', 'yellow', EMOJIS.task);
async function retry(fn, maxRetries = 3, delay = 1000, finalErr = 'Retry failed') {
    let lastError = null;
    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            genericLogger.warn(`Attempt ${i + 1} failed with error: ${error.message}. Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    const finalError = new Error(`${finalErr}: ${lastError ? lastError.message : 'Unknown error'}`);
    finalError.originalError = lastError;
    throw finalError;
}

module.exports = { getApiKeyCount, callLocalAI, callLocalAIChat, retry, Logger, EMOJIS };