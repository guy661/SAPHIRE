
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
const { summarizeArticleTask, semanticCheckTask } = require('./task.js');
const { createUser, getUserByUsername, db, getTopicByUserId, upsertTopic } = require('./database.js');
const session = require('express-session');
const bcrypt = require('bcrypt');

// Apply the StealthPlugin to Puppeteer
puppeteer.use(StealthPlugin());

// Session configuration
const SESS_SECRET = process.env.SESS_SECRET || 'your-default-secret';
const IN_PROD = process.env.NODE_ENV === 'production';




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
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

let cluster;
let isClusterReady = false;

async function initializeCluster() {
    try {
        console.log('[Server] Initializing Puppeteer cluster in the background...');
        cluster = await Cluster.launch({
            concurrency: Cluster.CONCURRENCY_PAGE,
            maxConcurrency: 4, // Lowered concurrency to reduce resource load during semantic check
            puppeteer: puppeteer,
            puppeteerOptions: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            },
            timeout: 120000 // Increased timeout for potentially long tasks
        });
        // Register both tasks with explicit names
        await cluster.task('summarizeArticleTask', summarizeArticleTask);
        await cluster.task('semanticCheckTask', semanticCheckTask);

        isClusterReady = true;
        console.log('[Server] ✅ Puppeteer cluster successfully started with all tasks.');
    } catch (err) {
        console.error('[Server] ❌ Critical error: Puppeteer cluster failed to launch.', err);
    }
}

