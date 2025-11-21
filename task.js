require('dotenv').config();
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { db } = require('./database.js');
const { retry, callGemini } = require('./utils.js');


// =================================================================
// SECTION: Task Definitions
// =================================================================

async function _getArticleContent({ page, article, logs }) {
    const link = article.link;
    logs.push(`[getArticleContent] --------------------------------------------------`);
    logs.push(`[getArticleContent] START: Processing ${link}`);

    let articleText, finalUrl = link;

    try {
        logs.push(`[getArticleContent] Attempting Fast Path for ${link}`);
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 15000);
        const response = await retry(() => fetch(link, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' },
            signal: controller.signal
        }).finally(() => clearTimeout(id)));
        
        if (!response.ok) {
            throw new Error(`Fast Path HTTP error! status: ${response.status}`);
        }
        
        finalUrl = response.url;
        logs.push(`[getArticleContent] Fast Path final URL: ${finalUrl}`);
        const html = await response.text();
        const doc = new JSDOM(html, { url: finalUrl });
        const reader = new Readability(doc.window.document);
        const readableArticle = reader.parse();

        if (readableArticle && readableArticle.textContent) {
            articleText = readableArticle.textContent;
            logs.push(`[getArticleContent] Fast Path extracted text length: ${articleText.length}`);
            if (articleText.length < 250) {
                 logs.push(`[getArticleContent] Fast Path content too short, falling back.`);
                 throw new Error('Fast Path content too short.');
            }
            logs.push(`[getArticleContent] ✅ Fast Path SUCCEEDED for ${link}`);
        } else {
            throw new Error('Fast Path Readability parsing failed.');
        }

    } catch (fastPathError) {
        logs.push(`[getArticleContent] ⚠️ Fast Path FAILED for ${link}: ${fastPathError.message}`);
        logs.push(`[getArticleContent] Attempting Slow Path (Puppeteer) for ${link}`);
        
        try {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });

            logs.push(`[getArticleContent] Slow Path: Navigating to ${link}`);
            await page.goto(link, { waitUntil: "networkidle2", timeout: 30000 });
            await page.waitForTimeout(1000);
            finalUrl = page.url();
            logs.push(`[getArticleContent] Slow Path final URL: ${finalUrl}`);

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
                if (consentClicked) {
                    logs.push(`[getArticleContent] Slow Path: Clicked a consent button.`);
                    await page.waitForTimeout(1500);
                } else {
                    logs.push(`[getArticleContent] Slow Path: No consent button found.`);
                }
            } catch (e) {
                logs.push(`[getArticleContent] ⚠️ Slow Path: Non-critical error during consent click: ${e.message}`);
            }

            const isPaywalled = await page.evaluate(() => document.querySelector('[id*="paywall"], [class*="paywall"], [id*="meter"]'));
            if (isPaywalled) {
                logs.push(`[getArticleContent] ❌ Slow Path: Paywall detected.`);
                throw new Error("Paywall detected.");
            } else {
                logs.push(`[getArticleContent] Slow Path: No paywall detected.`);
            }

            const bodyHtml = await page.content();
            const doc = new JSDOM(bodyHtml, { url: finalUrl });
            const reader = new Readability(doc.window.document);
            const readableArticle = reader.parse();
            
            if (readableArticle && readableArticle.textContent) {
                articleText = readableArticle.textContent;
                logs.push(`[getArticleContent] Slow Path extracted text length: ${articleText.length}`);
            } else {
                 logs.push(`[getArticleContent] ❌ Slow Path: Content extraction failed (articleText is empty).`);
                 throw new Error("Slow Path content extraction failed.");
            }
            
            logs.push(`[getArticleContent] ✅ Slow Path SUCCEEDED for ${link}`);

        } catch (puppeteerError) {
            logs.push(`[getArticleContent] ❌ Slow Path FAILED for ${link}: ${puppeteerError.message}`);
            throw puppeteerError; // Rethrow to be caught by the main try-catch
        }
    }

    if (!articleText || articleText.length < 250) {
        logs.push(`[getArticleContent] ❌ FINAL CHECK FAILED: Not enough content found for ${link}. Length: ${articleText?.length || 0}`);
        throw new Error(`Not enough content found for ${link} after all attempts.`);
    }

    logs.push(`[getArticleContent] END: Successfully processed ${link}. Final length: ${articleText.length}`);
    logs.push(`[getArticleContent] --------------------------------------------------`);
    return { articleText, finalUrl };
}

