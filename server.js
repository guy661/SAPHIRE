require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Cluster } = require('puppeteer-cluster');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Parser = require('rss-parser');
const path = require('path');
const fetch = require('node-fetch');
const { summarizeArticleTask } = require('./task.js');

puppeteer.use(StealthPlugin());

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

            const cleanedItems = feed.items.slice(0, 10).map(item => {
                return { ...item, link: item.link };
            });

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
                
                const promises = batch.map(article => {
                    console.log('Executing cluster task for article:', article.link);
                    return cluster.execute({ article, length });
                });
                const results = await Promise.allSettled(promises);

                results.forEach((result, index) => {
                    if (result.status === 'fulfilled' && result.value) {
                        if (successfulSummaries.length < SUMMARY_TARGET) {
                            successfulSummaries.push(result.value);
                        }
                    } else if (result.status === 'rejected') {
                        const failedLink = batch[index].link;
                        console.error(`Error processing article ${failedLink} in cluster: ${result.reason.message}`);
                        failedArticles.push({ link: failedLink, error: result.reason.message });
                    }
                });
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

    const PORT = process.env.PORT || 3001;
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