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
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS;

const aiLogger = new Logger('AI-Manager', 'magenta', EMOJIS.semantic);

// Initialize Clients
const groqClient = GROQ_API_KEY ? new OpenAI({ apiKey: GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' }) : null;
const openRouterClient = OPENROUTER_API_KEY ? new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' }) : null;

let genAI = null;
if (GEMINI_API_KEY) {
    const firstKey = GEMINI_API_KEY.split(',')[0].trim();
    genAI = new GoogleGenerativeAI(firstKey);
}

if (groqClient) aiLogger.info(`Configured Groq API (Model: ${GROQ_MODEL})`);
if (openRouterClient) aiLogger.info(`Configured OpenRouter API (Model: ${OPENROUTER_MODEL})`);
if (genAI) aiLogger.info('Configured Gemini Cloud API');


// --- UNIFIED AI FUNCTIONS ---

function geminiHistoryToOpenAI(chatHistory) {
    return chatHistory.map(entry => {
        const content = entry.parts.map(p => p.text).join('');
        let role = 'user';
        if (entry.role === 'model') role = 'assistant';
        if (entry.role === 'system') role = 'system';
        return { role, content };
    });
}

function convertToolsToOpenAI(tools) {
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
    return openaiTools;
}

async function executeOpenAICall(client, model, messages, temperature, jsonMode, tools) {
    const openaiTools = convertToolsToOpenAI(tools);
    const response = await client.chat.completions.create({
        model: model,
        messages: messages,
        temperature: temperature,
        response_format: jsonMode && !tools ? { type: 'json_object' } : { type: 'text' },
        tools: openaiTools,
        tool_choice: openaiTools ? 'auto' : undefined
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
}

async function executeGeminiCall(messages, temperature, jsonMode, tools) {
    if (!genAI) throw new Error('Gemini not configured');

    const systemMessage = messages.find(m => m.role === 'system');
    const systemInstruction = systemMessage ? systemMessage.content : undefined;

    const filteredHistory = messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    if (filteredHistory.length === 0) throw new Error('No user messages found');
    
    // Extract the very last message to send
    const lastMessage = filteredHistory.pop();

    const model = genAI.getGenerativeModel({ 
        model: "gemma-4-31b",
        systemInstruction: systemInstruction,
        generationConfig: {
            temperature: temperature,
            responseMimeType: jsonMode ? "application/json" : "text/plain",
        },
        tools: tools // Pass tools directly if they are in Gemini format
    });
    
    const chat = model.startChat({ history: filteredHistory });
    const result = await chat.sendMessage(lastMessage.parts[0].text);
    
    // Check for tool calls
    const response = result.response;
    const functionCalls = response.functionCalls();
    if (functionCalls && functionCalls.length > 0) {
        return functionCalls.map(fc => ({
            name: fc.name,
            args: fc.args
        }));
    }

    return response.text();
}

async function callAIWithFallback(messages, temperature = 0, jsonMode = false, tools = undefined) {
    const errors = [];

    // 1. Groq
    if (groqClient) {
        try {
            return await executeOpenAICall(groqClient, GROQ_MODEL, messages, temperature, jsonMode, tools);
        } catch (err) {
            aiLogger.warn(`Groq failed: ${err.message}. Cascading...`);
            errors.push(`Groq: ${err.message}`);
        }
    }

    // 2. OpenRouter
    if (openRouterClient) {
        try {
            return await executeOpenAICall(openRouterClient, OPENROUTER_MODEL, messages, temperature, jsonMode, tools);
        } catch (err) {
            aiLogger.warn(`OpenRouter failed: ${err.message}. Cascading...`);
            errors.push(`OpenRouter: ${err.message}`);
        }
    }

    // 3. Gemini
    if (genAI) {
        try {
            return await executeGeminiCall(messages, temperature, jsonMode, tools);
        } catch (err) {
            aiLogger.warn(`Gemini failed: ${err.message}. Cascading...`);
            errors.push(`Gemini: ${err.message}`);
        }
    }

    throw new Error(`All AI providers failed.\n${errors.join('\n')}`);
}

/**
 * Executes a prompt (single message).
 */
async function callLocalAI(prompt, temperature = 0, jsonMode = false) {
    return await callAIWithFallback([{ role: 'user', content: prompt }], temperature, jsonMode);
}

/**
 * Executes a chat with full history.
 */
async function callLocalAIChat(chatHistory, tools, temperature = 0.5) {
    const messages = geminiHistoryToOpenAI(chatHistory);
    return await callAIWithFallback(messages, temperature, false, tools);
}

/**
 * Returns the number of available API keys.
 */
function getApiKeyCount() {
    let count = 0;
    if (GROQ_API_KEY) count++;
    if (OPENROUTER_API_KEY) count++;
    if (GEMINI_API_KEY) count += GEMINI_API_KEY.split(',').length;
    return count;
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

module.exports = { getApiKeyCount, callLocalAI, callLocalAIChat, retry, Logger, EMOJIS, genAI };