import * as db from './database-postgres.js';
import { getAggregatedFeed } from './rss-aggregator.js';
import { filterArticlesByRelevanceLocal, embedArticles } from './local-ai.js';
import { Logger, EMOJIS } from './utils.js';
import { sendImmediateAlert, sendDailyBriefing } from './email-service.js';
import fetch from 'node-fetch';
import Parser from 'rss-parser';
import cron from 'node-cron';
import { DateTime } from 'luxon';

const schedulerLogger = new Logger('Scheduler', 'yellow', EMOJIS.scheduler);
const parser = new Parser();

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

// A global cache of recently processed article URLs to avoid re-processing the same raw articles unnecessarily
const recentArticlesCache = new Set();

async function pollFeedsAndMatch() {
    try {
        const dashboards = await db.getAllActiveDashboards();
        if (dashboards.length === 0) {
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
            return;
        }

        schedulerLogger.info(`[Live-Feed] Suche nach neuen Artikeln für ${dashboards.length} aktive(s) Dashboard(s)...`);

        // We only want articles from the last 24 hours to keep it relevant
        const minDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // 2. Fetch Custom RSS Feeds
        const customArticles = await getAggregatedFeed(Array.from(allCategories), minDate, {});
        
        // 3. Fetch Google News
        const googleArticlesMap = new Map();
        // Increase the term limit to 40 to ensure variety across multiple dashboards
        const termsToSearch = Array.from(allSearchTerms).slice(0, 40);
        
        for (const term of termsToSearch) {
            const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(term)}&hl=de&gl=DE&ceid=DE:de`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 12000); // Slightly longer timeout
            try {
                const response = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
                if (response.ok) {
                    const xml = await response.text();
                    const feed = await parser.parseString(xml);
                    // Take up to 20 items per term for a larger initial pool
                    feed.items.slice(0, 20).forEach(article => {
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
        const newArticles = allFetchedArticles.filter(a => {
            if (!a || !a.link || recentArticlesCache.has(a.link)) return false;
            const content = a.contentSnippet || a.content || a.snippet || '';
            if (content.trim().length < 80) return false;
            return true;
        });
        
        // Update cache
        newArticles.forEach(a => recentArticlesCache.add(a.link));
        if (recentArticlesCache.size > 10000) {
            const urlsToRemove = Array.from(recentArticlesCache).slice(0, 2000);
            urlsToRemove.forEach(url => recentArticlesCache.delete(url));
        }

        if (newArticles.length === 0) {
             schedulerLogger.info(`[Live-Feed] Keine neuen Artikel gefunden. Warte auf nächstes Intervall...`);
             return;
        }

        schedulerLogger.info(`[Live-Feed] ${newArticles.length} neue rohe Artikel gefunden. Starte KI-Einbettung...`);

        // --- EFFICIENCY FIX: Embed all unique articles ONCE ---
        const embeddedArticles = await embedArticles(newArticles);

        // 4. Match against each dashboard using pre-computed embeddings
        let totalMatches = 0;
        for (const dashboard of dashboards) {
            if (!dashboard.user_intent) continue;

            const articlesToProcess = [];
            for (const a of embeddedArticles) {
                const alreadyInDb = await db.isArticleAlreadyInDashboard(dashboard.id, a.link);
                if (!alreadyInDb) {
                    articlesToProcess.push(a);
                }
            }

            if (articlesToProcess.length === 0) continue;

            schedulerLogger.info(`[Live-Feed] Dashboard "${dashboard.name}": Vergleiche ${articlesToProcess.length} Kandidaten...`);

            const matchedArticles = await filterArticlesByRelevanceLocal(
                articlesToProcess, 
                dashboard.user_intent, 
                10, 
                dashboard.user_intent_embedding
            );

            for (const match of matchedArticles) {
                const aiReasonSummary = match.aiReason ? `[KI-Auswahl] ${match.aiReason}` : null;
                const insertedArticle = await db.addDashboardArticle(dashboard.id, match, match.relevanceScore, aiReasonSummary);
                
                if (insertedArticle) {
                    totalMatches++;
                    schedulerLogger.info(`[Live-Feed] ✨ Neuer Treffer für Dashboard "${dashboard.name}": ${match.title}`);
                    
                    // --- KILL-KEYWORD CHECK (IMMEDIATE ALERT) ---
                    const user = await db.getUserById(dashboard.user_id);
                    if (user && user.email) {
                        let killKeywords = dashboard.kill_keywords;
                        if (typeof killKeywords === 'string') {
                            try { killKeywords = JSON.parse(killKeywords); } catch (e) { killKeywords = []; }
                        }
                        
                        if (Array.isArray(killKeywords) && killKeywords.length > 0) {
                            const fullText = `${match.title} ${match.contentSnippet || match.snippet || ''}`.toLowerCase();
                            const matchedKeyword = killKeywords.find(kw => fullText.includes(kw.toLowerCase()));
                            
                            if (matchedKeyword) {
                                schedulerLogger.info(`[ALARM] Kill-Keyword "${matchedKeyword}" gefunden! Sende E-Mail an ${user.email}...`);
                                await sendImmediateAlert(user.email, match, dashboard.name, matchedKeyword);
                                await db.markArticlesAsSent([insertedArticle.id]);
                            }
                        }
                    }
                }
            }
        }
        
        schedulerLogger.info(`[Live-Feed] Suchzyklus abgeschlossen. ${totalMatches} relevante Artikel an Dashboards verteilt.`);

    } catch (error) {
        schedulerLogger.error("Error during feed poll:", error);
    }
}

// --- DAILY BRIEFING SCHEDULER (7 AM Europe/Berlin) ---
cron.schedule('0 7 * * *', async () => {
    schedulerLogger.info('[Briefing] Starte tägliches Morning Briefing um 07:00 Uhr...');
    try {
        const dashboards = await db.getAllActiveDashboards();
        const usersToNotify = new Set(dashboards.map(d => d.user_id));

        for (const userId of usersToNotify) {
            const user = await db.getUserById(userId);
            if (!user || !user.email) continue;

            const unsentArticles = await db.getUnsentArticlesForUser(userId);
            if (unsentArticles.length === 0) continue;

            const articlesByDashboard = {};
            unsentArticles.forEach(a => {
                if (!articlesByDashboard[a.dashboard_name]) articlesByDashboard[a.dashboard_name] = [];
                articlesByDashboard[a.dashboard_name].push(a);
            });

            schedulerLogger.info(`[Briefing] Sende Zusammenfassung an ${user.email} (${unsentArticles.length} Artikel)...`);
            await sendDailyBriefing(user.email, articlesByDashboard);
            await db.markArticlesAsSent(unsentArticles.map(a => a.id));
        }
    } catch (err) {
        schedulerLogger.error('[Briefing] Fehler beim Versand des Morning Briefings:', err);
    }
}, {
    timezone: "Europe/Berlin"
});

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
