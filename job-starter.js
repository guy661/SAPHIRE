// job-starter.js
require('dotenv').config();

const db = require('./database-postgres.js');
const { generateSearchQueriesTask } = require('./task.js');
const { getAggregatedFeed } = require('./rss-aggregator.js');
const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const { Logger, EMOJIS } = require('./utils.js');

const jobLogger = new Logger('JobStarter', 'magenta', EMOJIS.job);
const parser = new Parser();

// This function is now self-contained and can be imported anywhere.
async function startSearchJob(dashboardId, userId, rssCategories = []) {
    const queuesModule = await import('./queues.mjs');
    const { fetchAllQueue } = queuesModule.default; // Changed from synthesisQueue

    const dashboard = await db.getDashboardById(dashboardId);
    if (!dashboard || dashboard.user_id !== userId) {
        throw new Error("Dashboard not found or access denied.");
    }
    if (!dashboard.user_intent) {
        throw new Error("Dashboard has no user intent defined yet.");
    }

    jobLogger.info(`Starting combined search job for dashboard ${dashboardId}. RSS Categories: [${rssCategories.join(', ')}]`);
    const user = await db.getUserById(userId);

    // --- Google News Search Promise ---
    const googleNewsPromise = async () => {
        // jobLogger.info('Generating smart search queries from user intent...');
        const searchQueries = await generateSearchQueriesTask({ data: { user_intent: dashboard.user_intent, language: user.language || 'de' } });
        // jobLogger.info(`Generated queries: [${searchQueries.join(', ')}]`);

        const googleArticles = new Map();
        for (const query of searchQueries) {
            // jobLogger.info(`Performing Google News search for: "${query}"`);
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
                    if (article.link && !googleArticles.has(article.link)) {
                        // Add the source name for Google News articles
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
        // The aggregator itself will handle the case of an empty category array by fetching all feeds.
        // jobLogger.info(`Performing custom RSS search for categories: [${rssCategories.join(', ')}]`);
        return getAggregatedFeed(rssCategories);
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
    // jobLogger.info(`Found ${allArticles.size} articles from custom RSS feeds.`);

    // 2. Add Google News articles as a supplement
    const googleArticles = await googleNewsPromise();
    googleArticles.forEach(article => {
        if (article && article.link && !allArticles.has(article.link)) {
            allArticles.set(article.link, article);
        }
    });
    // jobLogger.info(`Total unique articles after adding Google News: ${allArticles.size}.`);

    const articlesToCheck = Array.from(allArticles.values()).slice(0, 50);
    jobLogger.info(`Found a total of ${articlesToCheck.length} unique articles from all sources.`);

    if (articlesToCheck.length === 0) {
        jobLogger.info(`No articles found for dashboard ${dashboardId}. Job not created.`);
        return null;
    }

    const jobId = randomUUID();
    await db.createJob(jobId, dashboardId, 'pending'); // Set initial status to pending/queued

    // Add a single job to the fetch-all queue with all articles
    await fetchAllQueue.add('fetch-all', {
        jobId: jobId,
        dashboardId: dashboardId,
        userId: userId,
        articles: articlesToCheck,
        user_intent: dashboard.user_intent,
        language: user.language || 'de'
    });

    jobLogger.info(`Job ${jobId} created. Queued a fetch-all task with ${articlesToCheck.length} articles for dashboard ${dashboardId}.`);
    return jobId;
}

module.exports = { startSearchJob };

