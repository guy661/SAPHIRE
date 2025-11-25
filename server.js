require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const path = require('path');
const fetch = require('node-fetch');
const db = require('./database-postgres.js');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');
const { Logger, EMOJIS } = require('./utils.js');
const { interrogateTopicTask } = require('./task.js');

const serverLogger = new Logger('Server', 'green', EMOJIS.server);
const dbLogger = new Logger('Database', 'cyan', EMOJIS.db);

// Session configuration
const SESS_SECRET = process.env.SESS_SECRET || 'your-default-secret';
const IN_PROD = process.env.NODE_ENV === 'production';

async function main() {
    const queuesModule = await import('./queues.mjs');
    const fetchQueue = queuesModule.default.fetchQueue;

    if (!fetchQueue) throw new Error('fetchQueue is undefined!');
    serverLogger.info('Queues initialized.');

    const { getApiKeyCount } = require('./utils.js');
    if (getApiKeyCount() === 0 || !process.env.SESS_SECRET) {
        serverLogger.error("Missing GEMINI_API_KEYS or SESS_SECRET in the .env file.");
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

    const parser = new Parser();

    const isAuthenticated = (req, res, next) => {
        if (req.session.userId) {
            next();
        } else {
            res.status(401).json({ error: 'Unauthorized' });
        }
    };
    
    async function startSearchJob(topic, userId, summaryStyle) {
        const broadQuery = topic.main_topic;
        serverLogger.info(`Performing search for: "${broadQuery}"`);
        const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(broadQuery)}&hl=de&gl=DE&ceid=DE:de`;
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
        if (!response.ok) throw new Error("Could not load RSS feed for search");

        const xml = await response.text();
        const feed = await parser.parseString(xml);
        const articlesToCheck = feed.items.slice(0, 20);
        serverLogger.info(`Found ${articlesToCheck.length} articles.`);

        if (articlesToCheck.length === 0) {
            return null;
        }

        const jobId = randomUUID();
        await db.createJob(jobId, userId, 'processing', summaryStyle);

        for (const article of articlesToCheck) {
            const jobArticle = await db.createJobArticle(jobId, article);
            await fetchQueue.add('fetch', {
                articleId: jobArticle.id,
                url: jobArticle.link,
                userId: userId
            });
        }

        serverLogger.info(`Job ${jobId} created. Queued ${articlesToCheck.length} articles.`);
        return jobId;
    }

    // AUTHENTICATION ROUTES
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
            serverLogger.info(`User ${username} logged in successfully.`);
            res.status(200).json({ message: 'Logged in successfully', username: user.username, userId: user.id });
        } catch (error) {
            serverLogger.error('Login error:', error);
            res.status(500).json({ error: 'An error occurred during login' });
        }
    });

    app.post('/api/logout', isAuthenticated, (req, res) => {
        req.session.destroy(err => {
            if (err) {
                serverLogger.error('Logout error:', err);
                return res.status(500).json({ error: 'Failed to log out' });
            }
            res.clearCookie('sid');
            res.status(200).json({ message: 'Logged out successfully' });
        });
    });

    app.post('/api/register', async (req, res) => {
        const { username, password, language } = req.body;
        if (!username || !password || !language) return res.status(400).json({ error: 'Username, password, and language are required' });
        try {
            const newUser = await db.createUser(username, password, language);
            req.session.userId = newUser.id;
            req.session.username = newUser.username;
            req.session.language = newUser.language;
            serverLogger.info(`New user registered: ${username}`);
            res.status(201).json({ message: 'User created successfully', userId: newUser.id, username: newUser.username, language: newUser.language });
        } catch (error) {
            if (error.code === '23505') {
                res.status(409).json({ error: 'Username already exists' });
            } else {
                serverLogger.error('Registration error:', error);
                res.status(500).json({ error: 'An error occurred during registration' });
            }
        }
    });

    app.get('/api/user', (req, res) => {
        if (req.session.userId && req.session.username) {
            res.status(200).json({ userId: req.session.userId, username: req.session.username, language: req.session.language });
        } else {
            res.status(401).json({ error: 'Not authenticated' });
        }
    });

    // TOPIC, SEARCH & INTERROGATION ROUTES
    app.post("/api/rss", isAuthenticated, async (req, res) => {
        serverLogger.info(`/api/rss POST route started for user ${req.session.userId}`);
        const { summaryStyle } = req.body;

        try {
            const userTopic = await db.getTopicByUserId(req.session.userId);
            if (!userTopic || !userTopic.main_topic) {
                return res.status(400).json({ error: "No search topic specified. Please set a topic in your personalization settings." });
            }
            
            const jobId = await startSearchJob(userTopic, req.session.userId, summaryStyle);
            if (!jobId) {
                return res.status(200).json({ jobId: null, message: "No articles found for your topic." });
            }
            res.status(202).json({ jobId });

        } catch (err) {
            serverLogger.error('Error in /api/rss:', err);
            res.status(500).json({ error: err.message || "Error during article search" });
        }
    });
    
    app.post('/api/interrogate', isAuthenticated, async (req, res) => {
        const userTopic = req.body;
        if (!userTopic || !userTopic.main_topic) {
            return res.status(400).json({ error: "A full topic object is required" });
        }
        try {
            const result = await interrogateTopicTask({ data: { userTopic, language: req.session.language || 'de' } });
            res.status(200).json(result);
        } catch (error) {
            serverLogger.error('Error in /api/interrogate:', error);
            res.status(500).json({ error: 'Failed to get AI feedback.' });
        }
    });

    // JOB & TOPIC MANAGEMENT
    app.get("/api/job/:id", isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            const job = await db.getJob(id);
            if (!job) {
                return res.status(200).json({ status: 'pending', articles: [] });
            }
            if (job.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }
            const allArticles = await db.getJobArticles(id);
            const completedArticles = allArticles.filter(a => a.status === 'completed');
            
            let currentJobStatus = job.status;
            const hasUnfinishedArticles = allArticles.some(a => a.status === 'pending' || a.status === 'processing');

            if (!hasUnfinishedArticles && allArticles.length > 0) {
                currentJobStatus = 'completed';
                if (job.status === 'processing') {
                    await db.updateJobStatus(id, 'completed');
                }
            } else if (allArticles.length === 0 && job.status === 'processing') {
                 currentJobStatus = 'completed';
                 await db.updateJobStatus(id, 'completed');
            }
            
            res.json({ status: currentJobStatus, articles: completedArticles });
        } catch (err) {
            serverLogger.error(`Error fetching results for job ${id}:`, err);
            res.status(500).json({ error: "Error fetching job results" });
        }
    });

    app.get('/api/topics', isAuthenticated, async (req, res) => {
        try {
            const topic = await db.getTopicByUserId(req.session.userId);
            res.json(topic || {});
        } catch (error) {
            serverLogger.error('Error fetching topic:', error);
            res.status(500).json({ error: 'Failed to fetch topic' });
        }
    });

    app.post('/api/topics', isAuthenticated, async (req, res) => {
        const { main_topic, include_keywords, exclude_keywords } = req.body;
        if (!main_topic) return res.status(400).json({ error: 'Main topic is required' });
        try {
            await db.upsertTopic(req.session.userId, { main_topic, include_keywords: include_keywords || '', exclude_keywords: exclude_keywords || '' });
            res.status(200).json({ message: 'Topic saved successfully' });
        } catch (error) {
            serverLogger.error('Error saving topic:', error);
            res.status(500).json({ error: 'Failed to save topic' });
        }
    });
    
    // PAGE SERVING & STATIC FILES
    app.get('/', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'saphire.html'));
    });

    app.get('/personalization', (req, res) => {
        res.set('Cache-control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'personalization.html'));
    });
    
    app.use(express.static(path.join(__dirname, 'public')));
    
    // SERVER STARTUP
    const PORT = 3001;
    app.listen(PORT, () => {
        serverLogger.info(`Server running on http://localhost:${PORT}`);
    });
}

main().catch(err => {
    serverLogger.error('Unhandled error during startup:', err);
    process.exit(1);
});