const getContentTask = async ({ page, data: { article } }) => {
    const logs = [];
    logs.push(`[getContentTask] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    logs.push(`[getContentTask] Task START for ${article.link}`);
    try {
        const { articleText, finalUrl } = await retry(() => _getArticleContent({ page, article, logs }), 2, 2000);
        const result = { ...article, articleText, link: finalUrl, logs };
        logs.push(`[getContentTask] Task END for ${article.link}. Success.`);
        logs.push(`[getContentTask] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        return result;
    } catch (error) {
        logs.push(`[getContentTask] ⚠️ Task FAILED for ${article.link}: ${error.message}`);
        logs.push(`[getContentTask] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        return { ...article, error: error.message, logs };
    }
};

const summarizeArticleTask = async ({ page, data: { article, length } }) => {
    const logs = [];
    const link = article.link;
    logs.push(`[Summarize] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    logs.push(`[Summarize] Task START for ${link}`);
    
    const cachedSummary = await new Promise((resolve) => {
        db.get("SELECT summary FROM articles WHERE link = ? AND cached_at > datetime('now', '-24 hours')", [link], (err, row) => {
            if (row && row.summary) {
                logs.push(`[Summarize] Cache HIT for summary: ${link}`);
                resolve(row.summary);
            } else {
                resolve(null);
            }
        });
    });
    if (cachedSummary) {
        logs.push(`[Summarize] Task END for ${link}. Returning cached summary.`);
        logs.push(`[Summarize] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        return { ...article, summary: cachedSummary, logs };
    }
    logs.push(`[Summarize] Cache MISS for summary: ${link}`);

    try {
        logs.push(`[Summarize] Calling _getArticleContent for ${link}`);
        const { articleText, finalUrl } = await retry(() => _getArticleContent({ page, article, logs }), 2, 2000);
        logs.push(`[Summarize] _getArticleContent finished for ${link}. Text length: ${articleText.length}`);

        const lengthPrompts = {
            short: "Fasse den Artikel in genau 3 Sätzen zusammen.",
            medium: "Fasse den Artikel in 5-6 Sätzen zusammen.",
            long: "Fasse den Artikel in 8-10 Sätzen zusammen."
        };
        const summaryPrompt = `${lengthPrompts[length] || lengthPrompts.medium}\n\nArtikel:\n${articleText}`;
        
        logs.push(`[Summarize] Calling Gemini for summary of ${link}.`);
        const summarizedText = await callGemini(summaryPrompt);
        logs.push(`[Summarize] Gemini summary length: ${summarizedText.length}`);

        db.run(
            `INSERT INTO articles (link, title, summary, date, cached_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(link) DO UPDATE SET summary=excluded.summary, cached_at=datetime('now')`,
            [finalUrl, article.title, summarizedText, article.pubDate]
        );
        logs.push(`[Summarize] Saved summary to DB for ${link}`);

        const result = { ...article, summary: summarizedText, link: finalUrl, logs };
        logs.push(`[Summarize] Task END for ${link}. Success.`);
        logs.push(`[Summarize] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        return result;

    } catch (error) {
        logs.push(`[Summarize] ⚠️ Task FAILED for ${link}: ${error.message}`);
        logs.push(`[Summarize] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        throw error;
    }
};

module.exports = { summarizeArticleTask, getContentTask, _getArticleContent };