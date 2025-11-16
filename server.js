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
const { Cluster } = require('puppeteer-cluster');

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
async function main() {
    if (!process.env.GEMINI_API_KEY) {
        console.error("Fehler: GEMINI_API_KEY ist nicht in der .env-Datei gesetzt.");
        process.exit(1);
    }

    const cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_PAGE,
        maxConcurrency: 8, // Increased concurrency
        puppeteerOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
        timeout: 120000 // 2 minutes timeout for a task
    });

    console.log('[Server] ✅ Puppeteer cluster launched successfully.');

    // Task to process a single article
    await cluster.task(async ({ page, data: { article, length } }) => {
        const link = article.link;

        // 1. Check cache first
        const cachedArticle = await new Promise((resolve, reject) => {
            db.get("SELECT title, summary, date, cached_at FROM articles WHERE link = ?", [link], (err, row) => {
                if (err) return reject(err); // DB errors should be fatal
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

        // 2. Fast Path Attempt (Lightweight Fetch)
        try {
            console.log(`[Fast Path] Attempting lightweight fetch for ${link}`);
            const response = await fetch(link, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                },
                timeout: 15000 // 15 second timeout for fast path
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            finalUrl = response.url;
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
            // 3. Puppeteer Path (as fallback)
            console.log(`[Fast Path] ❌ Failed: ${fastPathError.message}. Falling back to Puppeteer for ${link}`);
            fs.appendFileSync('failed_urls.log', link + '\n');
            
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

                await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 40000 });

                // Aggressive consent button clicking
                try {
                    await page.evaluate(() => {
                        const selectors = [
                            'button[id*="consent"]', 'button[class*="consent"]', 'button[id*="accept"]', 'button[class*="accept"]',
                            'button[aria-label*="consent"]', 'button[aria-label*="accept"]', 'button:has-text("Accept all")',
                            'button:has-text("Zustimmen")'
                        ];
                        const consentButton = document.querySelector(selectors.join(', '));
                        if (consentButton) consentButton.click();
                    });
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                } catch (e) { /* ignore */ }

                if (await detectPaywall(page)) {
                    throw new Error("Paywall detected.");
                }

                finalUrl = page.url();
                const bodyHtml = await page.content();
                const doc = new JSDOM(bodyHtml, { url: finalUrl });
                const reader = new Readability(doc.window.document);
                const readableArticle = reader.parse();
                
                if (!readableArticle || !readableArticle.textContent || readableArticle.textContent.length < 100) {
                     // If Readability fails, grab all paragraph text as a last resort
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

        // 4. Final checks and summarization
        if (finalUrl.endsWith('.pdf') || finalUrl.includes('youtube.com')) {
            throw new Error(`Skipping PDF/Video: ${finalUrl}`);
        }
        if (!articleText || articleText.length < 250) {
            throw new Error(`Not enough content to summarize: ${finalUrl}`);
        }

        const summarizedText = await summarizeText(articleText, length);
        const newSummary = { title: article.title, summary: summarizedText, link: article.link, date: article.pubDate };
        
        // 5. Save to DB
        db.run(
            `INSERT INTO articles (link, title, summary, date, open_count, cached_at) VALUES (?, ?, ?, ?, 1, datetime('now')) ON CONFLICT(link) DO UPDATE SET title=excluded.title, summary=excluded.summary, date=excluded.date, open_count=open_count+1, cached_at=datetime('now')`,
            [newSummary.link, newSummary.title, newSummary.summary, newSummary.date]
        );

        return newSummary;
    });

    // Helper function for summarization logic, moved inside main to close over chunkText and callGemini
    async function summarizeText(text, length) {
        const chunks = chunkText(text.trim());
        const lengthPrompts = {
            short: "Kurze Zusammenfassung (2-3 Sätze):",
            medium: "Zusammenfassung (Überblick + 3-4 Stichpunkte):",
            long: "Detaillierte Zusammenfassung (Überblick + 5-6 Stichpunkte mit Erklärungen):"
        };
        const basePrompt = lengthPrompts[length] || lengthPrompts.medium;

        if (chunks.length > 1) {
            const chunkSummaryPromises = chunks.map(chunk => callGemini(`Fasse diesen Textabschnitt zusammen:\n\n${chunk}`));
            const chunkSummaries = await Promise.all(chunkSummaryPromises);
            const combinationPrompt = `Kombinieren Sie diese Zusammenfassungen zu einer Gesamtzusammenfassung im '${length}' Stil.\n${basePrompt}\nZusammenfassungen:\n${chunkSummaries.join("\n---\n")}`;
            return callGemini(combinationPrompt);
        } else {
            const prompt = `${basePrompt}\nArtikel:\n${chunks[0]}`;
            return callGemini(prompt);
        }
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

            const cleanedItems = feed.items.map(item => {
                const content = item.content || item.contentSnippet || '';
                const urlMatch = content.match(/<a href="(.*?)">/);
                return { ...item, link: urlMatch ? urlMatch[1] : item.link };
            }).slice(0, 10);

            res.json(cleanedItems);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message || "Fehler beim Abrufen des RSS-Feeds" });
        }
    });

    // ===== AI-Zusammenfassung =====
    app.post("/summarize", (req, res) => {
        console.log("Summarize endpoint called");
        try {
            const { articles, length } = req.body;
            if (!articles?.length) {
                return res.status(400).json({ error: "Keine Artikel übergeben" });
            }

            const successfulSummaries = [];
            const failedArticles = [];
            const SUMMARY_TARGET = 3;
            let articlesProcessed = 0;

            const resolveAndRespond = () => {
                // Ensure we only send a response once
                if (res.headersSent) {
                    return;
                }

                const finalSummaries = successfulSummaries.slice(0, SUMMARY_TARGET);
                console.log(`Responding with ${finalSummaries.length} summaries.`);

                if (finalSummaries.length === 0 && failedArticles.length > 0 && failedArticles.length === articles.length) {
                    res.status(500).json({
                        error: "Konnte keine Artikel zusammenfassen.",
                        details: failedArticles,
                    });
                } else {
                    // Sort summaries to match original article order for consistency
                    const originalOrder = articles.map(a => a.link);
                    finalSummaries.sort((a, b) => originalOrder.indexOf(a.link) - originalOrder.indexOf(b.link));
                    res.json(finalSummaries);
                }
            };

            // If there are no articles, respond immediately.
            if (articles.length === 0) {
                return resolveAndRespond();
            }

            for (const article of articles) {
                cluster.execute({ article, length })
                    .then(summary => {
                        if (summary && successfulSummaries.length < SUMMARY_TARGET) {
                            successfulSummaries.push(summary);
                        }
                        // If we hit the target, respond immediately
                        if (successfulSummaries.length >= SUMMARY_TARGET) {
                            resolveAndRespond();
                        }
                    })
                    .catch(err => {
                        console.error(`Error processing article ${article.link} in cluster: ${err.message}`);
                        failedArticles.push({ link: article.link, error: err.message });
                    })
                    .finally(() => {
                        articlesProcessed++;
                        // If all articles are processed (successfully or not), make sure we respond
                        if (articlesProcessed === articles.length) {
                            resolveAndRespond();
                        }
                    });
            }
        } catch (err) {
            console.error(err);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message || "Fehler bei AI-Zusammenfassung" });
            }
        }
    });

    // ===== statische Dateien =====
    app.get('/', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'AI-Projekt.html'));
    });
    app.use(express.static(path.join(__dirname, 'public')));

    const PORT = process.env.PORT || 3001;
    console.log(`[Server] Attempting to listen on port: ${PORT}`);
    app.listen(PORT, () => console.log(`✅ Server läuft auf http://localhost:${PORT}`));

    const cleanup = async () => {
        console.log('[Server] Closing cluster...');
        await cluster.idle();
        await cluster.close();
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

main();

