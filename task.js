require('dotenv').config();
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { db } = require('./database.js');



function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Task timed out'));
        }, ms);

        promise
            .then(value => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

function chunkText(text, maxLength = 18000) {
    if (text.length <= maxLength) {
        return [text];
    }

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

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    const finalChunks = [];
    for (const chunk of chunks) {
        if (chunk.length > maxLength) {
            const words = chunk.split(' ');
            let wordChunk = '';
            for (const word of words) {
                if (wordChunk.length + word.length > maxLength) {
                    finalChunks.push(wordChunk);
                    wordChunk = '';
                }
                wordChunk += word + ' ';
            }
            finalChunks.push(wordChunk);
        } else {
            finalChunks.push(chunk);
        }
    }

    return finalChunks;
}

async function detectPaywall(page) {
    const paywallSelectors = [
        '[id*="paywall"]',
        '[class*="paywall"]',
        '[id*="meter"]',
        '[class*="meter"]',
        '.leaky_paywall',
        '.tp-modal',
        '#pico-overlay',
    ];

    try {
        for (const selector of paywallSelectors) {
            if (await page.$(selector) !== null) {
                console.log(`[Paywall] Detected with selector: ${selector}`);
                return true;
            }
        }
    } catch (error) {
        
    }
    return false;
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
        throw new Error(`Gemini API Fehler: ${response.status} - ${errorText}`);
    }
    const data = await response.json();
    const summary = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!summary.trim()) {
        throw new Error("Gemini API returned an empty summary.");
    }
    return summary;
}

async function summarizeText(text, length) {
    const chunks = chunkText(text.trim());
    const lengthPrompts = {
        short: "Kurze Zusammenfassung (2-3 Sätze):",
        medium: "Zusammenfassung (Überblick + 3-4 Stichpunkte):",
        long: "Detaillierte Zusammenfassung (Überblick + 5-6 Stichpunkte mit Erklärungen):"
    };
    const basePrompt = lengthPrompts[length] || lengthPrompts.medium;

    let finalSummary = "";

    if (chunks.length > 1) {
        const chunkSummaryPromises = chunks.map(chunk => callGemini(`Fasse diesen Textabschnitt zusammen:

${chunk}`));
        const chunkSummaries = await Promise.all(chunkSummaryPromises);
        const combinationPrompt = `Kombinieren Sie diese Zusammenfassungen zu einer Gesamtzusammenfassung im '${length}' Stil.
${basePrompt}
Zusammenfassungen:
${chunkSummaries.join("---")}`;
        finalSummary = await callGemini(combinationPrompt);
    } else {
        const prompt = `${basePrompt}
Artikel:
${chunks[0]}`;
        finalSummary = await callGemini(prompt);
    }

    if (!finalSummary.trim()) {
        throw new Error("Summarization process resulted in an empty summary.");
    }
    return finalSummary;
}

