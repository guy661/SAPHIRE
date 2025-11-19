
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
const { createUser, getUserByUsername, db } = require('./database.js');
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

async function main() {
    console.log("Main function started");

    
    if (!process.env.GEMINI_API_KEY) {
        console.error("Error: GEMINI_API_KEY is not set in the .env file.");
        process.exit(1); 
    }
    if (!process.env.SESS_SECRET) {
        console.error("Error: SESS_SECRET is not set in the .env file.");
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

    
    await cluster.task(summarizeArticleTask);
    console.log("Cluster started or starting...");
    console.log('[Server] ✅ Puppeteer cluster successfully started.');

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

    // Middleware to check if user is authenticated
    const isAuthenticated = (req, res, next) => {
        if (req.session.userId) {
            next();
        } else {
            res.status(401).json({ error: 'Unauthorized' });
        }
    };

    const parser = new Parser();

    // Login route
    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        try {
            const user = await getUserByUsername(username);

            if (!user) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            const isValidPassword = await bcrypt.compare(password, user.password);

            if (!isValidPassword) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            req.session.userId = user.id;
            req.session.username = user.username;
            res.status(200).json({ message: 'Logged in successfully', username: user.username, userId: user.id });

        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ error: 'An error occurred during login' });
        }
    });

    // Logout route
    app.post('/api/logout', isAuthenticated, (req, res) => {
        req.session.destroy(err => {
            if (err) {
                return res.status(500).json({ error: 'Failed to log out' });
            }
            res.clearCookie('sid');
            res.status(200).json({ message: 'Logged out successfully' });
        });
    });

    // Get current user (check session)
    app.get('/api/user', (req, res) => {
        if (req.session.userId && req.session.username) {
            res.status(200).json({ userId: req.session.userId, username: req.session.username });
        } else {
            res.status(401).json({ error: 'Not authenticated' });
        }
    });
    
    async function extractRealUrl(googleRssUrl) {
        return retry(async () => {
            try {
                const response = await axios.get(googleRssUrl, { timeout: 15000 });
                const $ = cheerio.load(response.data);
                const data = $('c-wiz[data-p]').attr('data-p');
                if (!data) {
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
                console.error("Error extracting the real URL, retrying:", e.message);
                if (e.response) {
                    console.error(`Status: ${e.response.status}, Data: ${String(e.response.data).slice(0, 100)}...`);
                }
                throw e; 
            }
        }).catch(err => {
            console.error("Error extracting the real URL after multiple attempts:", err.message);
            return googleRssUrl;
        });
    }

    
    app.post('/api/register', async (req, res) => {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        try {
            const newUser = await createUser(username, password);
            res.status(201).json({ message: 'User created successfully', userId: newUser.id });
        } catch (error) {
            if (error.code === 'SQLITE_CONSTRAINT') {
                res.status(409).json({ error: 'Username already exists' });
            } else {
                res.status(500).json({ error: 'An error occurred during registration' });
            }
        }
    });

    
    app.get("/api/rss", isAuthenticated, async (req, res) => {
        try {
            const keyword = req.query.keyword?.trim();
            if (!keyword) return res.status(400).json({ error: "No search specified" });

            const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keyword)}&hl=de&gl=DE&ceid=DE:de`;
            const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (!response.ok) throw new Error("Could not load RSS feed");

            const xml = await response.text();
            const feed = await parser.parseString(xml);
            if (!feed.items?.length) return res.status(404).json({ error: "No articles found" });

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
            res.status(500).json({ error: err.message || "Error fetching the RSS feed" });
        }
    });

    
    app.post("/api/summarize", isAuthenticated, async (req, res) => {
        console.log("Summary endpoint called");
        try {
            const { articles, length } = req.body;
            if (!articles?.length) {
                return res.status(400).json({ error: "No articles provided" });
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
                    if (batch.indexOf(article) < batch.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
                await Promise.all(batchPromises);
            }

            const finalSummaries = successfulSummaries.slice(0, SUMMARY_TARGET);
            console.log(`Responding with ${finalSummaries.length} summaries.`);

            if (finalSummaries.length === 0 && failedArticles.length > 0) {
                return res.status(500).json({
                    error: "Could not summarize any articles.",
                    details: failedArticles,
                });
            }

            const originalOrder = articles.map(a => a.link);
            finalSummaries.sort((a, b) => originalOrder.indexOf(a.link) - originalOrder.indexOf(b.link));
            
            res.json(finalSummaries);

        } catch (err) {
            console.error(err);
            if (!res.headersSent) {
                res.status(500).json({ error: err.message || "Error with AI summary" });
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
        console.log(`✅ Server running on http://localhost:${PORT}`);
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