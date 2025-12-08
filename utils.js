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

const apiKeys = (process.env.GEMINI_API_KEYS || '').split(',').filter(Boolean).map(k => k.trim());
const apiInstances = apiKeys.map(key => new GoogleGenerativeAI(key));

// --- Global Rate Limiting State ---
const apiKeyRequestTimestamps = apiKeys.map(() => []);
const REQUEST_LIMIT_PER_MINUTE = 14; // Gemini Free is 15 RPM, keep safety buffer
const TIME_WINDOW_MS = 60000;
let apiKeyIndex = 0; 
const rateLimitLogger = new Logger('RateLimiter', 'yellow', '⏳');

// Helper to artificially exhaust a key if we get a 429
function markKeyAsBusy(index) {
    const now = Date.now();
    // Fill it up with timestamps from 'now' so it won't be used for a minute
    const currentTimestamps = apiKeyRequestTimestamps[index];
    const needed = REQUEST_LIMIT_PER_MINUTE - currentTimestamps.length;
    for(let i=0; i < needed + 1; i++) {
        currentTimestamps.push(now);
    }
}

async function getNextAvailableApiClient() {
    if (apiInstances.length === 0) {
        throw new Error('No API keys provided for Gemini.');
    }

    // Try finding a key multiple times to handle race conditions or rapid exhaustion
    while (true) {
        let earliestNextAvailableTime = Infinity;
        let bestCandidateIndex = -1;

        for (let i = 0; i < apiInstances.length; i++) {
            const currentIndex = (apiKeyIndex + i) % apiInstances.length;
            const timestamps = apiKeyRequestTimestamps[currentIndex];
            const now = Date.now();

            // Clean up old timestamps
            while (timestamps.length > 0 && now - timestamps[0] > TIME_WINDOW_MS) {
                timestamps.shift();
            }

            if (timestamps.length < REQUEST_LIMIT_PER_MINUTE) {
                timestamps.push(now); // Reserve slot
                apiKeyIndex = (currentIndex + 1) % apiInstances.length;
                return { client: apiInstances[currentIndex], index: currentIndex };
            }

            // Track wait time
            const nextFree = timestamps[0] + TIME_WINDOW_MS;
            if (nextFree < earliestNextAvailableTime) {
                earliestNextAvailableTime = nextFree;
            }
        }

        // All keys busy. Wait intelligently.
        const now = Date.now();
        const waitTime = Math.max(1000, earliestNextAvailableTime - now + 100); // at least 1s, plus buffer
        
        rateLimitLogger.warn(`All ${apiInstances.length} API keys busy. Waiting ${Math.ceil(waitTime/1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
}

async function callGemini(prompt, model = 'gemini-2.5-flash', temperature = 0, jsonMode = false) {
    const fallbackModel = 'gemini-2.0-flash-lite-preview-02-05';
    let currentModel = model;
    let retries = 0;
    const maxRetries = 10; 

    while (retries < maxRetries) {
        let currentKeyIndex = -1;
        try {
            const { client, index } = await getNextAvailableApiClient();
            currentKeyIndex = index;
            
            const config = { 
                model: currentModel,
                generationConfig: {
                    temperature: temperature,
                    maxOutputTokens: 2048,
                    responseMimeType: jsonMode ? "application/json" : "text/plain"
                }
            };
            
            const generativeModel = client.getGenerativeModel(config);
            const result = await generativeModel.generateContent(prompt);
            const response = await result.response;
            return response.text();

        } catch (error) {
            retries++;
            const isRateLimit = error.message.includes('429') || error.status === 429 || error.message.includes('Resource has been exhausted');
            const isNetworkError = error.message.includes('fetch failed') || error.message.includes('503') || error.message.includes('500');
            const isModelNotFoundError = error.message.includes('404') || error.message.includes('not found');

            if (isRateLimit || isNetworkError || isModelNotFoundError) {
                const errorType = isRateLimit ? 'Rate Limit' : (isModelNotFoundError ? 'Model Not Found' : 'Network Error');
                rateLimitLogger.warn(`Key #${currentKeyIndex} hit ${errorType} on model ${currentModel}. Swapping key...`);
                
                if (currentKeyIndex !== -1 && isRateLimit) markKeyAsBusy(currentKeyIndex);
                
                // Fallback logic: If we fail repeatedly OR if the model is just not found (404), switch to fallback
                if ((retries > (apiKeys.length * 1.5) || isModelNotFoundError) && currentModel !== fallbackModel) {
                     rateLimitLogger.warn(`Primary model ${currentModel} failed (${errorType}). Switching to FALLBACK: ${fallbackModel}`);
                     currentModel = fallbackModel;
                }
                
                // Small backoff for network errors
                if (isNetworkError) await new Promise(resolve => setTimeout(resolve, 1000));

            } else {
                rateLimitLogger.error(`Gemini Error (Attempt ${retries}): ${error.message}`);
                if (retries >= 3) throw error; 
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            }
        }
    }
    throw new Error(`Gemini call failed after ${maxRetries} retries.`);
}

async function callGeminiChat(chatHistory, tools, model = 'gemini-2.5-flash', temperature = 0.5) {
    const fallbackModel = 'gemini-2.0-flash-lite-preview-02-05';
    let currentModel = model;
    let retries = 0;
    const maxRetries = 10;

    while (retries < maxRetries) {
        let currentKeyIndex = -1;
        try {
            const { client, index } = await getNextAvailableApiClient();
            currentKeyIndex = index;

            const generativeModel = client.getGenerativeModel({
                model: currentModel,
                tools: tools,
                generationConfig: { temperature: temperature }
            });

            const chat = generativeModel.startChat({
                history: chatHistory
            });

            const lastMessageParts = chatHistory[chatHistory.length - 1].parts;
            const result = await chat.sendMessage(lastMessageParts);
            const response = await result.response;
            
            return response.functionCalls() ? response.functionCalls() : response.text();

        } catch (error) {
            retries++;
            const isRateLimit = error.message.includes('429') || error.status === 429 || error.message.includes('Resource has been exhausted');
            const isNetworkError = error.message.includes('fetch failed') || error.message.includes('503') || error.message.includes('500');
            const isModelNotFoundError = error.message.includes('404') || error.message.includes('not found');
            
            if (isRateLimit || isNetworkError || isModelNotFoundError) {
                const errorType = isRateLimit ? 'Rate Limit' : (isModelNotFoundError ? 'Model Not Found' : 'Network Error');
                rateLimitLogger.warn(`Key #${currentKeyIndex} hit ${errorType} in CHAT on model ${currentModel}. Swapping key...`);
                
                if (currentKeyIndex !== -1 && isRateLimit) markKeyAsBusy(currentKeyIndex);

                 if ((retries > (apiKeys.length * 1.5) || isModelNotFoundError) && currentModel !== fallbackModel) {
                    rateLimitLogger.warn(`Primary model ${currentModel} failed (${errorType}). Switching to FALLBACK: ${fallbackModel}`);
                    currentModel = fallbackModel;
               }
               
               if (isNetworkError) await new Promise(resolve => setTimeout(resolve, 1000));

            } else {
                rateLimitLogger.error(`Gemini Chat Error (Attempt ${retries}): ${error.message}`);
                if (retries >= 3) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            }
        }
    }
    throw new Error(`Gemini CHAT failed after ${maxRetries} retries.`);
}

function getApiKeyCount() {
    return apiKeys.length;
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