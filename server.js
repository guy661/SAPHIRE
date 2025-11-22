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
const { getContentTask, summarizeArticleTask, semanticCheckTask } = require('./task.js');
const { processInBatches } = require('./utils.js');
const db = require('./database.js');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { randomUUID } = require('crypto');

// Apply the StealthPlugin to Puppeteer
puppeteer.use(StealthPlugin());

// Session configuration
const SESS_SECRET = process.env.SESS_SECRET || 'your-default-secret';
const IN_PROD = process.env.NODE_ENV === 'production';

let cluster;
let isClusterReady = false;

async function initializeCluster() {
    try {
        console.log('[Server] Initializing Puppeteer cluster in the background...');
        cluster = await Cluster.launch({
            concurrency: Cluster.CONCURRENCY_CONTEXT,
            maxConcurrency: 2, // Lowered concurrency to reduce resource load during semantic check
            puppeteer: puppeteer,
            puppeteerOptions: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--log-level=3']
            },
            timeout: 180000 // Increased timeout for potentially long tasks
        });

                await cluster.task(async ({ page, data }) => {

                    // Set up the page

                    await page.setRequestInterception(true);

                    page.on('request', (req) => {

                        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {

                            req.abort();

                        } else {

                            req.continue();

                        }

                    });
        

                    page.on('pageerror', (err) => {

                        // In a real app, you might want to log these to a file instead of stdout

                        // console.log(`[PAGE ERROR] ${err.message}`);

                    });

                    

                    await page.setBypassCSP(true);

        

                    // Execute the actual task function passed in the data

                                return await data.taskFunction({ page, data: data.taskData });

                });

        

                isClusterReady = true;

                console.log('[Server] ✅ Puppeteer cluster successfully started.');

            } catch (err) {

                console.error('[Server] ❌ Critical error: Puppeteer cluster failed to launch.', err);

            }

        }
        

        async function main() {
            await db.init();
        

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

                    if (!isClusterReady) {

                        return res.status(503).json({ error: "The search service is starting up. Please try again in a moment." });

                    }

            

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
            const articlesToCheck = feed.items.slice(0, 20);
            console.log(`[Search] Found ${articlesToCheck.length} articles.`);
            // Step 2: Get content for all articles
            console.log(`[Content Fetch] Getting content for ${articlesToCheck.length} articles...`);
            const contentPromises = articlesToCheck.map(article => 
                cluster.execute({ taskFunction: getContentTask, taskData: { article } })
            );
            const articlesWithContentResults = await Promise.allSettled(contentPromises);
            const articlesWithContent = articlesWithContentResults
                .filter(result => result.status === 'fulfilled' && result.value && !result.value.error)
                .map(result => result.value);
            console.log(`[Content Fetch] Successfully got content for ${articlesWithContent.length} articles.`);

            // Step 3: Perform semantic check on articles with content
            console.log(`[Semantic Check] Performing semantic check for ${articlesWithContent.length} articles.`);
            const semanticCheckResults = await processInBatches(
                articlesWithContent,
                (article) => semanticCheckTask({ data: { article, userTopic } }),
                8, // Batch size
                65000 // Delay in ms (65 seconds)
            );
            
            const semanticallyRelevantArticles = semanticCheckResults
                .filter(result => result.status === 'fulfilled' && result.value?.is_relevant)
                .map(result => result.value);
            console.log(`[Semantic Check] Found ${semanticallyRelevantArticles.length} semantically relevant articles.`);
            
            // Log the reasoning for the chosen articles
            semanticallyRelevantArticles.forEach(article => {
                console.log(`[Semantic Check] AI reasoning for "${article.title}": ${article.reason}`);
            });

            // Step 4: Summarize the relevant articles
            console.log(`[Summarization] Summarizing ${semanticallyRelevantArticles.length} relevant articles...`);
            const summaryResults = await processInBatches(
                semanticallyRelevantArticles,
                (article) => summarizeArticleTask({ data: { article } }),
                8, // Batch size
                65000 // Delay in ms
            );
            const articlesWithSummaries = summaryResults
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value)
                .map(article => {
                    const originalArticle = semanticallyRelevantArticles.find(a => a.link === article.link);
                    return { ...article, reason: originalArticle.reason };
                });

            console.log(`[Summarization] Successfully summarized ${articlesWithSummaries.length} articles.`);

            // Step 5: Create a job and store the relevant articles with summaries
            if (articlesWithSummaries.length === 0) {
                console.log(`[Job] No relevant articles found for job.`);
                return res.status(200).json({ jobId: null, message: "No relevant articles found for your topic." });
            }

            const jobId = randomUUID();
            await db.createJob(jobId, req.session.userId);
            await db.addArticlesToJob(jobId, articlesWithSummaries.map(article => ({
                link: article.link,
                title: article.title,
                content: article.articleText,
                summary: article.summary,
                reason: article.reason
            })));

            // Mark job as completed immediately
            await db.updateJobStatus(jobId, 'completed');

            console.log(`[Job] Created job ${jobId} with ${articlesWithSummaries.length} relevant articles and marked as completed.`);

            res.status(202).json({ jobId });

        } catch (err) {
            console.error('[Search] Error in /api/rss:', err);
            res.status(500).json({ error: err.message || "Error during article search" });
        }

                    console.log(`[Server] /api/rss route finished for user ${req.session.userId}`);

                });

            app.get("/api/results/:jobId", isAuthenticated, async (req, res) => {

                const { jobId } = req.params;

                try {

                    const job = await db.getJob(jobId);

                    if (!job) {

                        return res.status(404).json({ error: "Job not found" });

                    }

        

                    if (job.status === 'completed') {
                        const articles = await db.getJobArticles(jobId);
                        res.json({ status: 'completed', articles: articles });
                    } else {
                        res.json({ status: job.status });
                    }

                } catch (err) {

                    console.error(`[Results] Error fetching results for job ${jobId}:`, err);

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

            

            app.post("/api/summarize", isAuthenticated, async (req, res) => {

                console.log('[API /summarize] Received request. Session:', req.session, 'Body:', req.body);

                if (!isClusterReady) {

                    return res.status(503).json({ error: "The summary service is starting up. Please try again in a moment." });

                }

                try {

                    const { articles, length } = req.body;

                    if (!articles?.length) return res.status(400).json({ error: "No articles provided" });

        

                    const summaryPromises = articles.map(article => 

                        cluster.execute({ taskFunction: summarizeArticleTask, taskData: { article, length } })

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

        

            

        

            main().catch(err => {

        

                console.error('[Server] ❌ Unhandled error during startup:', err);

        

                process.exit(1);

        

            });
