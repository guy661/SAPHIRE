const { pipeline } = require('@xenova/transformers');
const { Logger, EMOJIS } = require('./utils');
const pLimit = require('p-limit');

const aiLogger = new Logger('LocalAI', 'cyan', EMOJIS.robot);

// Strictness threshold. 
// 0.25 excludes pure noise but allows semantic variations.
// < 0.20 is usually irrelevant. > 0.4 is very strong match.
const MIN_RELEVANCE_SCORE = 0.5; 

// Cache the model globally so we don't reload it for every job
let extractor = null;

async function getExtractor() {
    if (!extractor) {
        aiLogger.info('Loading local embedding model (Xenova/bge-small-en-v1.5)...');
        // This downloads the model once and caches it locally
        // We use the multilingual model to support German and English inputs correctly.
        extractor = await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
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

/**
 * Sorts and filters a list of articles based on semantic similarity to the user intent.
 * Runs locally on CPU.
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 500) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    const initialCount = articles.length;

    // --- STAGE 1: Ultra-Fast Keyword Pre-Filter ---
    // This dramatically speeds up processing by removing obvious garbage (0% lexical overlap)
    // before running the expensive neural network.
    
    // 1. Extract keywords from intent (naive approach: split by space, remove short words)
    const keywords = userIntent.toLowerCase()
        .split(/[\s,.;:!?]+/)
        .filter(w => w.length > 3) // Filter out "der", "die", "und", "the", "and"...
        .map(w => w.trim());

    // 2. Score all articles based on keyword presence
    // This runs in milliseconds even for 20k items.
    let candidates = articles.map(article => {
        const text = `${article.title} ${article.contentSnippet || ''}`.toLowerCase();
        let keywordScore = 0;
        for (const word of keywords) {
            if (text.includes(word)) keywordScore++;
        }
        return { article, keywordScore };
    });

    // 3. Keep only the candidates that have at least SOME overlap, or top N if too many.
    // We keep 3x the requested topK to give the AI enough choice, but cap at 2000 to ensure speed.
    const PRE_FILTER_LIMIT = Math.max(topK * 3, 2000); 
    
    // Sort by keyword score first to keep the "most likely" candidates
    candidates.sort((a, b) => b.keywordScore - a.keywordScore);
    
    // Slice to limit
    let reducedArticles = candidates
        .slice(0, PRE_FILTER_LIMIT)
        .map(c => c.article);

    const preFilterCount = reducedArticles.length;
    aiLogger.info(`Stage 1 (Keyword Filter): Reduced ${initialCount} -> ${preFilterCount} items in ${Date.now() - totalStart}ms.`);

    if (reducedArticles.length === 0) return [];

    // --- STAGE 2: Neural Embeddings (The Heavy Lifting) ---
    // Now we only run the AI on the survivors.
    
    const pipe = await getExtractor();
    aiLogger.info(`Stage 2 (AI): Calculating semantic scores for ${preFilterCount} candidates (Batched)...`);

    // 1. Embed the User Intent
    const intentOutput = await pipe(userIntent, { pooling: 'mean', normalize: true });
    const intentEmbedding = intentOutput.data;

    // 2. Embed Articles in Larger Batches
    const BATCH_SIZE = 64; // Increased for throughput
    let scoredArticles = [];
    let processed = 0;

    for (let i = 0; i < preFilterCount; i += BATCH_SIZE) {
        const batch = reducedArticles.slice(i, i + BATCH_SIZE);
        
        // Optimize Input: Title is 90% of the signal. 
        // We limit context to 150 chars to speed up tokenization and inference.
        const textsToEmbed = batch.map(a => 
            `${a.title} ${(a.contentSnippet || '').substring(0, 50)}`.substring(0, 150)
        );

        try {
            const output = await pipe(textsToEmbed, { pooling: 'mean', normalize: true });
            const embeddingDim = output.dims[1];
            
            for (let j = 0; j < batch.length; j++) {
                const embedding = output.data.subarray(j * embeddingDim, (j + 1) * embeddingDim);
                const score = cosineSimilarity(intentEmbedding, embedding);
                scoredArticles.push({ ...batch[j], relevanceScore: score });
            }

            processed += batch.length;
            if (processed % 500 < BATCH_SIZE) {
                 aiLogger.debug(`AI Progress: ${processed}/${preFilterCount}`);
            }

        } catch (e) {
            aiLogger.error(`Batch error: ${e.message}`);
        }
    }

    // 3. Strict Filtering
    const beforeFilterCount = scoredArticles.length;
    scoredArticles = scoredArticles.filter(a => a.relevanceScore >= MIN_RELEVANCE_SCORE);
    
    // 4. Sort by Score DESC
    scoredArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);

    aiLogger.info(`Local AI Filter Done: Kept ${scoredArticles.length} relevant items. Total time: ${(Date.now() - totalStart) / 1000}s`);

    // 5. Slice to requested limit
    return scoredArticles.slice(0, topK);
}

module.exports = { filterArticlesByRelevanceLocal };
