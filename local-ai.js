const { pipeline } = require('@xenova/transformers');
const { Logger, EMOJIS } = require('./utils');
const pLimit = require('p-limit');

const aiLogger = new Logger('LocalAI', 'cyan', EMOJIS.robot);

// Strictness threshold. 
// 0.30 excludes pure noise but allows semantic variations.
// < 0.25 is usually irrelevant. > 0.5 is very strong match.
const MIN_RELEVANCE_SCORE = 0.30; 

// Cache the model globally so we don't reload it for every job
let extractor = null;

async function getExtractor() {
    if (!extractor) {
        aiLogger.info('Loading local embedding model (Xenova/all-MiniLM-L6-v2)...');
        // This downloads the model once and caches it locally
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
            quantized: true, // Use quantized version for speed
        });
        aiLogger.info('Local model loaded successfully.');
    }
    return extractor;
}

// Helper to compute cosine similarity
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        magnitudeA += vecA[i] * vecA[i];
        magnitudeB += vecB[i] * vecB[i];
    }
    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Sorts and filters a list of articles based on semantic similarity to the user intent.
 * Runs locally on CPU.
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 500) {
    if (!articles || articles.length === 0) return [];
    
    const pipe = await getExtractor();
    aiLogger.info(`Calculating semantic scores for ${articles.length} articles locally (Parallelized)...`);

    // 1. Embed the User Intent
    const intentOutput = await pipe(userIntent, { pooling: 'mean', normalize: true });
    const intentEmbedding = intentOutput.data;

    // 2. Embed all Article Titles in Parallel
    const limit = pLimit(10); // Run 10 embeddings in parallel
    let processed = 0;
    const total = articles.length;

    const promises = articles.map(article => limit(async () => {
        const textToEmbed = `${article.title} ${article.contentSnippet || ''}`.substring(0, 200); 
        try {
            const output = await pipe(textToEmbed, { pooling: 'mean', normalize: true });
            const embedding = output.data;
            const score = cosineSimilarity(intentEmbedding, embedding);
            
            processed++;
            if (processed % 1000 === 0) aiLogger.debug(`Embedded ${processed}/${total} items.`);
            
            return { ...article, relevanceScore: score };
        } catch (e) {
            return null;
        }
    }));

    const results = await Promise.all(promises);
    let scoredArticles = results.filter(a => a !== null);

    // 3. Strict Filtering
    const beforeFilterCount = scoredArticles.length;
    scoredArticles = scoredArticles.filter(a => a.relevanceScore >= MIN_RELEVANCE_SCORE);
    const afterFilterCount = scoredArticles.length;
    const discardedCount = beforeFilterCount - afterFilterCount;

    // 4. Sort by Score DESC
    scoredArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);

    // 5. Log results
    if (scoredArticles.length > 0) {
        aiLogger.info(`Local AI Filter: Kept ${afterFilterCount} relevant items. Discarded ${discardedCount} items below score ${MIN_RELEVANCE_SCORE}.`);
        aiLogger.info(`Top Match: "${scoredArticles[0].title}" (Score: ${scoredArticles[0].relevanceScore.toFixed(4)})`);
        aiLogger.info(`Lowest kept Match: "${scoredArticles[scoredArticles.length - 1].title}" (Score: ${scoredArticles[scoredArticles.length - 1].relevanceScore.toFixed(4)})`);
    } else {
        aiLogger.warn(`Local AI Filter: ALL ${beforeFilterCount} items were discarded because none met the relevance threshold of ${MIN_RELEVANCE_SCORE}.`);
    }

    // 6. Slice to requested limit (but don't add back removed items)
    return scoredArticles.slice(0, topK);
}

module.exports = { filterArticlesByRelevanceLocal };
