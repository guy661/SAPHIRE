require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Cluster } = require('puppeteer-cluster');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Parser = require('rss-parser');
const path = require('path');
const fetch = require('node-fetch');
const { default: axios } = require('axios');
const cheerio = require('cheerio');
const { summarizeArticleTask } = require('./task.js');

puppeteer.use(StealthPlugin());

async function retry(fn, retries = 3, delay = 1000) {
    try {
        return await fn();
    } catch (err) {
        if (retries > 0) {
            console.log(`Retrying... attempts left: ${retries}`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return retry(fn, retries - 1, delay * 2);
        }
        throw err;
    }
}

async function main() {
    console.log("main function started");
    if (!process.env.GEMINI_API_KEY) {
        console.error("Fehler: GEMINI_API_KEY ist nicht in der .env-Datei gesetzt.");
        process.exit(1);
    }

    const cluster = await Cluster.launch({
        concurrency: Cluster.CONCURRENCY_PAGE,
        maxConcurrency: 8,
        puppeteer: puppeteer,
        puppeteerOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        },
        timeout: 180000
    });
    await cluster.task(summarizeArticleTask); // set default task
    console.log("Cluster launched or launching...");

    console.log('[Server] ✅ Puppeteer cluster launched successfully.');

    const app = express();
    app.use(cors());
    app.use(express.json());

    const parser = new Parser();

    async function extractRealUrl(googleRssUrl) {
        return retry(async () => {
            try {
                const response = await axios.get(googleRssUrl, { timeout: 15000 });
                const $ = cheerio.load(response.data);
                const data = $('c-wiz[data-p]').attr('data-p');
                if (!data) {
                    // If data-p is not found, it might be a direct link already.
                    return googleRssUrl;
                }
                const obj = JSON.parse(data.replace('%.@.', '["garturlreq",'));

                const payload = {
                  'f.req': JSON.stringify([[['Fbv4je', JSON.stringify([...obj.slice(0, -6), ...obj.slice(-2)]), 'null', 'generic']]])
                };

                const headers = {
                  'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
                };

                const postResponse = await axios.post('https://news.google.com/_/DotsSplashUi/data/batchexecute', new URLSearchParams(payload).toString(), { headers, timeout: 15000 });
                const arrayString = JSON.parse(postResponse.data.replace(")]}'", ""))[0][2];
                const articleUrl = JSON.parse(arrayString)[1];

                return articleUrl;
            } catch (e) {
                console.error("Error extracting real URL, will retry:", e.message);
                // Also check for specific axios error properties if available
                if (e.response) {
                    console.error(`Status: ${e.response.status}, Data: ${e.response.data.slice(0, 100)}...`);
                }
                throw e; // Throw error to trigger retry
            }
        }).catch(err => {
            console.error("Failed to extract real URL after multiple retries:", err.message);
            return googleRssUrl; // Fallback to original URL after all retries fail
        });
    }

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

            const cleanedItems = await Promise.all(feed.items.slice(0, 10).map(async (item) => {
                const realUrl = await extractRealUrl(item.link) || item.source?.url || item.link;
                return {
                    ...item,
                    link: realUrl
                };
            }));

            res.json(cleanedItems);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message || "Fehler beim Abrufen des RSS-Feeds" });
        }
    });

    app.post("/summarize", async (req, res) => {
        console.log("Summarize endpoint called");
        try {
            const { articles, length } = req.body;
            if (!articles?.length) {
                return res.status(400).json({ error: "Keine Artikel übergeben" });
            }

            const successfulSummaries = [];
            const failedArticles = [];
            const SUMMARY_TARGET = 3;
            const BATCH_SIZE = 5;

            for (let i = 0; i < articles.length; i += BATCH_SIZE) {
                if (successfulSummaries.length >= SUMMARY_TARGET) {
                    break;
                }

                const batch = articles.slice(i, i + BATCH_SIZE);
                console.log(`Processing batch of ${batch.length} articles...`);
                
                const batchPromises = [];
                for (const article of batch) {
                    console.log('Executing cluster task for article:', article.link);
                    const promise = cluster.execute({ article, length })
                        .then(summary => {
                            if (successfulSummaries.length < SUMMARY_TARGET) {
                                successfulSummaries.push(summary);
                            }
                        })
                        .catch(err => {
                            console.error(`Error processing article ${article.link} in cluster: ${err.message}`);
                            failedArticles.push({ link: article.link, error: err.message });
                        });
                    batchPromises.push(promise);
                    // Wait for a short period before the next request in the batch
                    if (batch.indexOf(article) < batch.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
                    }
                }
                await Promise.all(batchPromises);

                // The old logic with long waits and Promise.allSettled is removed.
                // The new logic processes sequentially with short delays.
            }

            const finalSummaries = successfulSummaries.slice(0, SUMMARY_TARGET);
            console.log(`Responding with ${finalSummaries.length} summaries.`);

            if (finalSummaries.length === 0 && failedArticles.length > 0) {
                return res.status(500).json({
                    error: "Konnte keine Artikel zusammenfassen.",
                    details: failedArticles,
                });
            }

            const originalOrder = articles.map(a => a.link);
            finalSummaries.sort((a, b) => originalOrder.indexOf(a.link) - originalOrder.indexOf(b.link));
            res.json(finalSummaries);

        } catch (err) {
            console.error(err);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message || "Fehler bei AI-Zusammenfassung" });
            }
        }
    });

    app.get('/', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'AI-Projekt.html'));
    });
    app.use(express.static(path.join(__dirname, 'public')));

    const PORT = 3001;
    console.log(`[Server] Attempting to listen on port: ${PORT}`);
    console.log("Express app configured, starting server...");
    app.listen(PORT, () => {
        console.log(`✅ Server läuft auf http://localhost:${PORT}`);
        console.log("Server is now listening for requests.");
    });

    const cleanup = async () => {
        console.log('[Server] Closing cluster...');
        await cluster.idle();
        await cluster.close();
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

main().catch(err => { console.error("Unhandled error in main:", err); process.exit(1); });
