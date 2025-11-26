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
const { orchestrateChatTask, generateSearchQueriesTask, generateMetaSummaryTask } = require('./task.js');

const serverLogger = new Logger('Server', 'green', EMOJIS.server);

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
        saveUninitialized: true,
        secret: SESS_SECRET,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24, // 24 hours
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
    
    async function startSearchJob(dashboardId, userId) {
        const dashboard = await db.getDashboardById(dashboardId);
        if (!dashboard || dashboard.user_id !== userId) {
            throw new Error("Dashboard not found or access denied.");
        }
        if (!dashboard.user_intent) {
            throw new Error("Dashboard has no user intent defined yet.");
        }

        serverLogger.info(`Starting search job for dashboard ${dashboardId}: "${dashboard.name}"`);
        const user = await db.getUserById(userId);

        serverLogger.info('Generating smart search queries from user intent...');
        const searchQueries = await generateSearchQueriesTask({ data: { user_intent: dashboard.user_intent, language: user.language || 'de' }});
        serverLogger.info(`Generated queries: [${searchQueries.join(', ')}]`);

        const allArticles = new Map();
        for (const query of searchQueries) {
            serverLogger.info(`Performing search for: "${query}"`);
            const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${user.language}&gl=DE&ceid=DE:${user.language}`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            try {
                const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
                if (!response.ok) {
                    serverLogger.warn(`Could not load RSS feed for query "${query}". Status: ${response.status}`);
                    continue;
                }

                const xml = await response.text();
                const feed = await parser.parseString(xml);
                
                feed.items.slice(0, 10).forEach(article => { // Get top 10 from each query
                    if (!allArticles.has(article.link)) {
                        allArticles.set(article.link, article);
                    }
                });
            } catch (err) {
                 serverLogger.warn(`Failed to fetch or parse feed for query "${query}": ${err.message}`);
            }
        }
        
        const articlesToCheck = Array.from(allArticles.values());
        serverLogger.info(`Found a total of ${articlesToCheck.length} unique articles.`);

        if (articlesToCheck.length === 0) {
            return null;
        }

        const jobId = randomUUID();
        await db.createJob(jobId, dashboardId, 'processing');

        for (const article of articlesToCheck) {
            const jobArticle = await db.createJobArticle(jobId, article);
            await fetchQueue.add('fetch', {
                articleId: jobArticle.id,
                url: jobArticle.link,
                dashboardId: dashboardId
            });
        }

        serverLogger.info(`Job ${jobId} created. Queued ${articlesToCheck.length} articles for dashboard ${dashboardId}.`);
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

    // --- DASHBOARD CRUD API ---
    app.get('/api/dashboards', isAuthenticated, async (req, res) => {
        try {
            const dashboards = await db.getDashboardsByUserId(req.session.userId);
            res.json(dashboards);
        } catch (error) {
            serverLogger.error(`Error fetching dashboards for user ${req.session.userId}:`, error);
            res.status(500).json({ error: 'Failed to fetch dashboards' });
        }
    });

    app.post('/api/dashboards', isAuthenticated, async (req, res) => {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Dashboard name is required' });
        try {
            const newDashboard = await db.createDashboard(req.session.userId, name);
            res.status(201).json(newDashboard);
        } catch (error) {
            serverLogger.error(`Error creating dashboard for user ${req.session.userId}:`, error);
            res.status(500).json({ error: 'Failed to create dashboard' });
        }
    });

    app.get('/api/dashboards/:id', isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            const dashboard = await db.getDashboardById(parseInt(id, 10));
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(404).json({ error: "Dashboard not found or access denied" });
            }
            res.json(dashboard);
        } catch (error) {
            serverLogger.error(`Error fetching dashboard ${id} for user ${req.session.userId}:`, error);
            res.status(500).json({ error: 'Failed to fetch dashboard' });
        }
    });

    app.put('/api/dashboards/:id', isAuthenticated, async (req, res) => {
        const { id } = req.params;
        const { name, interval_minutes, summary_style } = req.body;
        try {
            const dashboard = await db.getDashboardById(id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }
            const updatedDashboard = await db.updateDashboardSettings(id, { name, interval_minutes, summary_style });
            res.json(updatedDashboard);
        } catch (error) {
            serverLogger.error(`Error updating dashboard ${id}:`, error);
            res.status(500).json({ error: 'Failed to update dashboard' });
        }
    });

    app.delete('/api/dashboards/:id', isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            const dashboard = await db.getDashboardById(id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }
            await db.deleteDashboard(id);
            res.status(204).send();
        } catch (error) {
            serverLogger.error(`Error deleting dashboard ${id}:`, error);
            res.status(500).json({ error: 'Failed to delete dashboard' });
        }
    });

    // --- CORE API ROUTES (Refactored) ---

    app.post("/api/dashboards/:id/run-search", isAuthenticated, async (req, res) => {
        const { id } = req.params;
        serverLogger.info(`/api/dashboards/${id}/run-search POST route started for user ${req.session.userId}`);
        
        try {
            const jobId = await startSearchJob(parseInt(id, 10), req.session.userId);
            if (!jobId) {
                return res.status(200).json({ jobId: null, message: "No articles found for this dashboard's topic." });
            }
            res.status(202).json({ jobId });

        } catch (err) {
            serverLogger.error('Error in /api/dashboards/:id/run-search:', err);
            res.status(500).json({ error: err.message || "Error during article search" });
        }
    });
    
    app.post('/api/dashboards/:id/personalization-chat', isAuthenticated, async (req, res) => {
        const { id: dashboardId } = req.params;
        const userMessage = req.body.message;

         // Ensure dashboard belongs to user
        try {
            const dashboard = await db.getDashboardById(dashboardId);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }
        } catch (error) {
             return res.status(500).json({ message: 'Database error while checking dashboard ownership.' });
        }

         if (!req.session.chatHistory) {
            req.session.chatHistory = [];
        }

        if (userMessage) {
            req.session.chatHistory.push({ role: 'user', parts: [{ text: userMessage }] });
        }
        
        try {
            const result = await orchestrateChatTask({ 
                data: { 
                    chatHistory: req.session.chatHistory, 
                    language: req.session.language || 'de' 
                } 
            });

            if (result.action === 'reply') {
                req.session.chatHistory.push({ role: 'model', parts: [{ text: result.message }] });
                res.json({ message: result.message, suggestions: result.suggestions || [] });
            } else if (result.action === 'save') {
                await db.updateDashboardTopic(dashboardId, result.data.user_intent);
                req.session.chatHistory.push({ role: 'model', parts: [{ text: result.message }] });
                res.json({ message: result.message, isDone: true });
                delete req.session.chatHistory; 
            } else { 
                res.status(500).json({ message: result.message });
            }
        } catch (error) {
            serverLogger.error('Error in personalization chat:', error);
            res.status(500).json({ message: 'Oh, da ist ein technischer Fehler aufgetreten.' });
        }
    });

    app.get("/api/job/:id", isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            const job = await db.getJob(id);
            if (!job) return res.status(200).json({ status: 'pending', articles: [] });
            
            const dashboard = await db.getDashboardById(job.dashboard_id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const allArticles = await db.getJobArticles(id);
            const isProcessingComplete = !allArticles.some(a => ['pending', 'processing'].includes(a.status));

            // If processing is done, and we haven't generated a summary yet.
            if (isProcessingComplete && job.status === 'processing') {
                serverLogger.info(`Job ${id} finished processing articles. Generating meta summary...`);
                await db.updateJobStatus(id, 'generating_summary');
                job.status = 'generating_summary';

                const relevantArticles = allArticles.filter(a => a.is_relevant === true);
                serverLogger.info(`Found ${relevantArticles.length} relevant articles for summary.`);

                let summary = 'No relevant articles found to generate a summary.';
                if (relevantArticles.length > 0) {
                    const user = await db.getUserById(dashboard.user_id);
                    summary = await generateMetaSummaryTask({
                        data: {
                            articles: relevantArticles,
                            user_intent: dashboard.user_intent,
                            language: user.language || 'de'
                        }
                    });
                }
                
                await db.updateJobMetaSummary(id, summary);
                await db.updateJobStatus(id, 'completed');
                job.meta_summary = summary;
                job.status = 'completed';
            }

            const completedArticles = allArticles.filter(a => a.status === 'completed');
            res.json({ status: job.status, summary: job.meta_summary, articles: completedArticles });

        } catch (err) {
            serverLogger.error(`Error fetching results for job ${id}:`, err);
            await db.updateJobStatus(id, 'failed').catch(e => serverLogger.error('Failed to update job status on error:', e));
            res.status(500).json({ error: "Error fetching job results" });
        }
    });

    // --- PAGE SERVING & STATIC FILES ---
    app.get('/', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.sendFile(path.join(__dirname, 'public', 'saphire.html'));
    });

    // Adjusted to accept dashboard ID in the URL for context
    app.get('/personalization/:dashboardId', isAuthenticated, async (req, res) => {
        const { dashboardId } = req.params;
        try {
            const dashboard = await db.getDashboardById(dashboardId);
            if (dashboard && dashboard.user_id === req.session.userId) {
                res.set('Cache-control', 'no-store');
                res.sendFile(path.join(__dirname, 'public', 'personalization-chat.html'));
            } else {
                res.status(403).send('Forbidden or Not Found');
            }
        } catch (error) {
            res.status(500).send('Server Error');
        }
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