require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

const apiKeys = (process.env.GEMINI_API_KEYS || '').split(',').filter(Boolean);
const apiInstances = apiKeys.map(key => new GoogleGenerativeAI(key));

// --- Global Rate Limiting State ---
const apiKeyRequestTimestamps = apiKeys.map(() => []);
const REQUEST_LIMIT_PER_MINUTE = 10;
const TIME_WINDOW_MS = 60000;
let apiKeyIndex = 0; // Used as a starting point for the search to ensure rotation
const rateLimitLogger = new Logger('RateLimiter', 'yellow', '⏳');

async function getNextAvailableApiClient() {
    if (apiInstances.length === 0) {
        throw new Error('No API keys provided for Gemini.');
    }

    while (true) {
        let earliestNextAvailableTime = Infinity;

        for (let i = 0; i < apiInstances.length; i++) {
            const currentIndex = (apiKeyIndex + i) % apiInstances.length;
            const timestamps = apiKeyRequestTimestamps[currentIndex];
            const now = Date.now();

            // Remove timestamps older than the time window
            while (timestamps.length > 0 && now - timestamps[0] > TIME_WINDOW_MS) {
                timestamps.shift();
            }

            // If the key is under the limit, use it
            if (timestamps.length < REQUEST_LIMIT_PER_MINUTE) {
                timestamps.push(now);
                apiKeyIndex = (currentIndex + 1) % apiInstances.length; // Set next starting point
                return apiInstances[currentIndex];
            }

            // Otherwise, calculate the earliest time this key will be available again
            const nextAvailableTime = timestamps[0] + TIME_WINDOW_MS;
            if (nextAvailableTime < earliestNextAvailableTime) {
                earliestNextAvailableTime = nextAvailableTime;
            }
        }

        // If all keys are busy, wait 61 seconds to fully reset the window
        // const waitTime = earliestNextAvailableTime - Date.now() + 50; // +50ms buffer
        const waitTime = 61000;
        if (waitTime > 0) {
            rateLimitLogger.warn(`All API keys are busy. Waiting for 61s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }
}
// --- End of Global Rate Limiting ---

function getApiKeyCount() {
    return apiKeys.length;
}

async function callGemini(prompt, model = 'gemini-2.5-flash', temperature = 0, maxOutputTokens = 2048) {
    return retry(async () => {
        const genAI = await getNextAvailableApiClient();
        const generativeModel = genAI.getGenerativeModel({ model });
        const result = await generativeModel.generateContent(prompt);
        const response = await result.response;
        return response.text();
    }, 3, 2000, 'Gemini call failed');
}

async function callGeminiChat(chatHistory, tools, model = 'gemini-2.5-flash', temperature = 0.5) {
    const genAI = await getNextAvailableApiClient();
    const generativeModel = genAI.getGenerativeModel({
        model: model,
        tools: tools,
    });

    const chat = generativeModel.startChat({
        history: chatHistory,
        generationConfig: {
            temperature: temperature
        }
    });

    const lastMessageParts = chatHistory[chatHistory.length - 1].parts;
    const result = await chat.sendMessage(lastMessageParts);
    const response = await result.response;
    
    return response.functionCalls() ? response.functionCalls() : response.text();
}

const genericLogger = new Logger('Retry', 'yellow', EMOJIS.task);
async function retry(fn, maxRetries = 3, delay = 1000, finalErr = 'Retry failed') {
    let lastError = null;
    for (let i = 0; i < maxRetries; i++) {
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

module.exports = { getApiKeyCount, callGemini, callGeminiChat, retry, Logger, EMOJIS };
