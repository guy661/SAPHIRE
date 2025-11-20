require('dotenv').config();
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { db } = require('./database.js');

// =================================================================
// SECTION: Helper Utilities
// =================================================================

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Task timed out')), ms);
        promise.finally(() => clearTimeout(timer));
        promise.then(resolve, reject);
    });
}

function chunkText(text, maxLength = 18000) {
    // This function remains as is, used by summarization.
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let currentChunk = "";
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [];
    for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > maxLength) {
            chunks.push(currentChunk.trim());
            currentChunk = "";
        }
        currentChunk += sentence;
    }
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks; // Simplified the chunking logic slightly for edge cases.
}

async function retry(fn, retries = 3, delay = 1000) {
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
    const response = await fetch(geminiApiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
    }
    const data = await response.json();
    const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!resultText.trim()) {
        throw new Error("Gemini API returned an empty response.");
    }
    return resultText;
}

// =================================================================
// SECTION: Core Content Extraction Logic (Internal Function)
// =================================================================

async function _getArticleContent({ page, article }) {
    const link = article.link;
    console.log(`[_getArticleContent] Starting for: ${link}`);

    // 1. Check Cache for full text (future optimization, for now just for summaries)
    // For simplicity, we only cache summaries for now, not full text.

    let articleText;
    let finalUrl = link;

    try { // 2. Fast Path: Lightweight fetch with JSDOM and Readability
        console.log(`[Fast Path] Attempting for ${link}`);
        const response = await retry(() => fetch(link, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' },
            timeout: 15000
        }));
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        finalUrl = response.url;
        const html = await response.text();
        const doc = new JSDOM(html, { url: finalUrl });
        const reader = new Readability(doc.window.document);
        const readableArticle = reader.parse();

        if (readableArticle && readableArticle.textContent && readableArticle.textContent.length > 250) {
            console.log(`[Fast Path] ✅ Success for ${finalUrl}`);
            articleText = readableArticle.textContent;
        } else {
            throw new Error('Readable content too short or parsing failed.');
        }
    } catch (fastPathError) {
        console.log(`[Fast Path] ❌ Failed: ${fastPathError.message}. Falling back to Puppeteer.`);
        
        try { // 3. Slow Path: Full browser rendering with Puppeteer
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });

            await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
            finalUrl = page.url();

            // Simplified consent/paywall logic for clarity
            try {
                const consentClicked = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                    const acceptButton = buttons.find(btn => /(alle akzeptieren|accept all|i agree|zustimmen)/i.test(btn.innerText));
                    if (acceptButton) {
                        acceptButton.click();
                        return true;
                    }
                    return false;
                });
                if(consentClicked) await page.waitForTimeout(1500); // Wait for overlay to disappear
            } catch (e) { console.log(`[Consent] Non-critical error during consent click: ${e.message}`); }

            const isPaywalled = await page.evaluate(() => document.querySelector('[id*="paywall"], [class*="paywall"], [id*="meter"]'));
            if(isPaywalled) throw new Error("Paywall detected.");

            const bodyHtml = await page.content();
            const doc = new JSDOM(bodyHtml, { url: finalUrl });
            const reader = new Readability(doc.window.document);
            const readableArticle = reader.parse();
            
            if (!readableArticle || readableArticle.textContent.length < 250) {
                throw new Error("Puppeteer Readability check failed or content too short.");
            }
            articleText = readableArticle.textContent;

        } catch (puppeteerError) {
            throw new Error(`Puppeteer failed: ${puppeteerError.message}`);
        }
    }

    if (!articleText || articleText.length < 250) {
        throw new Error(`Not enough content found (${articleText?.length || 0} chars)`);
    }

    return { articleText, finalUrl };
}

// =================================================================
// SECTION: Cluster Tasks (Exported)
// =================================================================

/**
 * NEW TASK: Checks if an article semantically matches user criteria.
 */
