// job-starter.js
require('dotenv').config();

const db = require('./database-postgres.js');
const { generateSearchQueriesTask, generateGeneralKeywordsTask } = require('./task.js');
const { getAggregatedFeed } = require('./rss-aggregator.js');
const { filterArticlesByRelevanceLocal } = require('./local-ai.js'); // Import local AI
const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const { Logger, EMOJIS } = require('./utils.js');

const jobLogger = new Logger('JobStarter', 'magenta', EMOJIS.job);
const parser = new Parser();

// This function is now self-contained and can be imported anywhere.
async function startSearchJob(dashboardId, userId, rssCategories = []) {
    const queuesModule = await import('./queues.mjs');
    const { semanticQueue } = queuesModule.default; // Changed from fetchAllQueue to semanticQueue

    const dashboard = await db.getDashboardById(dashboardId);
    if (!dashboard || dashboard.user_id !== userId) {
        throw new Error("Dashboard not found or access denied.");
    }
    if (!dashboard.user_intent) {
        throw new Error("Dashboard has no user intent defined yet.");
    }

    jobLogger.info(`Starting combined search job for dashboard ${dashboardId}. RSS Categories: [${rssCategories.join(', ')}]`);
    const user = await db.getUserById(userId);

    // Determine the "since" date for filtering
    const lastJob = await db.getLatestCompletedJobForDashboard(dashboardId);
    let minDate = null;
    let previousSummary = null; // Store previous summary for redundancy check
    
    if (lastJob) {
        // Dynamic Buffer Logic
        const intervalMinutes = dashboard.interval_minutes && dashboard.interval_minutes > 0 ? dashboard.interval_minutes : 0;
        const bufferMinutes = intervalMinutes > 0 ? Math.floor(intervalMinutes * 0.5) : 720; 
        
        const lastJobDate = new Date(lastJob.created_at);
        minDate = new Date(lastJobDate.getTime() - (bufferMinutes * 60000)); 
        
        // Use the meta_summary from the last job directly
        if (lastJob.meta_summary) {
            previousSummary = lastJob.meta_summary;
        }

        jobLogger.info(`Found previous job from ${lastJobDate.toLocaleString()}. effectiveMinDate: ${minDate.toLocaleString()}`);
    } else {
        // Default to 7 days (1 week) ago if no previous job (First Run)
        const d = new Date();
        d.setHours(d.getHours() - 168); // 7 * 24 = 168 hours
        minDate = d;
        jobLogger.info(`No previous job found (First Run). Filtering articles older than 7 days (${minDate.toLocaleString()}).`);
    }

    // We rely on Semantic AI filtering locally now.
    // We disable the dumb keyword filter by passing empty object.
    const searchTerms = {}; 
    
    // const hasKeywords = Object.keys(searchTerms).length > 0 && Object.values(searchTerms).some(arr => arr && arr.length > 0);
    jobLogger.info(`Fetching articles since ${minDate.toLocaleString()}. Will use LOCAL AI for semantic pre-filtering.`);

    // --- Google News Search Promise ---
    const googleNewsPromise = async () => {
        // Since we have no stored keywords, we ALWAYS generate fresh queries for Google News based on intent
        // This is specific to Google News as it REQUIRES a query string.
        let searchQueries = await generateSearchQueriesTask({ data: { user_intent: dashboard.user_intent, language: user.language || 'de' } });

        const googleArticles = new Map();
        for (const query of searchQueries) {
            const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${user.language}&gl=DE&ceid=DE:${user.language}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            try {
                const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
                if (!response.ok) {
                    jobLogger.warn(`Could not load Google News RSS feed for query "${query}". Status: ${response.status}`);
                    continue;
                }
                const xml = await response.text();
                const feed = await parser.parseString(xml);
                feed.items.slice(0, 10).forEach(article => {
                    if (minDate && article.pubDate && new Date(article.pubDate) <= new Date(minDate)) return;
                    if (article.link && !googleArticles.has(article.link)) {
                        article.sourceName = 'Google News';
                        googleArticles.set(article.link, article);
                    }
                });
            } catch (err) {
                jobLogger.warn(`Failed to fetch or parse Google News feed for query "${query}": ${err.message}`);
            }
        }
        return Array.from(googleArticles.values());
    };

    // --- Custom RSS Feed Promise ---
    const customRssPromise = async () => {
        // Fetch ALL items from the feeds, filtered ONLY by date (no keywords)
        return getAggregatedFeed(rssCategories, minDate, {}); 
    };

    // --- Execute and Combine with Priority ---
    const allArticles = new Map();

    // 1. Prioritize custom RSS feeds
    const customRssArticles = await customRssPromise();
    customRssArticles.forEach(article => {
        if (article && article.link && !allArticles.has(article.link)) {
            allArticles.set(article.link, article);
        }
    });

    // 2. Add Google News articles
    const googleArticles = await googleNewsPromise();
    googleArticles.forEach(article => {
        if (article && article.link && !allArticles.has(article.link)) {
            allArticles.set(article.link, article);
        }
    });

    // Original raw candidates
    let articlesToCheck = Array.from(allArticles.values());
    jobLogger.info(`Found a total of ${articlesToCheck.length} raw articles. Running Local AI Semantic Filter...`);

    // --- LOCAL AI FILTERING ---
    // This reduces the 27k+ articles to the top 1000 most relevant ones based on vector similarity
    // running entirely on CPU without external API costs.
    try {
        articlesToCheck = await filterArticlesByRelevanceLocal(articlesToCheck, dashboard.user_intent, 1000);
        jobLogger.info(`Local AI Filter kept top ${articlesToCheck.length} semantically relevant articles.`);
    } catch (err) {
        jobLogger.error("Local AI Filter failed, falling back to raw date slicing:", err);
        articlesToCheck = articlesToCheck.slice(0, 1000);
    }

    if (articlesToCheck.length === 0) {
        jobLogger.info(`No articles found for dashboard ${dashboardId} in the given time window.`);
        return null;
    }

    const jobId = randomUUID();
    await db.createJob(jobId, dashboardId, 'pending');  

    // Add to semantic queue with reference to previous summary for redundancy check
    await semanticQueue.add('semantic-summary', {
        jobId: jobId,
        dashboardId: dashboardId,
        userId: userId,
        articles: articlesToCheck,
        user_intent: dashboard.user_intent,
        language: user.language || 'de',
        previousSummary: previousSummary // Pass this down
    });

    return jobId;
}

module.exports = { startSearchJob };

