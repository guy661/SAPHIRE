const { pipeline } = require('@xenova/transformers');
const { Logger, EMOJIS } = require('./utils');
const pLimit = require('p-limit');

const aiLogger = new Logger('LocalAI', 'cyan', EMOJIS.robot);

// Strictness threshold. 
// Auf 0.30 angepasst: Ein expliziter Trump-Artikel wurde mit 0.34 bewertet. 
// 0.30 fängt diese sehr eng an der Grenze liegenden, aber relevanten Artikel sicher auf, filtert aber extremen Müll (< 0.25) weiterhin.
const MIN_RELEVANCE_SCORE = 0.30; 

// Cache the model globally so we don't reload it for every job
let extractor = null;

async function getExtractor() {
    if (!extractor) {
        aiLogger.info('Loading local embedding model (Xenova/paraphrase-multilingual-MiniLM-L12-v2)...');
        // We use a true multilingual model now for better German support.
        extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
            quantized: true, // Use quantized version for speed
        });
        aiLogger.info('Local multilingual model loaded successfully.');
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

// Helper to remove HTML tags and decode entities partially
function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/<[^>]*>/g, ' ') // Remove HTML tags
        .replace(/\s+/g, ' ')     // Collapse whitespace
        .trim();
}

/**
 * Sorts and filters a list of articles based on semantic similarity to the user intent.
 * Runs locally on CPU.
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 500) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    
    // --- STAGE 2: Neural Embeddings (Directly, no Keyword Filter) ---
    
    const pipe = await getExtractor();
    aiLogger.info(`Calculating semantic scores for ${articles.length} candidates (Batched)...`);

    // 1. Embed the User Intent
    const intentOutput = await pipe(userIntent, { pooling: 'mean', normalize: true });
    const intentEmbedding = intentOutput.data;

    // 2. Embed Articles in Batches
    const BATCH_SIZE = 32; 
    let scoredArticles = [];
    let processed = 0;

    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
        const batch = articles.slice(i, i + BATCH_SIZE);
        
        // Optimize Input: Use full title and a good chunk of the snippet.
        // We clean HTML to reduce noise.
        const textsToEmbed = batch.map(a => {
            const cleanSnippet = cleanText(a.contentSnippet || a.snippet || '');
            // Combine Title and Snippet. Limit total length to ~500 chars.
            return `${a.title}. ${cleanSnippet}`.substring(0, 500);
        });

        try {
            const output = await pipe(textsToEmbed, { pooling: 'mean', normalize: true });
            const embeddingDim = output.dims[1];
            
            for (let j = 0; j < batch.length; j++) {
                const embedding = output.data.subarray(j * embeddingDim, (j + 1) * embeddingDim);
                const score = cosineSimilarity(intentEmbedding, embedding);
                scoredArticles.push({ ...batch[j], relevanceScore: score });
            }

            processed += batch.length;
            if (processed % 100 === 0) {
                 aiLogger.debug(`AI Progress: ${processed}/${articles.length}`);
            }

        } catch (e) {
            aiLogger.error(`Batch error: ${e.message}`);
        }
    }

    // 3. Strict Filtering
    const keptArticles = scoredArticles.filter(a => a.relevanceScore >= MIN_RELEVANCE_SCORE);
    const discardedArticles = scoredArticles.filter(a => a.relevanceScore < MIN_RELEVANCE_SCORE);
    
    // 4. Sort by Score DESC
    keptArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);
    discardedArticles.sort((a, b) => b.relevanceScore - a.relevanceScore); // Sort discarded too to see the "best losers"

    if (keptArticles.length > 0) {
        const highest = keptArticles[0];
        const lowest = keptArticles[keptArticles.length - 1];
        aiLogger.info(`[Score Stats] Highest: "${highest.title}" (${highest.relevanceScore.toFixed(4)}) | Lowest: "${lowest.title}" (${lowest.relevanceScore.toFixed(4)})`);
    }

    // Log the "best losers" to help debug strictness
    if (discardedArticles.length > 0) {
        const bestLosers = discardedArticles.slice(0, 3);
        aiLogger.info(`[Discarded Debug] Top 3 rejected (Threshold ${MIN_RELEVANCE_SCORE}):`);
        bestLosers.forEach(a => aiLogger.info(` - [${a.relevanceScore.toFixed(4)}] ${a.title}`));
    }

    aiLogger.info(`Local AI Filter Done: Kept ${keptArticles.length} relevant items (Discarded ${discardedArticles.length}). Total time: ${(Date.now() - totalStart) / 1000}s`);

    // 5. Slice to requested limit
    return keptArticles.slice(0, topK);
}

module.exports = { filterArticlesByRelevanceLocal };