const summarizeArticleTask = async ({ page, data: { article, length } }) => {
    return withTimeout((async () => {
        const link = article.link;
        console.log('summarizeArticleTask started for link:', link);

        
        
        
        
        const cachedArticle = await new Promise((resolve, reject) => {
            db.get("SELECT title, summary, date, cached_at FROM articles WHERE link = ?", [link], (err, row) => {
                if (err) return reject(err);
                if (row && row.summary) {
                    const cachedDate = new Date(row.cached_at);
                    const now = new Date();
                    const hoursDiff = (now - cachedDate) / (1000 * 60 * 60);
                    if (hoursDiff < 24) {
                        console.log(`[Cache] ✅ HIT for ${link}`);
                        return resolve({ title: row.title, summary: row.summary, link: link, date: row.date });
                    }
                }
                resolve(null);
            });
        });

        if (cachedArticle) {
            return cachedArticle;
        }
        console.log(`[Cache] ❌ MISS for ${link}`);

        let articleText;
        let finalUrl = link;

        try {
            console.log(`[Fast Path] Attempting lightweight fetch for ${link}`);
            const response = await fetch(link, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                },
                timeout: 15000
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            finalUrl = response.url;
            const html = await response.text();
            const doc = new JSDOM(html, { url: finalUrl });
            const reader = new Readability(doc.window.document);
            const readableArticle = reader.parse();

            if (readableArticle && readableArticle.textContent && readableArticle.textContent.length > 250) {
                console.log(`[Fast Path] ✅ Success with Readability for ${finalUrl}`);
                articleText = readableArticle.textContent;
            } else {
                
                console.log(`[Fast Path] Readability failed or content too short. Trying <p> tag fallback for ${finalUrl}.`);
                const pText = Array.from(doc.window.document.querySelectorAll('p')).map(p => p.textContent).join('\n');
                if (pText.length > 250) {
                    console.log(`[Fast Path] ✅ Success with <p> tags for ${finalUrl}`);
                    articleText = pText;
                } else {
                    const reason = readableArticle ? `Readability content too short (${readableArticle.textContent.length} chars)` : 'Readability could not parse';
                    throw new Error(`Lightweight extraction failed: ${reason}`);
                }
            }
        } catch (fastPathError) {
            console.log(`[Fast Path] ❌ Failed: ${fastPathError.message}. Falling back to Puppeteer for ${link}`);
            
            try {
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    const resourceType = req.resourceType();
                    if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font' || resourceType === 'media') {
                        req.abort();
                    } else {
                        req.continue();
                    }
                });

                await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });

                try {
                    console.log('[Consent] Starting robust auto-consent check (with iframe support)...');
                    let clicked = false;

                    
                    for (let i = 0; i < 7; i++) {
                        for (const frame of page.frames()) {
                            try {
                                const frameClicked = await frame.evaluate(() => {
                                    const positiveTexts = ['accept all', 'alle akzeptieren', 'i agree', 'zustimmen', 'ok', 'einverstanden'];
                                    const selectors = [
                                        '#L2AGLb', 
                                        'form[action*="consent"] button',
                                        'button[aria-label*="Accept"]',
                                        'button[aria-label*="agree"]',
                                        'button[aria-label*="Zustimmen"]',
                                        '[id*="consent"] button',
                                        '[class*="consent"] button',
                                    ];

                                    const click = (el, reason) => {
                                        
                                        console.log(`[Consent Eval] Clicking: ${reason}`);
                                        el.click();
                                        return true;
                                    };

                                    
                                    const allButtons = document.querySelectorAll('button, [role="button"]');
                                    for (const button of allButtons) {
                                        const text = (button.innerText || button.textContent || button.getAttribute('aria-label') || '').toLowerCase();
                                        if (positiveTexts.some(pt => text.includes(pt))) {
                                            return click(button, `Button with text "${text}"`);
                                        }
                                    }

                                    
                                    for (const selector of selectors) {
                                        const el = document.querySelector(selector);
                                        if (el) return click(el, `Element with selector "${selector}"`);
                                    }
                                    
                                    return false;
                                });

                                if (frameClicked) {
                                    clicked = true;
                                    break; 
                                }
                            } catch (e) {  }
                        }
                        if (clicked) break; 

                        console.log(`[Consent] No button found yet, waiting... (Attempt ${i + 1}/7)`);
                        await new Promise(r => setTimeout(r, 500));
                    }

                    if (clicked) {
                        console.log('[Consent] Consent button clicked. Waiting for page to settle...');
                        await new Promise(r => setTimeout(r, 2500));
                    } else {
                        console.log('[Consent] Could not find a consent button to click.');
                    }

                } catch (e) {
                    console.log(`[Consent] Error during auto-consent: ${e.message}`);
                }

                if (await detectPaywall(page)) {
                    throw new Error("Paywall detected.");
                }

                finalUrl = page.url();
                const bodyHtml = await page.content();
                const doc = new JSDOM(bodyHtml, { url: finalUrl });
                const reader = new Readability(doc.window.document);
                const readableArticle = reader.parse();
                
                if (!readableArticle || !readableArticle.textContent || readableArticle.textContent.length < 100) {
                    console.log(`[Puppeteer] Readability failed on ${finalUrl}, falling back to <p> tags.`);
                    articleText = await page.evaluate(() => {
                        return Array.from(document.querySelectorAll('p')).map(p => p.textContent).join('\n');
                    });
                } else {
                    articleText = readableArticle.textContent;
                }

            } catch (puppeteerError) {
                throw new Error(`Puppeteer failed for ${link}: ${puppeteerError.message}`);
            }
        }

        if (finalUrl.endsWith('.pdf') || finalUrl.includes('youtube.com')) {
            throw new Error(`Skipping PDF/Video: ${finalUrl}`);
        }
        if (!articleText || articleText.length < 250) {
            throw new Error(`Not enough content to summarize (${articleText.length} chars): ${finalUrl}`);
        }

        const summarizedText = await summarizeText(articleText, length);
        
        const newSummary = { title: article.title, summary: summarizedText, link: finalUrl, date: article.pubDate };
        
            db.run(
                `INSERT INTO articles (link, title, summary, date, open_count, cached_at) VALUES (?, ?, ?, ?, 1, datetime('now')) ON CONFLICT(link) DO UPDATE SET title=excluded.title, summary=excluded.summary, date=excluded.date, open_count=open_count+1, cached_at=datetime('now')`,
                [newSummary.link, newSummary.title, newSummary.summary, newSummary.date]
            );
        
            return newSummary;
            })(), 90000); 
        };
module.exports = { summarizeArticleTask };