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
const { orchestrateChatTask, generateSearchQueriesTask, generateFollowUpAnswerTask } = require('./task.js');

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

    const isAuthenticated = (req, res, next) => {
        if (req.session.userId) {
            next();
        } else {
            res.status(401).json({ error: 'Unauthorized' });
        }
    };
    
    const { startSearchJob } = require('./job-starter.js');
    const { getFeedCategories } = require('./rss-aggregator.js');
    const { tts } = require('node-edge-tts');
    const { Readable } = require('stream');

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
    
    // --- AUDIO API ---
    app.get('/api/audio-summary', isAuthenticated, async (req, res) => {
        serverLogger.info(`Audio summary requested for user ${req.session.userId}`);
        
        let textToSpeak = "Es konnten keine Nachrichten zum Vorlesen gefunden werden. Bitte führen Sie zuerst eine Suche in einem Ihrer Dashboards durch.";

        try {
            // 1. Find the most recent dashboard for the user
            const dashboards = await db.getDashboardsByUserId(req.session.userId);
            if (dashboards.length > 0) {
                // For simplicity, we'll use the most recently created dashboard.
                const latestDashboard = dashboards[0];
                
                // 2. Find the last completed job for that dashboard
                const lastJob = await db.getLatestCompletedJobForDashboard(latestDashboard.id);

                if (lastJob && lastJob.meta_summary) {
                    // 3. Use its meta summary as the text
                    textToSpeak = `Ihr persönliches Briefing für das Dashboard ${latestDashboard.name}: \n\n ${lastJob.meta_summary}`;
                } else {
                    textToSpeak = `Für Ihr Dashboard "${latestDashboard.name}" wurde noch kein Nachrichten-Briefing erstellt.`;
                }
            }

            const audioStream = await tts(textToSpeak, { voice: 'de-DE-KatjaNeural' });
            
            res.setHeader('Content-Type', 'audio/mpeg');

            const readable = Readable.from(audioStream);
            readable.pipe(res);

        } catch (error) {
            serverLogger.error('TTS Generation Error:', error);
            res.status(500).json({ error: 'Failed to generate audio summary.' });
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
        const { rss_categories = [] } = req.body; // Expects an array of category keys

        // serverLogger.info(`/api/dashboards/${id}/run-search POST route started for user ${req.session.userId}`);
        
        try {
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