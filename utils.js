require('dotenv').config();
const fetch = require('node-fetch');

async function retry(fn, retries = 5, delay = 1000) {
    try {
        return await fn();
    } catch (err) {
        if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
            return retry(fn, retries - 1, delay * 2);
        }
        throw err;
    }
}

async function callGemini(prompt) {
    const geminiApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout
    const response = await fetch(geminiApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: controller.signal
    }).finally(() => clearTimeout(id));
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
    }
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function processInBatches(items, taskFn, batchSize, delay) {
    let results = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        console.log(`[Batch] Processing batch of ${batch.length} items...`);
        
        const promises = batch.map(item => taskFn(item));
        const batchResults = await Promise.allSettled(promises);
        results = results.concat(batchResults);

        if (i + batchSize < items.length) {
            console.log(`[Batch] Waiting ${delay / 1000} seconds before next batch...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return results;
}

module.exports = { retry, callGemini, processInBatches };
