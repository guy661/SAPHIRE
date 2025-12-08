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
const { orchestrateChatTask, generateSearchQueriesTask, generateFollowUpAnswerTask, selectCategoriesTask, generateGeneralKeywordsTask } = require('./task.js');

const serverLogger = new Logger('Server', 'green', EMOJIS.server);

// Session configuration
const SESS_SECRET = process.env.SESS_SECRET || 'your-default-secret';
const IN_PROD = process.env.NODE_ENV === 'production';

async function main() {
    const queuesModule = await import('./queues.mjs');
    const { fetchAllQueue } = queuesModule.default;

    if (!fetchAllQueue) throw new Error('fetchAllQueue is undefined!');
    serverLogger.info('Queues initialized.');

    const { getApiKeyCount } = require('./utils.js');
    if (getApiKeyCount() === 0 || !process.env.SESS_SECRET) {
        serverLogger.error("Missing GEMINI_API_KEYS or SESS_SECRET in the .env file.");
        process.exit(1);
    }

    const app = express();
    app.use(cors({
        origin: ['http://localhost:3001', 'http://localhost:5173'],
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

    // --- AUTH ROUTES ---

    app.post('/api/register', async (req, res) => {
        const { username, password, language = 'de' } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }
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
            const user = await db.getUserByUsername(username);
            if (user && await bcrypt.compare(password, user.password)) {
                req.session.userId = user.id;
                req.session.language = user.language || 'de';
                serverLogger.info(`User logged in: ${username}`);
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
    
    const { startSearchJob } = require('./job-starter.js');
    const { getFeedCategories } = require('./rss-aggregator.js');
    const { EdgeTTS } = require('node-edge-tts'); // Correct import
    const fs = require('fs'); // Needs standard fs for streams

    // --- AUDIO API ---
    app.get('/api/audio-summary', isAuthenticated, async (req, res) => {
        const { jobId } = req.query;
        serverLogger.info(`Audio summary requested for user ${req.session.userId}. JobID: ${jobId || 'latest'}`);
        
        let textToSpeak = "Es konnten keine Nachrichten zum Vorlesen gefunden werden.";

        try {
            if (jobId) {
                const job = await db.getJob(jobId);
                if (job) {
                    const dashboard = await db.getDashboardById(job.dashboard_id);
                    if (dashboard && dashboard.user_id === req.session.userId) {
                        if (job.meta_summary) {
                            textToSpeak = `Hier ist Ihre Zusammenfassung: \n\n ${job.meta_summary}`;
                        } else {
                            textToSpeak = "Für diesen Auftrag wurde keine Zusammenfassung generiert.";
                        }
                    } else {
                        return res.status(403).json({ error: "Forbidden" });
                    }
                } else {
                    return res.status(404).json({ error: "Job not found" });
                }
            } else {
                // Fallback: Find the most recent dashboard/job
                const dashboards = await db.getDashboardsByUserId(req.session.userId);
                if (dashboards.length > 0) {
                    const latestDashboard = dashboards[0];
                    const lastJob = await db.getLatestCompletedJobForDashboard(latestDashboard.id);

                    if (lastJob && lastJob.meta_summary) {
                        textToSpeak = `Ihr persönliches Briefing für das Dashboard ${latestDashboard.name}: \n\n ${lastJob.meta_summary}`;
                    } else {
                        textToSpeak = `Für Ihr Dashboard "${latestDashboard.name}" wurde noch kein Nachrichten-Briefing erstellt.`;
                    }
                }
            }

            // Clean up markdown for speech (simple approach)
            const cleanText = textToSpeak
                .replace(/[*_#`]/g, '') // Remove markdown chars
                .replace(/https?:\/\/\S+/g, 'Link') // Replace URLs
                .replace(/\n\n/g, '. ') // Replace double newlines with pauses
                .substring(0, 4500); // Limit length for TTS safety

            const tempFilePath = path.join(__dirname, `tts-${randomUUID()}.mp3`);
            const tts = new EdgeTTS({ voice: 'de-DE-KatjaNeural' });
            
            await tts.ttsPromise(cleanText, tempFilePath);
            
            res.setHeader('Content-Type', 'audio/mpeg');
            
            const stream = fs.createReadStream(tempFilePath);
            stream.pipe(res);

            stream.on('close', () => {
                fs.unlink(tempFilePath, (err) => {
                    if (err) serverLogger.warn(`Failed to delete temp TTS file: ${tempFilePath}`);
                });
            });

        } catch (error) {
            serverLogger.error('TTS Generation Error:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to generate audio summary.' });
            }
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

    app.get('/api/dashboards/:id/jobs', isAuthenticated, async (req, res) => {
        const { id } = req.params;
        try {
            // First, verify the dashboard belongs to the user
            const dashboard = await db.getDashboardById(parseInt(id, 10));
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(404).json({ error: "Dashboard not found or access denied" });
            }
            // If authorized, fetch the jobs
            const jobs = await db.getJobsByDashboardId(id);
            res.json(jobs);
        } catch (error) {
            serverLogger.error(`Error fetching jobs for dashboard ${id}:`, error);
            res.status(500).json({ error: 'Failed to fetch jobs' });
        }
    });

    app.put('/api/dashboards/:id', isAuthenticated, async (req, res) => {
        const { id } = req.params;
        const { name, interval_minutes, summary_style, is_active } = req.body;
        try {
            const dashboard = await db.getDashboardById(id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }
            const updatedDashboard = await db.updateDashboardSettings(id, { name, interval_minutes, summary_style, is_active });
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
        let { rss_categories = [] } = req.body; 

        try {
            const dashboard = await db.getDashboardById(parseInt(id, 10));
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }

            // Prioritize saved categories from DB to ensure personalization is respected
            // The frontend often sends a default "all" list if not explicitly handled
            if (dashboard.selected_categories && dashboard.selected_categories.length > 0) {
                rss_categories = dashboard.selected_categories;
                serverLogger.info(`Using saved categories from DB: ${rss_categories.join(', ')}`);
            } else if (rss_categories.length === 0) {
                serverLogger.info(`No categories provided or saved. Defaulting to ALL.`);
            }

            const jobId = await startSearchJob(parseInt(id, 10), req.session.userId, rss_categories);
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
                
                // --- NEW: AI Category Selection ---
                try {
                    const allCategories = await getFeedCategories();
                    const selectedCategoryKeys = await selectCategoriesTask({
                        data: {
                            user_intent: result.data.user_intent,
                            categories: allCategories,
                            language: req.session.language || 'de'
                        }
                    });

                    if (selectedCategoryKeys && selectedCategoryKeys.length > 0) {
                        await db.updateDashboardCategories(dashboardId, selectedCategoryKeys);
                        serverLogger.info(`AI selected categories for dashboard ${dashboardId}: ${selectedCategoryKeys.join(', ')}`);
                    } else {
                        serverLogger.warn(`AI selected NO categories for dashboard ${dashboardId}. Defaulting to none (or all/logic dependent).`);
                    }

                    // --- NEW: AI Keyword Generation for Pre-filtering ---
                    const keywords = await generateGeneralKeywordsTask({
                        data: {
                            user_intent: result.data.user_intent,
                            language: req.session.language || 'de'
                        }
                    });
                    
                    if (keywords && keywords.length > 0) {
                        await db.updateDashboardSearchTerms(dashboardId, keywords);
                        serverLogger.info(`AI generated search terms for dashboard ${dashboardId}: ${keywords.join(', ')}`);
                    } else {
                        serverLogger.warn(`AI generated NO search terms for dashboard ${dashboardId}.`);
                    }
                    // ----------------------------------------------------

                } catch (catError) {
                    serverLogger.error('Error during AI category/keyword selection:', catError);
                    // Non-critical: proceed without crashing, user just gets default behavior
                }
                // ----------------------------------

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
            if (!job) return res.status(404).json({ status: 'not_found' });
            
            // Authorization Check
            const dashboard = await db.getDashboardById(job.dashboard_id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }

            // The new synthesis worker handles all processing, so we just return the job from the DB.
            res.json({ status: job.status, summary: job.meta_summary });

        } catch (err) {
            serverLogger.error(`Error fetching results for job ${id}:`, err);
            res.status(500).json({ error: "Error fetching job results" });
        }
    });

    app.get("/api/jobs/:jobId/clusters", isAuthenticated, async (req, res) => {
        const { jobId } = req.params;
        const { userId } = req.session; // Get userId from session
        try {
            // Authorization Check: Ensure the job belongs to the logged-in user.
            const job = await db.getJob(jobId);
            if (!job) return res.status(404).json({ error: "Job not found" });

            const dashboard = await db.getDashboardById(job.dashboard_id);
            if (!dashboard || dashboard.user_id !== userId) {
                return res.status(403).json({ error: "Forbidden" });
            }

            // Fetch the clustered articles for the job, now with user feedback
            const clusters = await db.getClustersByJobId(jobId, userId);
            res.json(clusters);

        } catch (err) {
            serverLogger.error(`Error fetching clusters for job ${jobId}:`, err);
            res.status(500).json({ error: "Error fetching cluster results" });
        }
    });

    app.post("/api/jobs/:jobId/chat", isAuthenticated, async (req, res) => {
        const { jobId } = req.params;
        const { message, chatHistory, summary } = req.body;

        try {
            // Authorization: Check if the job belongs to the user
            const job = await db.getJob(jobId);
            if (!job) return res.status(404).json({ error: "Job not found" });

            const dashboard = await db.getDashboardById(job.dashboard_id);
            if (!dashboard || dashboard.user_id !== req.session.userId) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const answer = await generateFollowUpAnswerTask({
                data: {
                    question: message,
                    chatHistory: chatHistory || [],
                    summary: summary,
                    language: req.session.language || 'de'
                }
            });

            res.json({ answer });

        } catch (error) {
            serverLogger.error(`Error in chat for job ${jobId}:`, error);
            res.status(500).json({ error: 'Failed to get answer from AI' });
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
            res.status(500).json({ error: 'Failed to fetch RSS categories' });
        }
    });

    app.post('/api/feedback', isAuthenticated, async (req, res) => {
        const { clusterId, feedbackType } = req.body;
        const userId = req.session.userId;

        if (!clusterId) {
            return res.status(400).json({ error: 'clusterId is required.' });
        }

        try {
            if (feedbackType === 'like' || feedbackType === 'dislike') {
                // Upsert logic
                const feedback = await db.addUserFeedback(userId, clusterId, feedbackType);
                res.status(201).json(feedback);
            } else {
                // Deletion logic for null or other values
                await db.deleteUserFeedback(userId, clusterId);
                res.status(204).send(); // 204 No Content is appropriate for successful deletion
            }
        } catch (error) {
            serverLogger.error(`Error processing feedback for user ${userId} on cluster ${clusterId}:`, error);
            res.status(500).json({ error: 'Failed to process feedback.' });
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