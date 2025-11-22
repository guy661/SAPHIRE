require('dotenv').config();
const fetch = require('node-fetch');
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

    let articleText, finalUrl = link, title = article.title;


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
            title = readableArticle.title;
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
            logs.push(`[getArticleContent] Slow Path: Navigating to ${link}`);
            await page.goto(link, {
                waitUntil: 'domcontentloaded', // Do not wait for CSS/JS/images
                timeout: 15000                 // 15s timeout
            });
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

            articleText = await page.evaluate(() => document.body.innerText);
            title = await page.title();
            
            if (articleText) {
                logs.push(`[getArticleContent] Slow Path extracted text length: ${articleText.length}`);
            } else {
                 logs.push(`[getArticleContent] ❌ Slow Path: Content extraction failed (articleText is empty).`);
                 throw new Error("Slow Path content extraction failed.");
            }
            
            logs.push(`[getArticleContent] ✅ Slow Path SUCCEEDED for ${link}`);

        } catch (puppeteerError) {
            logs.push(`[getArticleContent] ❌ Slow Path FAILED for ${link}: ${puppeteerError.message}`);
            // Don't rethrow, just log the error and let the process continue.
        }
    }

    if (!articleText || articleText.length < 250) {
        logs.push(`[getArticleContent] ❌ FINAL CHECK FAILED: Not enough content found for ${link}. Length: ${articleText?.length || 0}`);
        throw new Error(`Not enough content found for ${link} after all attempts.`);
    }

    logs.push(`[getArticleContent] END: Successfully processed ${link}. Final length: ${articleText.length}`);
    logs.push(`[getArticleContent] --------------------------------------------------`);
    return { articleText, finalUrl, title };
}

const getContentTask = async ({ page, data: { article } }) => {
    const logs = [];
    logs.push(`[getContentTask] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>`);
    logs.push(`[getContentTask] Task START for ${article.link}`);
    try {
        const { articleText, finalUrl, title } = await _getArticleContent({ page, article, logs });
        const result = { ...article, title, articleText, link: finalUrl, logs };
        logs.push(`[getContentTask] Task END for ${article.link}. Success.`);
        logs.push(`[getContentTask] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        return result;
    } catch (error) {
        logs.push(`[getContentTask] ⚠️ Task FAILED for ${article.link}: ${error.message}`);
        logs.push(`[getContentTask] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        return { ...article, error: error.message, logs };
    }
};

module.exports = { getContentTask, _getArticleContent };