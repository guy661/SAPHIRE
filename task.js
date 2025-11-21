require('dotenv').config();
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { db } = require('./database.js');

// This file was temporarily emptied and is now being restored.

// =================================================================
// SECTION: Helper Utilities (copied from server.js)
// =================================================================

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


// =================================================================
// SECTION: Task Definitions
// =================================================================

async function _getArticleContent({ page, article, logs }) {
    const link = article.link;
    logs.push(`[_getArticleContent] Starting for: ${link}`);


    let finalUrl = link;

    try {
        logs.push(`[Fast Path] Attempting for ${link}`);
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout
        const response = await retry(() => fetch(link, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' },
            signal: controller.signal
        }).finally(() => clearTimeout(id)));
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        finalUrl = response.url;
        const html = await response.text();
        const doc = new JSDOM(html, { url: finalUrl });
        const reader = new Readability(doc.window.document);
        const readableArticle = reader.parse();

        const articleText = await page.evaluate(() => {
            const reader = new Readability(document);
            return reader.parse()?.textContent || "";
        });

        if (!articleText) {
            logs.push(`[Fast Path] ❌ Content extraction failed: articleText is empty for ${link}`);
            throw new Error(`Content extraction failed for ${link}`);
        }
        logs.push(`[Fast Path] ✅ Success for ${finalUrl}`);
    } catch (fastPathError) {
        logs.push(`[Fast Path] ❌ Failed: ${fastPathError.message}. Falling back to Puppeteer.`);
        
        try {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });

            await page.goto(link, { waitUntil: "networkidle2", timeout: 30000 });
            await page.waitForTimeout(1000); // Wait for 1 second after navigation
            finalUrl = page.url();

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
                if(consentClicked) await page.waitForTimeout(1500);
            } catch (e) { logs.push(`[Consent] Non-critical error during consent click: ${e.message}`); } 

            const isPaywalled = await page.evaluate(() => document.querySelector('[id*="paywall"], [class*="paywall"], [id*="meter"]'));
            if(isPaywalled) throw new Error("Paywall detected.");

            const articleText = await page.evaluate(() => {
                const reader = new Readability(document);
                return reader.parse()?.textContent || "";
            });
            if (!articleText) {
                logs.push(`[Slow Path] ❌ Content extraction failed: articleText is empty for ${link}`);
                throw new Error(`Content extraction failed for ${link}`);
            }
            logs.push(`[Slow Path] ✅ Success for ${finalUrl}`);

        } catch (puppeteerError) {
            logs.push(`[Slow Path] ❌ puppeteer failed for ${link}: ${puppeteerError.message}`);
        }
    }

    if (!articleText || articleText.length < 250) {
        throw new Error(`Not enough content found for ${link} after all attempts.`);
    }

    return { articleText, finalUrl };
}

const getContentTask = async ({ page, data: { article } }) => {
    const logs = [];
    try {
        logs.push(`[getContentTask] Starting for ${article.link}`);
        const { articleText, finalUrl } = await retry(() => _getArticleContent({ page, article, logs }), 2, 2000);
        logs.push(`[getContentTask] Success for ${article.link}`);
        return { ...article, articleText, link: finalUrl, logs };
    } catch (error) {
        logs.push(`[getContentTask] ⚠️ Error processing ${article.link}: ${error.message}`);
        return { ...article, error: error.message, logs };
    }
};

const summarizeArticleTask = async ({ page, data: { article, length } }) => {
    const logs = [];
    const link = article.link;
    logs.push(`[Summarize] Starting for: ${link}`);
    
    const cachedSummary = await new Promise((resolve) => {
        db.get("SELECT summary FROM articles WHERE link = ? AND cached_at > datetime('now', '-24 hours')", [link], (err, row) => {
            if (row && row.summary) {
                logs.push(`[Cache] ✅ HIT for summary: ${link}`);
                resolve(row.summary);
            } else {
                resolve(null);
            }
        });
    });
    if (cachedSummary) return { ...article, summary: cachedSummary, logs };
    logs.push(`[Cache] ❌ MISS for summary: ${link}`);

    try {
        const { articleText, finalUrl } = await retry(() => _getArticleContent({ page, article, logs }), 2, 2000);

        const lengthPrompts = {
            short: "Fasse den Artikel in genau 3 Sätzen zusammen.",
            medium: "Fasse den Artikel in 5-6 Sätzen zusammen.",
            long: "Fasse den Artikel in 8-10 Sätzen zusammen."
        };
        const summaryPrompt = `${lengthPrompts[length] || lengthPrompts.medium}\n\nArtikel:\n${articleText}`;
        
        const summarizedText = await callGemini(summaryPrompt);

        db.run(
            `INSERT INTO articles (link, title, summary, date, cached_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(link) DO UPDATE SET summary=excluded.summary, cached_at=datetime('now')`,
            [finalUrl, article.title, summarizedText, article.pubDate]
        );

        logs.push(`[Summarize] ✅ Success for ${link}`);
        return { ...article, summary: summarizedText, link: finalUrl, logs };

    } catch (error) {
        logs.push(`[Summarize] ⚠️ Error summarizing ${link}: ${error.message}`);
        throw error;
    }
};

module.exports = { summarizeArticleTask, getContentTask, _getArticleContent };