const semanticCheckTask = async ({ page, data: { article, userTopic } }) => {
    return withTimeout((async () => {
        try {
            const { articleText } = await _getArticleContent({ page, article });

            const prompt = `
                You are a research assistant. Your task is to determine if an article is relevant to a user's specific interests.

                User's interests:
                - General Topic: "${userTopic.main_topic}"
                - Must Include Themes: "${userTopic.include_keywords || 'N/A'}"
                - Must Exclude Themes: "${userTopic.exclude_keywords || 'None'}"

                Article Snippet:
                ---
                ${articleText.substring(0, 8000)}
                ---

                Instructions:
                1. Analyze if the article snippet is primarily about the "General Topic".
                2. If "Must Include Themes" is not 'N/A', analyze if the article's content is clearly relevant to them. This is a mandatory requirement.
                3. Analyze if the article contains any of the "Must Exclude Themes".
                4. Based on this, decide if the article is relevant. It is only relevant if it matches the "Must Include" criteria (if applicable) AND does not contain any "Must Exclude" criteria.
                5. Respond in a valid JSON format with no other text or markdown: {"is_relevant": boolean, "reason": "A brief analysis of your decision."}
            `;
            
            const decisionString = await callGemini(prompt);
            
            try {
                // Find the JSON part of the string, in case the AI adds extra text
                const jsonMatch = decisionString.match(/\{.*\}/);
                if (!jsonMatch) throw new Error("No JSON object found in AI response.");

                const decision = JSON.parse(jsonMatch[0]);
                console.log(`[Semantic Check] AI decision for ${article.link}: ${decision.is_relevant}. Reason: ${decision.reason}`);

                if (decision.is_relevant === true) {
                    return article; // Return the original article object if it's a match
                }
            } catch (e) {
                console.error(`[Semantic Check] ⚠️ Could not parse AI JSON response for ${article.link}. Response: "${decisionString}". Error: ${e.message}`);
            }

            return null; // Return null if not relevant, or if parsing failed

        } catch (error) {
            console.error(`[Semantic Check] ⚠️ Error processing ${article.link}: ${error.message}`);
            return null; // Return null on any failure
        }
    })(), 90000);
};


/**
 * MODIFIED TASK: Summarizes an article's content.
 */
const summarizeArticleTask = async ({ page, data: { article, length } }) => {
    return withTimeout((async () => {
        const link = article.link;
        console.log(`[Summarize] Starting for: ${link}`);
        
        // Caching logic remains here for summaries
        const cachedSummary = await new Promise((resolve) => {
            db.get("SELECT summary FROM articles WHERE link = ? AND cached_at > datetime('now', '-24 hours')", [link], (err, row) => {
                if (row && row.summary) {
                    console.log(`[Cache] ✅ HIT for summary: ${link}`);
                    resolve(row.summary);
                } else {
                    resolve(null);
                }
            });
        });
        if (cachedSummary) return { ...article, summary: cachedSummary };
        console.log(`[Cache] ❌ MISS for summary: ${link}`);

        try {
            const { articleText, finalUrl } = await _getArticleContent({ page, article });

            const lengthPrompts = {
                short: "Fasse den Artikel in genau 3 Sätzen zusammen.",
                medium: "Fasse den Artikel in 5-6 Sätzen zusammen.",
                long: "Fasse den Artikel in 8-10 Sätzen zusammen."
            };
            const summaryPrompt = `${lengthPrompts[length] || lengthPrompts.medium}\n\nArtikel:\n${articleText}`;
            
            const summarizedText = await callGemini(summaryPrompt);

            // Save the new summary to the cache
            db.run(
                `INSERT INTO articles (link, title, summary, date, cached_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(link) DO UPDATE SET summary=excluded.summary, cached_at=datetime('now')`,
                [finalUrl, article.title, summarizedText, article.pubDate]
            );

            return { ...article, summary: summarizedText, link: finalUrl };

        } catch (error) {
            console.error(`[Summarize] ⚠️ Error summarizing ${link}: ${error.message}`);
            throw error; // Re-throw to have it marked as a failed job in the cluster
        }
    })(), 90000);
};

module.exports = { summarizeArticleTask, semanticCheckTask };