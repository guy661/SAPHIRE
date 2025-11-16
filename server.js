const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const Parser = require("rss-parser");
const fetch = require("node-fetch");
const { Readability } = require("@mozilla/readability");
const { JSDOM } = require("jsdom");
const puppeteer = require("puppeteer");
const chromium = require('@sparticuz/chromium');
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

            console.log(`[Puppeteer] Warte auf Seitenstabilität (2s)...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            console.log(`[Puppeteer] Seitenstabilität erreicht.`);

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
        db.get("SELECT * FROM articles WHERE link = ?", [link], async (err, row) => {
            if (err) {
                return reject(err);
            }

            if (row && row.open_count >= 10) {
                return reject(new Error("Inhaltszugang blockiert: Der Artikel wurde bereits 10 Mal geöffnet."));
            }

            try {
                const articleDate = new Date(article.pubDate);
                const thirtyDaysAgo = new Date();
                thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

                if (articleDate < thirtyDaysAgo) {
                    throw new Error("Inhaltszugang blockiert: Der eigentliche Artikel ist für den Nutzer nicht zugänglich, da der bereitgestellte Link älter als 30 Tage ist.");
                }

                const { finalUrl, articleText } = await getPageContentWithPuppeteer(article.link, browser);

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
                    console.log(`📝 Artikel wird in ${chunks.length} Teile für ${article.link} aufgeteilt`);
                    const chunkSummaryPromises = chunks.map(chunk => {
                        const prompt = `Zusammenfassung des Abschnitts:\n\n${chunk}`;
                        return callGemini(prompt);
                    });
                    const chunkSummaries = await Promise.all(chunkSummaryPromises);
                    const combinationPrompt = `
                        Kombinieren Sie diese Zusammenfassungen zu einer Gesamtzusammenfassung im '${length}' Stil.
                        ${basePrompt}
                        Zusammenfassungen:\n${chunkSummaries.join("\n---\n")}`;
                    summarizedText = await callGemini(combinationPrompt);
                } else {
                    console.log(`📝 Artikel wird direkt für ${article.link} zusammengefasst`);
                    const prompt = `
                        ${basePrompt}
                        Artikel:\n${text}`;
                    summarizedText = await callGemini(prompt);
                }

                console.log(`✅ Endgültige Zusammenfassung für ${article.link} erstellt`);
                const summary = {
                  title: article.title,
                  summary: summarizedText,
                  link: article.link,
                  date: article.pubDate,
                };

                if (row) {
                    db.run("UPDATE articles SET open_count = open_count + 1 WHERE link = ?", [link], (err) => {
                        if (err) console.error(err);
                    });
                } else {
                    db.run("INSERT INTO articles (link, open_count) VALUES (?, 1)", [link], (err) => {
                        if (err) console.error(err);
                    });
                }
                resolve(summary);

            } catch (articleError) {
                console.error(`Fehler bei der Verarbeitung des Artikels ${article.link}:`, articleError.message);
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
        const executablePath = await chromium.executablePath();
        browser = await puppeteer.launch({
            args: [...chromium.args, '--disable-dev-shm-usage', '--no-sandbox'],
            defaultViewport: chromium.defaultViewport,
            executablePath: executablePath,
            headless: chromium.headless,
            ignoreHTTPSErrors: true
        });
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
        console.error('[Server] ‼️ Failed to launch persistent browser instance:', e);
        process.exit(1);
    }


    const app = express();
    app.use(cors());
    app.use(bodyParser.json());

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
            res.json(feed.items.slice(0, 10));
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

            const CONCURRENCY_LIMIT = parseInt(process.env.PUPPETEER_CONCURRENCY, 10) || 2;
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
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/', (req, res) => {
        res.set('Cache-Control', 'no-store'); // optional
        res.sendFile(path.join(__dirname, 'public', 'AI-Projekt.html'));
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`✅ Server läuft auf http://localhost:${PORT}`));
}

main();
