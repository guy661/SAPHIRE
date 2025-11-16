console.log('--- RUNNING SERVER.JS VERSION 2 ---');

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Parser = require("rss-parser");
const fetch = require("node-fetch");
const { Readability } = require("@mozilla/readability");
const { JSDOM } = require("jsdom");
const puppeteer = require("puppeteer");
const fs = require("fs");

const path = require('path');
const db = require('./database.js');

require("dotenv").config();

// --- Helper Functions ---

/**
 * Splits a long text into smaller chunks of a specified size.
 * @param {string} text The text to split.
 * @param {number} chunkSize The approximate size of each chunk in characters.
 * @returns {string[]} An array of text chunks.
 */
function chunkText(text, chunkSize = 8000) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
}

async function detectPaywall(page) {
    // 1. JSON-LD Check
    try {
        const jsonLd = await page.evaluate(() => {
            const script = document.querySelector('script[type="application/ld+json"]');
            if (script) {
                return JSON.parse(script.innerText);
            }
            return null;
        });

        if (jsonLd) {
            if (Array.isArray(jsonLd)) {
                for (const item of jsonLd) {
                    if (item.isAccessibleForFree === "False" || item.isAccessibleForFree === false) {
                        console.log('Paywall detected by JSON-LD: isAccessibleForFree is false.');
                        return true;
                    }
                }
            } else if (jsonLd.isAccessibleForFree === "False" || jsonLd.isAccessibleForFree === false) {
                console.log('Paywall detected by JSON-LD: isAccessibleForFree is false.');
                return true;
            }
        }
    } catch (e) {
        console.log("Could not parse JSON-LD, continuing with other checks.");
    }

    // 2. Selector-based detection
    const paywallSelectors = [
        '.paywall', '.g-overlay', 'div[id*="paywall"]', 'div[class*="paywall"]',
        '.modal-dialog.paywall-modal', '.tp-modal', '.ob-paywall',
        // Add more selectors for common paywall providers
        '[id*="pigeon-widget"]', '[class*="pigeon-"]', // Pigeon
        '[id*="zephr-"]', '[class*="zephr-"]', // Zephr
        '[class*="piano-"]', // Piano
    ];

    for (const selector of paywallSelectors) {
        const element = await page.$(selector);
        if (element) {
            console.log(`Paywall detected by selector: ${selector}`);
            return true;
        }
    }

    // 3. Keyword-based detection
    const pageText = await page.evaluate(() => document.body.innerText);
    const paywallKeywords = [
        'subscribe to read more', 'full access', 'premium content', 'subscriber-only',
        'unlock article', 'register to continue', 'you have reached your limit',
        'become a member', 'log in to read', 'create an account to continue',
        'continue reading with a subscription'
    ];

    for (const keyword of paywallKeywords) {
        if (pageText.toLowerCase().includes(keyword)) {
            console.log(`Paywall detected by keyword: "${keyword}"`);
            return true;
        }
    }

    return false;
}

/**
 * Uses Puppeteer to get a page's HTML, then aggressively cleans junk elements
 * before passing the result to Readability.
 * @param {string} url The initial URL to visit.
 * @param {object} browser The persistent browser instance.
 * @returns {Promise<{finalUrl: string, cleanHtml: string}>} The final URL and the cleaned HTML of the page body.
 */
