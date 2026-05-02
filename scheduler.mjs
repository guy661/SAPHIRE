import * as db from './database-postgres.js';
import { getAggregatedFeed } from './rss-aggregator.js';
import { filterArticlesByRelevanceLocal } from './local-ai.js';
import { Logger, EMOJIS } from './utils.js';
import fetch from 'node-fetch';
import Parser from 'rss-parser';
import queues from './queues.mjs';

const schedulerLogger = new Logger('Scheduler', 'yellow', EMOJIS.scheduler);
const parser = new Parser();
const { microSummaryQueue } = queues;

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

// A global cache of recently processed article URLs to avoid re-processing the same raw articles unnecessarily
const recentArticlesCache = new Set();

async function pollFeedsAndMatch() {
    try {
        const dashboards = await db.getAllActiveDashboards();
        if (dashboards.length === 0) {
            // Only log this occasionally, or keep it quiet to avoid log spam
            return;
        }

        // 1. Gather all required categories and search terms
        const allCategories = new Set();
        const allSearchTerms = new Set();

        for (const d of dashboards) {
            let categories = d.selected_categories;
            if (typeof categories === 'string') {
                try { categories = JSON.parse(categories); } catch (e) { categories = []; }
            }
            if (Array.isArray(categories)) {
                categories.forEach(c => allCategories.add(c));
            }

            let terms = d.search_terms;
            if (typeof terms === 'string') {
                try { terms = JSON.parse(terms); } catch (e) { terms = []; }
            }
            if (Array.isArray(terms)) {
                terms.forEach(t => allSearchTerms.add(t));
            }
        }
        
        if (allCategories.size === 0 && allSearchTerms.size === 0) {
            return; // Nothing to search for yet
        }

        schedulerLogger.info(`[Live-Feed] Suche nach neuen Artikeln für ${dashboards.length} aktive(s) Dashboard(s)...`);

        // We only want articles from the last 24 hours to keep it relevant
        const minDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // 2. Fetch Custom RSS Feeds
        const customArticles = await getAggregatedFeed(Array.from(allCategories), minDate, {});
        
        // 3. Fetch Google News
        const googleArticlesMap = new Map();
        for (const term of allSearchTerms) {
            const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(term)}&hl=de&gl=DE&ceid=DE:de`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            try {
                const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
                if (response.ok) {
                    const xml = await response.text();
                    const feed = await parser.parseString(xml);
                    feed.items.slice(0, 10).forEach(article => {
                        if (minDate && article.pubDate && new Date(article.pubDate) <= minDate) return;
                        if (article.link && !googleArticlesMap.has(article.link)) {
                            article.sourceName = 'Google News';
                            googleArticlesMap.set(article.link, article);
                        }
                    });
                }
            } catch (err) {
                schedulerLogger.warn(`Google News fetch failed for "${term}": ${err.message}`);
            }
        }

        const allFetchedArticles = [...customArticles, ...Array.from(googleArticlesMap.values())];
        
        // Filter out URLs we've recently seen in this session to save AI CPU time
        // Add a minimum length filter to avoid paywall stubs or empty articles (min 100 chars)
        const newArticles = allFetchedArticles.filter(a => {
            if (!a || !a.link || recentArticlesCache.has(a.link)) return false;
            
            const content = a.contentSnippet || a.content || a.snippet || '';
            // Paywall/Stub-Filter: Verwerfe Artikel mit fast keinem Inhalt
            if (content.trim().length < 100) return false;

            return true;
        });
        
        // Update cache
        newArticles.forEach(a => recentArticlesCache.add(a.link));
        if (recentArticlesCache.size > 10000) {
            // Keep cache size manageable
            const urlsToRemove = Array.from(recentArticlesCache).slice(0, 2000);
            urlsToRemove.forEach(url => recentArticlesCache.delete(url));
        }

        if (newArticles.length === 0) {
             schedulerLogger.info(`[Live-Feed] Keine neuen Artikel gefunden. Warte auf nächstes Intervall...`);
             return;
        }

        schedulerLogger.info(`[Live-Feed] ${newArticles.length} neue rohe Artikel gefunden. Starte KI-Relevanzprüfung...`);

        // 4. Match against each dashboard
        let totalMatches = 0;
        for (const dashboard of dashboards) {
            if (!dashboard.user_intent) continue;

            // --- OPTIMIZATION: Check DB before AI ---
            // Only process articles that aren't already in this specific dashboard
            const articlesToProcess = [];
            for (const a of newArticles) {
                const alreadyInDb = await db.isArticleAlreadyInDashboard(dashboard.id, a.link);
                if (!alreadyInDb) {
                    articlesToProcess.push(a);
                }
            }

            if (articlesToProcess.length === 0) continue;

            schedulerLogger.info(`[Live-Feed] Dashboard "${dashboard.name}": Prüfe ${articlesToProcess.length} neue Kandidaten mit KI...`);

            // Use Local AI to filter new articles against this dashboard's intent
            const matchedArticles = await filterArticlesByRelevanceLocal(articlesToProcess, dashboard.user_intent, 10); // Top 10 max per cycle

            for (const match of matchedArticles) {
                // Try to insert into the database (will handle title-based dedup and link-based dedup)
                const insertedArticle = await db.addDashboardArticle(dashboard.id, match, match.relevanceScore, null);
                
                if (insertedArticle) {
                    totalMatches++;
                    schedulerLogger.info(`[Live-Feed] ✨ Neuer Treffer für Dashboard "${dashboard.name}": ${match.title}`);
                }
            }
        }
        
        schedulerLogger.info(`[Live-Feed] Suchzyklus abgeschlossen. ${totalMatches} relevante Artikel an Dashboards verteilt.`);

    } catch (error) {
        schedulerLogger.error("Error during feed poll:", error);
    }
}

function startScheduler() {
    schedulerLogger.info(`Starting live feed watcher (interval: ${CHECK_INTERVAL_MS / 1000}s).`);
    
    // Cleanup old data on startup (keep last 7 days)
    db.deleteOldArticles(7).then(count => {
        if (count > 0) schedulerLogger.info(`[Cleanup] ${count} alte Artikel automatisch gelöscht.`);
    }).catch(err => schedulerLogger.error('Cleanup failed:', err));

    pollFeedsAndMatch();
    setInterval(pollFeedsAndMatch, CHECK_INTERVAL_MS);

    const gracefulShutdown = () => {
        schedulerLogger.warn('Watcher shutting down gracefully.');
        process.exit(0);
    };
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);
}

startScheduler();
