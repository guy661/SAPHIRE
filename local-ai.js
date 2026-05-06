const { Logger, EMOJIS } = require('./utils');
const { generateHighPrecisionKeywordsTask, verifyArticleRelevanceTask } = require('./task');

const aiLogger = new Logger('AI-Filter-Smart', 'cyan', EMOJIS.semantic);

// In-Memory Cache für generierte Keywords, um API-Calls zu sparen
const keywordCache = new Map();

/**
 * Zweistufige Filterung: 
 * 1. Schnelle Keyword-Vorfilterung (Coarse-grained)
 * 2. Präzise KI-Verifizierung für Top-Kandidaten (Fine-grained)
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 10) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    aiLogger.info(`Starting smart filtering for intent: "${userIntent}"`);

    try {
        // --- STAGE 1: KEYWORD PRE-FILTERING ---
        let expandedKeywords;
        if (keywordCache.has(userIntent)) {
            expandedKeywords = keywordCache.get(userIntent);
        } else {
            expandedKeywords = await generateHighPrecisionKeywordsTask({ data: { user_intent: userIntent } });
            keywordCache.set(userIntent, expandedKeywords);
            if (keywordCache.size > 100) {
                const firstKey = keywordCache.keys().next().value;
                keywordCache.delete(firstKey);
            }
        }

        const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\\]/g, '\\$&');
        const regexPatterns = expandedKeywords.map(kw => `\\b${escapeRegExp(kw)}\\b`);
        const combinedRegex = new RegExp(regexPatterns.join('|'), 'i');

        const scoredArticles = articles.map(article => {
            const title = article.title || '';
            const content = article.contentSnippet || article.snippet || '';
            const fullText = `${title} ${content}`;

            let score = 0;
            let uniqueMatches = 0;
            
            if (combinedRegex.test(fullText)) {
                expandedKeywords.forEach(kw => {
                    const kwRegex = new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'gi');
                    const titleMatches = (title.match(kwRegex) || []).length;
                    const contentMatches = (content.match(kwRegex) || []).length;
                    
                    if (titleMatches > 0 || contentMatches > 0) {
                        uniqueMatches++;
                        score += titleMatches * 5; // Title matches are highly relevant
                        score += contentMatches;
                    }
                });
                
                // Bonus for matching multiple unique keywords
                if (uniqueMatches > 1) {
                    score *= (1 + (uniqueMatches * 0.1));
                }
            }

            return { ...article, relevanceScore: score };
        });

        const preFiltered = scoredArticles
            .filter(a => a.relevanceScore > 0)
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, 40); // Increased pool to 40 for better diversity and higher chance of finding niche gems

        if (preFiltered.length === 0) {
            aiLogger.info(`Stage 1: No candidates found. Time: ${(Date.now() - totalStart) / 1000}s`);
            return [];
        }

        aiLogger.info(`Stage 1 Done: ${preFiltered.length} candidates for verification.`);

        // --- STAGE 2: AI DEEP VERIFICATION ---
        const finalResults = [];
        // Sequential verification (better for rate limits and avoids overwhelming the API)
        for (const candidate of preFiltered) {
            try {
                const verification = await verifyArticleRelevanceTask({
                    data: { article: candidate, user_intent: userIntent }
                });

                if (verification.relevant && verification.score >= 50) { // Slightly higher threshold for "relevant"
                    finalResults.push({
                        ...candidate,
                        relevanceScore: verification.score,
                        aiReason: verification.reason
                    });
                }
            } catch (err) {
                aiLogger.warn(`Verification failed for "${candidate.title}": ${err.message}`);
            }
            
            // We want a good mix, so we don't stop too early, but we limit to topK
            if (finalResults.length >= topK) break;
        }

        aiLogger.info(`Smart Filtering Done: Kept ${finalResults.length}/${articles.length}. Time: ${(Date.now() - totalStart) / 1000}s`);
        
        return finalResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

    } catch (err) {
        aiLogger.error(`Smart Filtering failed: ${err.message}. Falling back to basic search.`);
        const simpleRegex = new RegExp(userIntent.split(' ').join('|'), 'i');
        return articles.filter(a => simpleRegex.test(`${a.title} ${a.contentSnippet}`)).slice(0, topK);
    }
}

// Dummy-Funktionen für Kompatibilität
async function embedArticles(articles) { return articles; }
async function embedText(text) { return []; }

module.exports = { filterArticlesByRelevanceLocal, embedArticles, embedText };