async function getPageContentWithPuppeteer(url, browser) {
    let page;
    const PUPPETEER_TIMEOUT = 60000; // 60 seconds for the entire operation

    const operationPromise = new Promise(async (resolve, reject) => {
        try {
            console.log(`[Puppeteer] Creating new page in existing browser for ${url}`);
            page = await browser.newPage();
            console.log(`[Puppeteer] Neue Seite erstellt.`);

            // --- OPTIMIZATION: Block non-essential resources ---
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1280, height: 800 });
            console.log(`[Puppeteer] User Agent und Viewport gesetzt.`);

            console.log(`[Puppeteer] Navigiere zu ${url}...`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
            console.log(`[Puppeteer] Navigation abgeschlossen.`);

            try {
                console.log(`[Puppeteer] Suche nach Google-Zustimmungs-Button...`);
                await page.waitForSelector('form button', { timeout: 5000 });
                const clicked = await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('form button'));
                    if (buttons.length > 0) {
                        const agreeButton = buttons[buttons.length - 1];
                        if (agreeButton) {
                            agreeButton.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (clicked) {
                    console.log("[Puppeteer] ✅ Google-Zustimmungs-Button via page.evaluate() geklickt.");
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 });
                    console.log("[Puppeteer] ✅ Navigation nach Zustimmungs-Klick abgeschlossen.");
                }
            } catch (error) {
                console.log("[Puppeteer] ... Kein Google-Zustimmungsformular gefunden, fahre mit aktueller Seite fort.");
            }

            console.log(`[Puppeteer] Prüfe auf Paywall...`);
            if (await detectPaywall(page)) {
                throw new Error("Inhaltszugang blockiert: Der Artikel scheint hinter einer Paywall zu sein.");
            }
            console.log(`[Puppeteer] Paywall-Prüfung abgeschlossen.`);

            const finalUrl = page.url();
            const fullHtml = await page.content();
            console.log(`[Puppeteer] HTML-Inhalt von ${finalUrl} abgerufen.`);

            // --- Use Readability for robust article extraction ---
            console.log(`[Puppeteer] ... Extrahiere Artikeltext mit Readability von: ${finalUrl}`);
            const doc = new JSDOM(fullHtml, { url: finalUrl });
            const reader = new Readability(doc.window.document);
            const article = reader.parse();

            // Check if Readability successfully parsed the article
            if (!article || !article.textContent) {
                console.log("[Puppeteer] ... Readability konnte keinen Inhalt finden. Fallback auf Paragraphen-Extraktion.");
                // Fallback to simple paragraph extraction if Readability fails
                const paragraphs = Array.from(doc.window.document.body.querySelectorAll('p'));
                const fallbackText = paragraphs.map(p => p.textContent.trim()).join('\n\n');
                console.log(`[Puppeteer] ✅ ${fallbackText.length} Zeichen via Fallback extrahiert.`);
                resolve({ finalUrl, articleText: fallbackText });
            } else {
                const articleText = article.textContent.trim();
                console.log(`[Puppeteer] ✅ ${articleText.length} Zeichen mit Readability extrahiert.`);
                resolve({ finalUrl, articleText });
            }
        } catch (error) {
            reject(error);
        } finally {
            if (page) {
                await page.close();
                console.log("[Puppeteer] ✅ Page closed.");
            }
        }
    });

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Puppeteer operation timed out after ${PUPPETEER_TIMEOUT / 1000} seconds`)), PUPPETEER_TIMEOUT)
    );

    return Promise.race([operationPromise, timeoutPromise]);
}


// --- Global Helper for Gemini API ---
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
    return data.candidates[0]?.content?.parts[0]?.text || "";
}

// --- Helper to process a single article ---
async function summarizeSingleArticle(article, length = 'medium', browser) {
    return new Promise((resolve, reject) => {
        const link = article.link;
        const CACHE_DURATION_HOURS = 24;

        db.get("SELECT title, summary, date, cached_at FROM articles WHERE link = ?", [link], async (err, row) => {
            if (err) return reject(err);

            if (row && row.summary) {
                const cachedDate = new Date(row.cached_at);
                const now = new Date();
                const hoursDiff = (now - cachedDate) / (1000 * 60 * 60);
                if (hoursDiff < CACHE_DURATION_HOURS) {
                    console.log(`[Cache] ✅ HIT for ${link}`);
                    return resolve({ title: row.title, summary: row.summary, link: link, date: row.date });
                }
                console.log(`[Cache] Stale cache for ${link}`);
            } else {
                console.log(`[Cache] ❌ MISS for ${link}`);
            }

            try {
                let articleText;
                let finalUrl = link;

                // --- OPTIMIZATION: Hybrid Content Extraction ---
                try {
                    console.log(`[Fast Path] Attempting lightweight fetch for ${link}`);
                    const response = await fetch(link, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
                            'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                            'Accept-Encoding': 'gzip, deflate, br',
                            'Connection': 'keep-alive',
                            'Upgrade-Insecure-Requests': '1',
                            'Sec-Fetch-Dest': 'document',
                            'Sec-Fetch-Mode': 'navigate',
                            'Sec-Fetch-Site': 'none',
                            'Sec-Fetch-User': '?1',
                        }
                    });
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    
                    finalUrl = response.url; // Use the final URL after redirects
                    const html = await response.text();
                    const doc = new JSDOM(html, { url: finalUrl });
                    const reader = new Readability(doc.window.document);
                    const readableArticle = reader.parse();

                    if (readableArticle && readableArticle.textContent && readableArticle.textContent.length > 250) {
                        console.log(`[Fast Path] ✅ Success for ${link}`);
                        articleText = readableArticle.textContent;
                    } else {
                        throw new Error('Lightweight extraction failed to get enough content.');
                    }
                } catch (fastPathError) {
                    console.log(`[Fast Path] ❌ Failed: ${fastPathError.message}. Falling back to Puppeteer.`);
                    fs.appendFileSync('failed_urls.log', link + '\n');
                    const puppeteerResult = await getPageContentWithPuppeteer(link, browser);
                    articleText = puppeteerResult.articleText;
                    finalUrl = puppeteerResult.finalUrl;
                }
                // --- End of Hybrid Extraction ---

                if (finalUrl.endsWith('.pdf') || finalUrl.includes('youtube.com')) {
                    throw new Error(`Überspringe Artikel (PDF/Video): ${finalUrl}`);
                }
                if (!articleText || articleText.length < 250) {
                    throw new Error(`Überspringe Artikel (zu wenig Inhalt): ${finalUrl}`);
                }

                const text = articleText.trim();
                const chunks = chunkText(text);
                let summarizedText;

                const lengthPrompts = {
                    short: "Kurze Zusammenfassung (2-3 Sätze):",
                    medium: "Zusammenfassung (Überblick + 3-4 Stichpunkte):",
                    long: "Detaillierte Zusammenfassung (Überblick + 5-6 Stichpunkte mit Erklärungen):"
                };
                const basePrompt = lengthPrompts[length] || lengthPrompts.medium;

                if (chunks.length > 1) {
                    const chunkSummaryPromises = chunks.map(chunk => callGemini(`Zusammenfassung des Abschnitts:\n\n${chunk}`));
                    const chunkSummaries = await Promise.all(chunkSummaryPromises);
                    const combinationPrompt = `Kombinieren Sie diese Zusammenfassungen zu einer Gesamtzusammenfassung im '${length}' Stil.\n${basePrompt}\nZusammenfassungen:\n${chunkSummaries.join("\n---\n")}`;
                    summarizedText = await callGemini(combinationPrompt);
                } else {
                    const prompt = `${basePrompt}\nArtikel:\n${text}`;
                    summarizedText = await callGemini(prompt);
                }

                const newSummary = {
                    title: article.title,
                    summary: summarizedText,
                    link: article.link,
                    date: article.pubDate,
                };

                db.run(
                    `INSERT INTO articles (link, title, summary, date, open_count, cached_at) 
                     VALUES (?, ?, ?, ?, 1, datetime('now'))
                     ON CONFLICT(link) DO UPDATE SET
                        title = excluded.title,
                        summary = excluded.summary,
                        date = excluded.date,
                        open_count = open_count + 1,
                        cached_at = datetime('now')`,
                    [newSummary.link, newSummary.title, newSummary.summary, newSummary.date],
                    (err) => {
                        if (err) console.error(`[DB] Error saving summary for ${link}:`, err.message);
                        else console.log(`[DB] ✅ Saved new summary for ${link}`);
                    }
                );
                resolve(newSummary);

            } catch (articleError) {
                console.error(`Fehler bei der Verarbeitung des Artikels ${link}:`, articleError.message);
                reject(articleError);
            }
        });
    });
}

// This will hold our single, persistent browser instance
let browser;

async function main() {
    if (!process.env.GEMINI_API_KEY) {
        console.error("Fehler: GEMINI_API_KEY ist nicht in der .env-Datei gesetzt.");
        process.exit(1);
    }

    // --- Launch persistent browser ---
    console.log('[Server] Initializing persistent browser instance...');
    try {
        // Attempt a default launch, assuming the browser has been downloaded by setup.js
        browser = await puppeteer.launch({ headless: true });
        console.log('[Server] ✅ Persistent browser instance launched successfully.');
        
        // Gracefully close browser on application shutdown
        const cleanup = async () => {
            if (browser) {
                console.log('[Server] Closing persistent browser instance.');
                await browser.close();
                browser = null;
            }
            process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

    } catch (e) {
        console.error('[Server] ‼️ Failed to launch browser instance:', e.message);
        console.error('[Server] Es scheint, dass der Browser nicht heruntergeladen ist. Bitte führen Sie zuerst das Setup-Skript aus.');
        console.error('[Server] Führen Sie im Terminal aus: node setup.js');
        process.exit(1);
    }


    const app = express();
    app.use(cors());
    app.use(express.json());

    const parser = new Parser();

    // ===== RSS-Route =====
    app.get("/rss", async (req, res) => {
        try {
            const keyword = req.query.keyword?.trim();
            if (!keyword) return res.status(400).json({ error: "Keine Suche angegeben" });
            const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=de&gl=DE&ceid=DE:de`;
            const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!response.ok) throw new Error("RSS Feed konnte nicht geladen werden");
            const xml = await response.text();
            const feed = await parser.parseString(xml);
            if (!feed.items?.length) return res.status(404).json({ error: "Keine Artikel gefunden" });

            // --- NEW LOGIC: Extract the real URL ---
            const cleanedItems = feed.items.map(item => {
                // The real URL is in the description/content snippet
                const content = item.content || item.contentSnippet || '';
                const urlMatch = content.match(/<a href="(.*?)">/);
                const realUrl = urlMatch ? urlMatch[1] : item.link; // Fallback to original link

                return {
                    ...item,
                    link: realUrl // Overwrite the link property with the real one
                };
            }).slice(0, 10);

            res.json(cleanedItems);

        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message || "Fehler beim Abrufen des RSS-Feeds" });
        }
    });

    // ===== AI-Zusammenfassung =====
    app.post("/summarize", async (req, res) => {
        console.log("Summarize endpoint called");
        if (!browser) {
            console.error("[Server] Summarize called but browser is not initialized.");
            return res.status(503).json({ error: "Browser service is not ready, please try again shortly." });
        }

        try {
            const { articles, length } = req.body;
            if (!articles?.length) return res.status(400).json({ error: "Keine Artikel übergeben" });

            const CONCURRENCY_LIMIT = 3;
            console.log(`[Server] Using concurrency limit of ${CONCURRENCY_LIMIT} pages.`);
            const articlesToProcess = [...articles];
            const successfulSummaries = [];
            const failedArticles = [];
            const SUMMARY_TARGET = 3;

            // This worker function now uses the single, persistent browser instance
            async function worker() {
                while (articlesToProcess.length > 0 && successfulSummaries.length < SUMMARY_TARGET) {
                    const article = articlesToProcess.shift();
                    if (article) {
                        try {
                            const summary = await summarizeSingleArticle(article, length, browser);
                            if (successfulSummaries.length < SUMMARY_TARGET) {
                                successfulSummaries.push(summary);
                            }
                        } catch (error) {
                            console.error(`Failed to process article ${article.link}:`, error.message);
                            failedArticles.push({
                                link: article.link,
                                error: error.message,
                            });
                        }
                    }
                }
            }

            const workers = Array(CONCURRENCY_LIMIT).fill(null).map(() => worker());
            await Promise.all(workers);

            const finalSummaries = successfulSummaries.slice(0, SUMMARY_TARGET);

            console.log(`Erfolgreich ${finalSummaries.length} Zusammenfassungen erstellt.`);

            if (finalSummaries.length === 0 && failedArticles.length > 0) {
                return res.status(500).json({
                    error: "Konnte keine Artikel zusammenfassen.",
                    details: failedArticles
                });
            }

            // Sort summaries to match original article order for consistency
            const originalOrder = articles.map(a => a.link);
            finalSummaries.sort((a, b) => originalOrder.indexOf(a.link) - originalOrder.indexOf(b.link));

            res.json(finalSummaries);

        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message || "Fehler bei AI-Zusammenfassung" });
        }
    });

    // ===== statische Dateien =====
    // Handle the root route explicitly first to ensure it's always served
    app.get('/', (req, res) => {
        res.set('Cache-Control', 'no-store'); // optional
        res.sendFile(path.join(__dirname, 'public', 'AI-Projekt.html'));
    });

    // Then, serve other static files from the 'public' directory
    app.use(express.static(path.join(__dirname, 'public')));

    const PORT = process.env.PORT || 3001;
    console.log(`[Server] Attempting to listen on port: ${PORT}`);
    app.listen(PORT, () => console.log(`✅ Server läuft auf http://localhost:${PORT}`));
}

main();