async function main() {
    if (!process.env.GEMINI_API_KEY || !process.env.SESS_SECRET) {
        console.error("Error: Missing GEMINI_API_KEY or SESS_SECRET in the .env file.");
        process.exit(1);
    }

    const app = express();
    app.use(cors({
        origin: 'http://localhost:3001',
        credentials: true,
    }));
    app.use(express.json());

    app.use(session({
        name: 'sid',
        resave: false,
        saveUninitialized: false,
        secret: SESS_SECRET,
        cookie: {
            maxAge: 1000 * 60 * 60 * 2, // 2 hours
            sameSite: true,
            secure: IN_PROD
        }
    }));

    const isAuthenticated = (req, res, next) => {
        if (req.session.userId) {
            next();
        } else {
            res.status(401).json({ error: 'Unauthorized' });
        }
    };

    const parser = new Parser();

    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
        try {
            const user = await getUserByUsername(username);
            if (!user) return res.status(401).json({ error: 'Invalid credentials' });
            const isValidPassword = await bcrypt.compare(password, user.password);
            if (!isValidPassword) return res.status(401).json({ error: 'Invalid credentials' });
            req.session.userId = user.id;
            req.session.username = user.username;
            res.status(200).json({ message: 'Logged in successfully', username: user.username, userId: user.id });
        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ error: 'An error occurred during login' });
        }
    });

    app.post('/api/logout', isAuthenticated, (req, res) => {
        req.session.destroy(err => {
            if (err) return res.status(500).json({ error: 'Failed to log out' });
            res.clearCookie('sid');
            res.status(200).json({ message: 'Logged out successfully' });
        });
    });

    app.get('/api/user', (req, res) => {
        if (req.session.userId && req.session.username) {
            res.status(200).json({ userId: req.session.userId, username: req.session.username });
        } else {
            res.status(401).json({ error: 'Not authenticated' });
        }
    });
    
    app.post('/api/register', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
        try {
            const newUser = await createUser(username, password);
            req.session.userId = newUser.id;
            req.session.username = username;
            res.status(201).json({ message: 'User created successfully', userId: newUser.id, username: username });
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT') {
                res.status(409).json({ error: 'Username already exists' });
            } else {
                res.status(500).json({ error: 'An error occurred during registration' });
            }
        }
    });
    
    app.get("/api/rss", isAuthenticated, async (req, res) => {
        if (!isClusterReady) {
            return res.status(503).json({ error: "The search service is starting up. Please try again in a moment." });
        }

        try {
            const userTopic = await getTopicByUserId(req.session.userId);
            if (!userTopic || !userTopic.main_topic) {
                return res.status(400).json({ error: "No search topic specified. Please set a topic in your personalization settings." });
            }

            // 1. Broad search
            const broadQuery = userTopic.main_topic;
            console.log(`[Semantic Search] Performing broad search for: "${broadQuery}"`);
            const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(broadQuery)}&hl=de&gl=DE&ceid=DE:de`;
            const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!response.ok) throw new Error("Could not load RSS feed for broad search");
            
            const xml = await response.text();
            const feed = await parser.parseString(xml);
            // Limit to first 20 articles for semantic check to manage performance
            const articlesToCheck = feed.items.slice(0, 20); 
            console.log(`[Semantic Search] Found ${articlesToCheck.length} articles to check.`);

            // 2. Semantic filtering in parallel
            const checkPromises = articlesToCheck.map(article => 
                cluster.execute({ article, userTopic }, { task: 'semanticCheckTask' })
            );
            
            const results = await Promise.allSettled(checkPromises);

            const semanticallyMatchedArticles = [];
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    semanticallyMatchedArticles.push(result.value);
                }
            });
            console.log(`[Semantic Search] Matched ${semanticallyMatchedArticles.length} articles after filtering.`);

            if (semanticallyMatchedArticles.length === 0) {
                 return res.status(404).json({ error: "No articles found that match your specific criteria." });
            }
            
            // 3. Sort by newest first
            semanticallyMatchedArticles.sort((a, b) => new Date(b.isoDate) - new Date(a.isoDate));

            // 4. Respond with filtered & sorted list (no summaries yet)
            res.json(semanticallyMatchedArticles);

        } catch (err) {
            console.error('[Semantic Search] Error in /api/rss:', err);
            res.status(500).json({ error: err.message || "Error during semantic article search" });
        }
    });

    app.get('/api/topics', isAuthenticated, async (req, res) => {
        try {
            const topic = await getTopicByUserId(req.session.userId);
            res.json(topic || {});
        } catch (error) {
            console.error('Error fetching topic:', error);
            res.status(500).json({ error: 'Failed to fetch topic' });
        }
    });

    app.post('/api/topics', isAuthenticated, async (req, res) => {
        const { main_topic, include_keywords, exclude_keywords } = req.body;
        if (!main_topic) return res.status(400).json({ error: 'Main topic is required' });
        try {
            await upsertTopic(req.session.userId, {
                main_topic,
                include_keywords: include_keywords || '',
                exclude_keywords: exclude_keywords || ''
            });
            res.status(200).json({ message: 'Topic saved successfully' });
        } catch (error) {
            console.error('Error saving topic:', error);
            res.status(500).json({ error: 'Failed to save topic' });
        }
    });
    
    app.post("/api/summarize", isAuthenticated, async (req, res) => {
        if (!isClusterReady) {
            return res.status(503).json({ error: "The summary service is starting up. Please try again in a moment." });
        }
        try {
            const { articles, length } = req.body;
            if (!articles?.length) return res.status(400).json({ error: "No articles provided" });

            const summaryPromises = articles.map(article => 
                cluster.execute({ article, length }, { task: 'summarizeArticleTask' })
            );

            const results = await Promise.allSettled(summaryPromises);

            const successfulSummaries = [];
            const failedArticles = [];
            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    successfulSummaries.push(result.value);
                } else {
                    failedArticles.push({ link: articles[index].link, error: result.reason.message });
                }
            });

            if (successfulSummaries.length === 0 && failedArticles.length > 0) {
                return res.status(500).json({ error: "Could not summarize any articles.", details: failedArticles });
            }

            const originalOrder = articles.map(a => a.link);
            successfulSummaries.sort((a, b) => originalOrder.indexOf(a.link) - originalOrder.indexOf(b.link));
            
            let metaSummary = null;
            if (successfulSummaries.length > 1) {
                const metaSummaryPrompt = `Fasse diese ${successfulSummaries.length} Zusammenfassungen in einem kurzen Absatz zusammen (maximal 4 Sätze), der die wichtigsten gemeinsamen Themen oder Schlussfolgerungen hervorhebt:\n\n` + successfulSummaries.map((s, i) => `Zusammenfassung ${i+1}:\n${s.summary}`).join('\n\n');
                metaSummary = await callGemini(metaSummaryPrompt);
            }

            res.json({ summaries: successfulSummaries, metaSummary });
        } catch (err) {
            console.error(err);
            if (!res.headersSent) res.status(500).json({ error: err.message || "Error with AI summary" });
        }
    });

    app.get('/', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'AI-Projekt.html'));
    });

    app.get('/personalization', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'personalization.html'));
    });
    
    app.use(express.static(path.join(__dirname, 'public')));

    const PORT = 3001;
    app.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        console.log("Server is now listening for requests.");
        initializeCluster();
    });

    const cleanup = async () => {
        console.log('[Server] Closing server...');
        if (cluster) {
            await cluster.idle();
            await cluster.close();
            console.log('[Server] Puppeteer cluster closed.');
        }
        process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

main().catch(err => { console.error("Unhandled error in main:", err); process.exit(1); });

async function retry(fn, retries = 3, delay = 1000) {
    try { return await fn(); } catch (err) {
        if (retries > 0) {
            console.log(`Retrying... attempts left: ${retries}`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return retry(fn, retries - 1, delay * 2);
        }
        throw err;
    }
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
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

async function extractRealUrl(googleRssUrl) {
    return retry(async () => {
        try {
            const response = await axios.get(googleRssUrl, { timeout: 15000 });
            const $ = cheerio.load(response.data);
            const data = $('c-wiz[data-p]').attr('data-p');
            if (!data) return googleRssUrl;
            const obj = JSON.parse(data.replace('%.@.', '["garturlreq",'));
            const payload = { 'f.req': JSON.stringify([[['Fbv4je', JSON.stringify([...obj.slice(0, -6), ...obj.slice(-2)]), 'null', 'generic']]]) };
            const headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36' };
            const postResponse = await axios.post('https://news.google.com/_/DotsSplashUi/data/batchexecute', new URLSearchParams(payload).toString(), { headers, timeout: 15000 });
            const arrayString = JSON.parse(postResponse.data.replace(")]}'", ""))[0][2];
            return JSON.parse(arrayString)[1];
        } catch (e) {
            console.error("Error extracting the real URL, retrying:", e.message);
            if (e.response) console.error(`Status: ${e.response.status}, Data: ${String(e.response.data).slice(0, 100)}...`);
            throw e; 
        }
    }).catch(err => {
        console.error("Error extracting the real URL after multiple attempts:", err.message);
        return googleRssUrl;
    });
}