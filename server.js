require('dotenv').config();


const express = require('express'); 
const cors = require('cors'); 
const Parser = require('rss-parser');
const path = require('path');
const fetch = require('node-fetch');
const db = require('./database.js');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');


// Session configuration
const SESS_SECRET = process.env.SESS_SECRET || 'your-default-secret';
const IN_PROD = process.env.NODE_ENV === 'production';

async function main() {
    await db.init();

    const { fetchQueue } = await import('./queues.mjs');
    console.log('fetchQueue:', fetchQueue); // darf nicht undefined sein

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
            const user = await db.getUserByUsername(username);
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
    
    app.post('/api/dev-login', async (req, res) => {
        try {
            let user = await db.getUserByUsername('test');
            if (!user) {
                user = await db.createUser('test', 'test');
            }
            req.session.userId = user.id;
            req.session.username = user.username;
            res.status(200).json({ message: 'Logged in successfully', username: user.username, userId: user.id });
        } catch (error) {
            console.error('Dev login error:', error);
            res.status(500).json({ error: 'An error occurred during dev login' });
        }
    });

    app.post('/api/register', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
        try {
            const newUser = await db.createUser(username, password);
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
        console.log(`[Server] /api/rss route started for user ${req.session.userId}`);
        try {
            const userTopic = await db.getTopicByUserId(req.session.userId);
            if (!userTopic || !userTopic.main_topic) {
                return res.status(400).json({ error: "No search topic specified. Please set a topic in your personalization settings." });
            }

            // Step 1: Broad search for article links
            const broadQuery = userTopic.main_topic;
            console.log(`[Search] Performing broad search for: "${broadQuery}"`);
            const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(broadQuery)}&hl=de&gl=DE&ceid=DE:de`;
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 15000); // 15 seconds timeout
            const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal }).finally(() => clearTimeout(id));
            if (!response.ok) throw new Error("Could not load RSS feed for broad search");
            
            const xml = await response.text();
            const feed = await parser.parseString(xml);
            const articlesToCheck = feed.items.slice(0, 20); // Limit to 20 articles
            console.log(`[Search] Found ${articlesToCheck.length} articles.`);

            if (articlesToCheck.length === 0) {
                return res.status(200).json({ jobId: null, message: "No articles found for your topic." });
            }

            // Step 2: Create a job and article records in the database
            const jobId = randomUUID();
            await db.createJob(jobId, req.session.userId, 'processing');
            
            // Step 3: Dispatch a fetch job for each article
            for (const article of articlesToCheck) {
                const jobArticle = await db.createJobArticle(jobId, article);
                await fetchQueue.add('fetch', {
                    articleId: jobArticle.id,
                    url: jobArticle.link,
                    userId: req.session.userId
                });
            }

            console.log(`[Job] Created job ${jobId} with ${articlesToCheck.length} articles to process.`);
            res.status(202).json({ jobId });

        } catch (err) {
            console.error('[Search] Error in /api/rss:', err);
            res.status(500).json({ error: err.message || "Error during article search" });
        }
    });

    app.get("/api/job/:id", isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            const job = await db.getJob(id);
            if (!job) {
                return res.status(404).json({ error: "Job not found" });
            }
            // Optional: Check if job belongs to the authenticated user
            if (job.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const articles = await db.getJobArticles(id);
            res.json({ status: job.status, articles: articles });

        } catch (err) {
            console.error(`[Results] Error fetching results for job ${id}:`, err);
            res.status(500).json({ error: "Error fetching job results" });
        }
    });

    app.get('/api/topics', isAuthenticated, async (req, res) => {
        try {
            const topic = await db.getTopicByUserId(req.session.userId);
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
            await db.upsertTopic(req.session.userId, {
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
    
    app.post('/api/clear-database', async (req, res) => {
        try {
            await db.clearDatabase();
            res.status(200).json({ message: 'Database cleared successfully' });
        } catch (error) {
            console.error('Error clearing database:', error);
            res.status(500).json({ error: 'An error occurred while clearing the database' });
        }
    });

    app.get('/', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'AI-Projekt.html'));
    });

    app.get('/personalization', (req, res) => {
        res.set('Cache-control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'personalization.html'));
    });
    
    app.use(express.static(path.join(__dirname, 'public')));

    const PORT = 3001;
    app.listen(PORT, () => {
        console.log(`✅ Server running on http://localhost:${PORT}`);
        console.log("Server is now listening for requests.");
    });
}

main().catch(err => {
    console.error('[Server] ❌ Unhandled error during startup:', err);
    process.exit(1);
});
