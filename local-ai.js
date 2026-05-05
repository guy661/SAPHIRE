const { Logger, EMOJIS } = require('./utils');
const { generateHighPrecisionKeywordsTask } = require('./task');

const aiLogger = new Logger('AI-Filter-Smart', 'cyan', EMOJIS.semantic);

// In-Memory Cache für generierte Keywords, um API-Calls zu sparen
// Key: userIntent, Value: Array von Keywords
const keywordCache = new Map();

/**
 * Ersetzt das lokale Embedding-Modell durch eine hochpräzise Keyword-Filterung.
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 500) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    aiLogger.info(`Starting smart filtering for intent: "${userIntent}"`);

    try {
        // 1. KI-gestützte Keyword-Expansion mit Caching
        let expandedKeywords;
        if (keywordCache.has(userIntent)) {
            expandedKeywords = keywordCache.get(userIntent);
            // aiLogger.info(`Using cached keywords for: "${userIntent}"`);
        } else {
            expandedKeywords = await generateHighPrecisionKeywordsTask({ data: { user_intent: userIntent } });
            keywordCache.set(userIntent, expandedKeywords);
            
            // Cache-Größe begrenzen (max 100 Intents)
            if (keywordCache.size > 100) {
                const firstKey = keywordCache.keys().next().value;
                keywordCache.delete(firstKey);
            }
        }

        // 2. Erstellung eines hocheffizienten Regex-Patterns
        const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\\]/g, '\\$&');
        const regexPatterns = expandedKeywords.map(kw => `\\b${escapeRegExp(kw)}\\b`);
        const combinedRegex = new RegExp(regexPatterns.join('|'), 'i');

        // 3. Scoring basierend auf Keyword-Dichte und Position
        const scoredArticles = articles.map(article => {
            const title = article.title || '';
            const content = article.contentSnippet || article.snippet || '';
            const fullText = `${title} ${content}`;

            let score = 0;
            
            if (combinedRegex.test(fullText)) {
                expandedKeywords.forEach(kw => {
                    const kwRegex = new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'gi');
                    
                    const titleMatches = (title.match(kwRegex) || []).length;
                    score += titleMatches * 3;

                    const contentMatches = (content.match(kwRegex) || []).length;
                    score += contentMatches;
                });
            }

            return { ...article, relevanceScore: score };
        });

        // 4. Filtern und Sortieren
        const filtered = scoredArticles
            .filter(a => a.relevanceScore > 0)
            .sort((a, b) => b.relevanceScore - a.relevanceScore);

        aiLogger.info(`Smart Filtering Done: Kept ${filtered.length}/${articles.length}. Time: ${(Date.now() - totalStart) / 1000}s`);
        
        return filtered.slice(0, topK);

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
