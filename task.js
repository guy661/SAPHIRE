require('dotenv').config();
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { retry, callGemini } = require('./utils.js');


// =================================================================
// SECTION: Task Definitions
// =================================================================

async function _tryToDismissModals(page, logs, maxAttempts = 3) {
    logs.push(`[Dismiss Modals] Starting modal dismissal attempts.`);
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logs.push(`[Dismiss Modals] Attempt #${attempt}...`);
        let clickedSomethingInThisAttempt = false;

        const allFrames = page.frames();
        for (const frame of allFrames) {
            if (frame.isDetached()) continue;
            const frameIdentifier = `frame (${frame.url()})`;

            const clickedInFrame = await frame.evaluate(async () => {
                const positiveKeywords = ['accept', 'agree', 'confirm', 'continue', 'allow', 'ok', 'akzeptieren', 'zustimmen', 'fortfahren', 'einverstanden', 'continue reading'];
                const isVisible = (elem) => !!(elem && (elem.offsetWidth || elem.offsetHeight || elem.getClientRects().length));

                const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                let candidate = null;

                for (const btn of buttons) {
                    if (!isVisible(btn)) continue;

                    const text = btn.innerText.toLowerCase().trim();
                    if (!text) continue;

                    if (positiveKeywords.some(kw => text.includes(kw))) {
                        candidate = btn;
                        break; 
                    }
                }

                if (candidate) {
                    candidate.click();
                    return true;
                }
                return false;
            });

            if (clickedInFrame) {
                logs.push(`[Dismiss Modals] Clicked a button in ${frameIdentifier}. Waiting for changes.`);
                await page.waitForTimeout(2500); // Wait longer for things to settle
                clickedSomethingInThisAttempt = true;
                break; // Exit frame loop for this attempt, and restart scan from the top
            }
        }

        if (!clickedSomethingInThisAttempt) {
            logs.push(`[Dismiss Modals] No more modal buttons found in any frame. Finishing.`);
            return; // No buttons found in any frame, we are done.
        }
    }
    logs.push(`[Dismiss Modals] Finished max attempts.`);
}

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
            if (articleText.length < 100) {
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

            await _tryToDismissModals(page, logs);

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

    if (!articleText || articleText.length < 100) {
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
    logs.push(`[getContentTask] Task START for original URL: ${article.link}`);
    try {
        await page.goto(article.link, { waitUntil: 'networkidle2', timeout: 30000 });

        // It's possible a consent screen appeared.
        const onConsentPage = page.url().includes('consent.google.com');
        if (onConsentPage) {
            logs.push(`[getContentTask] Consent page detected. Attempting to click consent button.`);
            const [response] = await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
                page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
                    const acceptButton = buttons.find(btn => /(alle akzeptieren|accept all|i agree|zustimmen)/i.test(btn.innerText));
                    if (acceptButton) {
                        acceptButton.click();
                        return true;
                    }
                    return false;
                })
            ]);
            if (response) {
                logs.push(`[getContentTask] Clicked consent button and awaited navigation.`);
            } else {
                logs.push(`[getContentTask] Could not find or click consent button.`);
            }
        }

        if (page.url().includes('google.com')) {
            try {
                logs.push(`[getContentTask] Waiting for redirect from Google... Current URL: ${page.url()}`);
                await page.waitForFunction(
                    () => !window.location.hostname.endsWith('google.com'),
                    { timeout: 15000 }
                );
                logs.push(`[getContentTask] Redirected. New URL: ${page.url()}`);
            } catch (e) {
                logs.push(`[getContentTask] ⚠️ Timed out waiting for redirect from Google. Continuing with current URL: ${page.url()}`);
            }
        }
        
        const realUrl = page.url();
        logs.push(`[getContentTask] Real URL is: ${realUrl}`);
        article.link = realUrl;

        const { articleText, finalUrl, title } = await _getArticleContent({ page, article, logs });
        const result = { ...article, title, articleText, link: finalUrl, logs };
        logs.push(`[getContentTask] Task END for ${article.link}. Success.`);
        logs.push(`[getContentTask] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        console.log(logs.join('\n'));
        return result;
    } catch (error) {
        logs.push(`[getContentTask] ⚠️ Task FAILED for ${article.link}: ${error.message}`);
        logs.push(`[getContentTask] <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<`);
        console.log(logs.join('\n'));
        return { ...article, error: error.message, logs };
    }
};

const summarizeArticleTask = async ({ data: { article, length = 'default' } }) => {
    console.log(`[Task] Starting summary for: ${article.link}`);
    try {
        const lengthOptions = {
            'short': 'einem kurzen Satz',
            'default': 'zwei Sätzen',
            'long': 'drei ausführlichen Sätzen'
        };

        const prompt = `Fasse den folgenden Artikeltext in ${lengthOptions[length] || lengthOptions['default']} zusammen. Antworte nur mit der Zusammenfassung, ohne einleitende Sätze wie "Hier ist die Zusammenfassung:":\n\n"${article.articleText}"`;
        
        const summary = await callGemini(prompt);

        console.log(`[Task] Successfully summarized: ${article.link}`);
        return { ...article, summary };
    } catch (error) {
        console.error(`[Task] Error summarizing article ${article.link}:`, error);
        // Re-throw the error so Promise.allSettled in the route can catch it
        throw new Error(`Failed to summarize article: ${error.message}`);
    }
};

const semanticCheckTask = async ({ data: { article, userTopic } }) => {
    console.log(`[Task] Starting semantic check for: ${article.link}`);
    const logs = [];
    try {
        const prompt = `
            You are a highly discerning and specialized research assistant, an expert in "${userTopic.main_topic}". Your primary mission is to protect a busy professional from irrelevant articles. You must be extremely strict and prioritize precision over recall.

            The user's specific research focus is:
            - Core Subject: "${userTopic.main_topic}"
            - Desired Concepts (Must be the main focus): "${userTopic.include_keywords || 'Any'}"
            - Forbidden Topics (Must be completely absent): "${userTopic.exclude_keywords || 'None'}"

            Article Snippet (first ~8000 characters):
            ---
            ${article.articleText.substring(0, 8000)}
            ---

            **Your Strict Filtering Protocol (Must be followed precisely):**

            1.  **Interpret the User's Intent:** The "Desired Concepts" are not just keywords; they represent conceptual themes.
                - For example, if a concept is "New Models", you are looking for articles whose central theme is the announcement, analysis, or architecture of new AI models (e.g., GPT-5, Claude 4, etc.). An article that only mentions a new model in passing while discussing a different topic (like AI ethics or market trends) is **irrelevant**.
                - If a concept is "Image Generation", the article must be *about* the techniques, models, or impact of generating images with AI. An article on a different topic that happens to feature an AI-generated image is **irrelevant**.

            2.  **Primary Filter: Desired Concepts.**
                - If "Desired Concepts" are specified, the article's **main, central theme** MUST be a deep and substantive exploration of at least one of these concepts. A brief or tangential mention is an immediate disqualification.
                - If the article is only related to the "Core Subject" but does not focus on the "Desired Concepts", it is **irrelevant**.

            3.  **Secondary Filter: Forbidden Topics.**
                - The article must not contain any substantive discussion of the "Forbidden Topics". Even a few paragraphs can be enough to disqualify it.

            4.  **Final Judgment:** You must be conservative. If you have any doubt about whether the article is a perfect fit for the user's highly specific focus, you MUST classify it as not relevant. It is better to miss a borderline article than to include an irrelevant one.

            5.  **Deliver Your Verdict:** Respond **only** with a single, valid JSON object. Do not add any other text, explanations, or markdown formatting.
                - The JSON object must have two keys:
                  - \`"is_relevant"\`: \`true\` or \`false\`.
                  - \`"reason"\`: A concise, one-sentence explanation for your decision based on the protocol above. Start your reason with "Relevant because..." or "Irrelevant because...".
                
                Example Response:
                {"is_relevant": false, "reason": "Irrelevant because the article's main focus is AI ethics and only briefly mentions a new model, which does not meet the user's requirement for a deep dive into 'New Models'."}
        `;
        logs.push(`[Semantic Check] Prompt created for ${article.link}.`);

        const decisionString = await retry(() => callGemini(prompt));
        logs.push(`[Semantic Check] Raw AI response received for ${article.link}.`);
        
        const jsonMatch = decisionString.match(/\{.*\}/s);
        if (!jsonMatch) {
            throw new Error(`No JSON object found in AI response. Raw response: ${decisionString}`);
        }

        const decision = JSON.parse(jsonMatch[0]);
        logs.push(`[Semantic Check] Parsed AI decision for ${article.link}: ${decision.is_relevant}.`);
        
        return { ...article, is_relevant: decision.is_relevant, reason: decision.reason, logs };

    } catch (error) {
        logs.push(`[Semantic Check] ⚠️ Error during semantic check for ${article.link}: ${error.message}`);
        console.error(logs.join('\n'));
        // Re-throw the error to be caught by the calling cluster task
        throw error;
    }
};


module.exports = { getContentTask, _getArticleContent, summarizeArticleTask, semanticCheckTask };