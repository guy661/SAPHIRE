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

const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- AI CONFIGURATION ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS; // Support both singular and plural (comma separated)
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';

const aiLogger = new Logger('AI-Manager', 'magenta', EMOJIS.semantic);

// Initialize Clients
let genAI = null;
if (GEMINI_API_KEY) {
    // If plural, take the first one for now or handle rotation if needed. 
    // For simplicity, we take the first available key.
    const firstKey = GEMINI_API_KEY.split(',')[0].trim();
    genAI = new GoogleGenerativeAI(firstKey);
    aiLogger.info('Initializing Cloud AI (Google Gemini)');
} else {
    aiLogger.info(`Initializing Local AI (Ollama) at ${OLLAMA_BASE_URL} with model ${OLLAMA_MODEL}`);
}

const ollamaClient = new OpenAI({
    baseURL: OLLAMA_BASE_URL,
    apiKey: 'ollama', 
});

// --- UNIFIED AI FUNCTIONS ---

/**
 * Executes a prompt against either Gemini (Cloud) or Ollama (Local).
 */
async function callLocalAI(prompt, temperature = 0, jsonMode = false) {
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-1.5-flash",
                generationConfig: {
                    temperature: temperature,
                    responseMimeType: jsonMode ? "application/json" : "text/plain",
                }
            });
            const result = await model.generateContent(prompt);
            return result.response.text();
        } catch (error) {
            aiLogger.error(`Gemini Cloud Error: ${error.message}`);
            // Fallback to Ollama if Cloud fails? No, the task says "Use Cloud if key exists".
            throw error;
        }
    }

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
        aiLogger.error(`Ollama Local Error: ${error.message}`);
        throw error;
    }
}

/**
 * Executes a chat against either Gemini (Cloud) or Ollama (Local).
 */
async function callLocalAIChat(chatHistory, tools, temperature = 0.5) {
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            
            // Format history for Gemini
            // chatHistory is already in Gemini format according to task.js
            const chat = model.startChat({
                history: chatHistory.slice(0, -1), // All but the last message
                generationConfig: {
                    temperature: temperature,
                },
            });

            const lastMessage = chatHistory[chatHistory.length - 1].parts[0].text;
            const result = await chat.sendMessage(lastMessage);
            return result.response.text();
        } catch (error) {
            aiLogger.error(`Gemini Cloud Chat Error: ${error.message}`);
            throw error;
        }
    }

    // --- OLLAMA FALLBACK ---
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
 * Returns the number of available API keys.
 */
function getApiKeyCount() {
    if (!GEMINI_API_KEY) return 0;
    return GEMINI_API_KEY.split(',').length;
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