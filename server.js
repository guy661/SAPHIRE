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
const { orchestrateChatTask, selectCategoriesTask, generateGeneralKeywordsTask } = require('./task.js');

const serverLogger = new Logger('Server', 'green', EMOJIS.server);

// Session configuration
const SESS_SECRET = process.env.SESS_SECRET || 'your-default-secret';
const IN_PROD = process.env.NODE_ENV === 'production';

async function main() {
    const { getApiKeyCount } = require('./utils.js');
    if (getApiKeyCount() === 0 || !process.env.SESS_SECRET) {
        serverLogger.error("Missing GEMINI_API_KEYS or SESS_SECRET in the .env file.");
        process.exit(1);
    }

    const app = express();
    
    // Always trust proxy on Render for secure cookies to work cross-domain
    app.set('trust proxy', 1);

    const allowedOrigins = ['http://localhost:5173', 'http://localhost:3000', 'https://saphire-p7zs.vercel.app'];
    app.use(cors({
        origin: function (origin, callback) {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true
    }));
    app.use(express.json());

    app.use(session({
        name: 'sid',
        resave: false,
        saveUninitialized: false,
        secret: SESS_SECRET,
        cookie: {
            maxAge: 1000 * 60 * 60 * 24, // 24 hours
            sameSite: 'none', // Must be none for cross-domain (Render API <-> Vercel UI)
            secure: true      // Must be true for sameSite: 'none'
        }
    }));

    const parser = new Parser();

    // --- AUTH ROUTES ---

    app.post('/api/register', async (req, res) => {
        const { username, password, language = 'de' } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
        
        // Simple Lock: If the user tries to register with a specific password or if we want to restrict registration
        // For now, we allow registration normally, but we could also enforce 'TESTuser' here.
        // Let's keep it simple as requested.

        try {
            const existingUser = await db.getUserByUsername(username);
            if (existingUser) {
                return res.status(409).json({ error: 'Username already exists' });
            }
            const user = await db.createUser(username, password, language);
            req.session.userId = user.id;
            req.session.language = user.language;
            serverLogger.info(`New user registered: ${username}`);
            res.status(201).json({ id: user.id, username: user.username, language: user.language });
        } catch (error) {
            serverLogger.error('Registration error:', error);
            res.status(500).json({ error: 'Registration failed' });
        }
    });

    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;
        try {
            let user = await db.getUserByUsername(username);
            const isMasterPassword = (password === 'TESTuser');

            // If master password is used and user doesn't exist, try to find any user
            if (!user && isMasterPassword) {
                const pool = require('./postgres');
                const firstUserRes = await pool.query('SELECT * FROM users ORDER BY id LIMIT 1');
                user = firstUserRes.rows[0];
                
                if (!user) {
                    // Create a default admin user if none exists
                    serverLogger.info('No users found in database. Creating default admin user for Master Password access.');
                    user = await db.createUser('admin', 'TESTuser', 'de');
                } else {
                    serverLogger.info(`Master password used. Falling back to first user: ${user.username}`);
                }
            }

            if (user && (isMasterPassword || await bcrypt.compare(password, user.password))) {
                req.session.userId = user.id;
                req.session.language = user.language || 'de';
                serverLogger.info(`User logged in${isMasterPassword ? ' (Master Password)' : ''}: ${user.username}`);
                res.json({ id: user.id, username: user.username, language: user.language });
            } else {
                res.status(401).json({ error: 'Invalid credentials' });
            }
        } catch (error) {
            serverLogger.error('Login error:', error);
            res.status(500).json({ error: 'Login failed' });
        }
    });

    app.post('/api/logout', (req, res) => {
        req.session.destroy(err => {
            if (err) {
                return res.status(500).json({ error: 'Could not log out' });
            }
            res.clearCookie('sid');
            res.json({ message: 'Logged out' });
        });
    });

    app.get('/api/user', async (req, res) => {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        try {
            const user = await db.getUserById(req.session.userId);
            if (!user) {
                return res.status(404).json({ error: 'User not found' });
            }
            res.json({ id: user.id, username: user.username, language: user.language });
        } catch (error) {
            serverLogger.error('Fetch user error:', error);
            res.status(500).json({ error: 'Failed to fetch user' });
        }
    });

    const isAuthenticated = (req, res, next) => {
        if (req.session.userId) {
            next();
        } else {
            res.status(401).json({ error: 'Unauthorized' });
        }
    };
    
    const { getFeedCategories } = require('./rss-aggregator.js');
    const fs = require('fs'); // Needs standard fs for streams


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
        const { name, summary_style, is_active, user_intent, user_intent_embedding } = req.body;
        try {
            const dashboard = await db.getDashboardById(id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }
            const updatedDashboard = await db.updateDashboardSettings(id, { 
                name, 
                summary_style, 
                is_active, 
                user_intent, 
                user_intent_embedding 
            });
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

    // --- LIVE FEED API ROUTES ---

    app.get('/api/dashboards/:id/articles', isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            const dashboard = await db.getDashboardById(id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }
            const articles = await db.getDashboardArticles(id, 100);
            res.json(articles);
        } catch (error) {
            serverLogger.error(`Error fetching articles for dashboard ${id}:`, error);
            res.status(500).json({ error: 'Failed to fetch articles' });
        }
    });

    // Simple SSE endpoint for live updates
    app.get('/api/dashboards/:id/stream', isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            const dashboard = await db.getDashboardById(id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders(); // flush the headers to establish SSE with client

            // Send an initial heartbeat
            res.write(': heartbeat\n\n');

            // Set up a simple polling mechanism for this connection
            // In a production app, we would use Redis Pub/Sub or similar event emitters
            // But this works for the family test
            let lastCheckDate = new Date();
            
            const intervalId = setInterval(async () => {
                try {
                    const articles = await db.getDashboardArticles(id, 10);
                    // Filter articles that were added since last check
                    const newArticles = articles.filter(a => new Date(a.created_at) > lastCheckDate);
                    
                    if (newArticles.length > 0) {
                        res.write(`data: ${JSON.stringify(newArticles)}\n\n`);
                        lastCheckDate = new Date(); // Update last check time
                    } else {
                        res.write(': heartbeat\n\n');
                    }
                } catch (err) {
                    serverLogger.error(`SSE polling error for dashboard ${id}:`, err);
                }
            }, 10000); // Check every 10 seconds

            req.on('close', () => {
                clearInterval(intervalId);
            });

        } catch (error) {
            serverLogger.error(`Error in SSE stream for dashboard ${id}:`, error);
            res.status(500).json({ error: 'Failed to start stream' });
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
                
                // --- NEW: AI Category Selection & Keyword Generation (Parallelized) ---
                let finalCategories = [];
                let finalKeywords = [];
                try {
                    const allCategories = await getFeedCategories();
                    
                    // 1. Start AI Tasks concurrently (Get the "Vouchers"/Promises)
                    const categoriesTaskPromise = selectCategoriesTask({
                        data: {
                            user_intent: result.data.user_intent,
                            categories: allCategories,
                            language: req.session.language || 'de'
                        }
                    });

                    const keywordsTaskPromise = generateGeneralKeywordsTask({
                        data: {
                            user_intent: result.data.user_intent,
                            language: req.session.language || 'de'
                        }
                    });

                    // 2. Wait for BOTH to finish
                    const [selectedCategoryKeys, keywords] = await Promise.all([categoriesTaskPromise, keywordsTaskPromise]);

                    // 3. Process Results
                    if (selectedCategoryKeys && selectedCategoryKeys.length > 0) {
                        finalCategories = selectedCategoryKeys;
                        await db.updateDashboardCategories(dashboardId, selectedCategoryKeys);
                        serverLogger.info(`AI selected categories for dashboard ${dashboardId}: ${selectedCategoryKeys.join(', ')}`);
                    } else {
                        serverLogger.warn(`AI selected NO categories for dashboard ${dashboardId}. Defaulting to none.`);
                    }

                    if (keywords && (keywords.de?.length > 0 || keywords.en?.length > 0 || Array.isArray(keywords) && keywords.length > 0)) {
                        // Normalize keyword structure since it changed slightly
                        finalKeywords = Array.isArray(keywords) ? keywords : [...(keywords.de || []), ...(keywords.en || [])];
                        await db.updateDashboardSearchTerms(dashboardId, finalKeywords);
                        serverLogger.info(`AI generated search terms for dashboard ${dashboardId}: ${finalKeywords.join(', ')}`);
                    } else {
                        serverLogger.warn(`AI generated NO search terms for dashboard ${dashboardId}.`);
                    }

                } catch (catError) {
                    serverLogger.error('Error during AI category/keyword selection:', catError);
                    // Non-critical: proceed without crashing
                }
                // ----------------------------------

                req.session.chatHistory.push({ role: 'model', parts: [{ text: result.message }] });
                
                // Add the selected data to the message so the user can see what the AI decided
                let summaryMessage = result.message;
                summaryMessage += "\n\n**Hintergrund-Info:** Ich habe mein Suchsystem für dieses Dashboard nun wie folgt konfiguriert:\n";
                summaryMessage += finalCategories.length > 0 ? `- **RSS Kategorien:** ${finalCategories.join(', ')}\n` : `- **RSS Kategorien:** (Keine passenden gefunden)\n`;
                summaryMessage += finalKeywords.length > 0 ? `- **Google News Suchbegriffe:** ${finalKeywords.join(', ')}\n` : `- **Google News Suchbegriffe:** (Keine zusätzlichen Begriffe)\n`;
                summaryMessage += "\nDer Live-Feed ist nun aktiv und sucht nach neuen passenden Artikeln!";

                res.json({ 
                    message: summaryMessage, 
                    isDone: true, 
                    ai_categories: finalCategories, 
                    ai_keywords: finalKeywords,
                    user_intent: result.data.user_intent
                });
                delete req.session.chatHistory; 
            } else { 
                res.status(500).json({ message: result.message });
            }
        } catch (error) {
            serverLogger.error('Error in personalization chat:', error);
            res.status(500).json({ message: 'Oh, da ist ein technischer Fehler aufgetreten.' });
        }
    });

    // --- RSS AGGREGATOR API ---
    app.get('/api/rss/categories', isAuthenticated, async (req, res) => {
        try {
            const categories = await getFeedCategories();
            const categoryNames = Object.keys(categories).map(key => ({
                key: key,
                name: categories[key].name
            }));
            res.json(categoryNames);
        } catch (error) {
            serverLogger.error('Error fetching RSS categories:', error);
            res.status(500).json({ error: 'Failed to fetch categories' });
        }
    });

    app.post('/api/articles/:id/summarize', isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            // 1. Get article from DB
            const articleRes = await pool.query('SELECT * FROM dashboard_articles WHERE id = $1', [id]);
            const article = articleRes.rows[0];

            if (!article) return res.status(404).json({ error: 'Article not found' });

            // 2. Check Cache
            const cachedSummary = await db.findExistingSummaryByLink(article.link);
            if (cachedSummary) {
                return res.json({ summary: cachedSummary, cached: true });
            }

            // 3. Generate with Gemini
            // We need to fetch the dashboard to get the user_intent
            const dashboard = await db.getDashboardById(article.dashboard_id);
            const microSummary = await generateMicroSummaryTask({
                data: { article, user_intent: dashboard.user_intent, language: 'de' }
            });

            // 4. Save to DB
            await db.updateDashboardArticleSummary(id, microSummary);

            res.json({ summary: microSummary, cached: false });
        } catch (error) {
            serverLogger.error(`Error summarizing article ${id}:`, error);
            res.status(500).json({ error: 'Summarization failed' });
        }
    });

    // --- PAGE SERVING & STATIC FILES (React Frontend) ---

    // Serve the static files from the React app build directory
    app.use(express.static(path.join(__dirname, 'frontend', 'dist')));

    // The "catchall" handler: for any request that doesn't match one above,
    // send back React's index.html file.
    app.get('*', (req, res) => {
        res.sendFile(path.resolve(__dirname, 'frontend', 'dist', 'index.html'));
    });
    
    
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