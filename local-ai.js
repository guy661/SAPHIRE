const { pipeline } = require('@xenova/transformers');
const { Logger, EMOJIS } = require('./utils');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pLimit = require('p-limit');

const aiLogger = new Logger('AI-Filter', 'cyan', EMOJIS.semantic);

// API Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS;
let genAI = null;
if (GEMINI_API_KEY) {
    const firstKey = GEMINI_API_KEY.split(',')[0].trim();
    genAI = new GoogleGenerativeAI(firstKey);
}

// Strictness threshold. 
const MIN_RELEVANCE_SCORE = 0.30; 

// Cache the local model globally if needed
let extractor = null;

async function getExtractor() {
    if (!extractor) {
        aiLogger.info('Loading local embedding model (Xenova/paraphrase-multilingual-MiniLM-L12-v2)...');
        extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
            quantized: true,
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

function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Sorts and filters a list of articles based on semantic similarity to the user intent.
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 500) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    let intentEmbedding;
    let scoredArticles = [];

    if (genAI) {
        // --- CLOUD EMBEDDINGS (GEMINI) ---
        aiLogger.info(`Using Cloud Embeddings (Gemini) for ${articles.length} articles...`);
        const model = genAI.getGenerativeModel({ model: "gemini-embedding-2" });

        try {
            // 1. Embed Intent
            const intentRes = await model.embedContent(userIntent);
            intentEmbedding = intentRes.embedding.values;

            // 2. Embed Articles in Batches (Gemini supports batching)
            const BATCH_SIZE = 50; 
            for (let i = 0; i < articles.length; i += BATCH_SIZE) {
                const batch = articles.slice(i, i + BATCH_SIZE);
                const texts = batch.map(a => {
                    const cleanSnippet = cleanText(a.contentSnippet || a.snippet || '');
                    return `Title: ${a.title}\nContent: ${cleanSnippet}`.substring(0, 1000);
                });

                const batchRes = await model.batchEmbedContents({
                    requests: texts.map(t => ({ content: { role: "user", parts: [{ text: t }] } }))
                });

                batchRes.embeddings.forEach((emb, index) => {
                    const score = cosineSimilarity(intentEmbedding, emb.values);
                    scoredArticles.push({ ...batch[index], relevanceScore: score });
                });
            }
        } catch (error) {
            aiLogger.error(`Cloud Embedding Error: ${error.message}. Falling back to local if possible...`);
            // If cloud fails, we don't return, we try to let it fall through to local or fail gracefully
            if (!extractor && !GEMINI_API_KEY) throw error; 
        }
    } 
    
    // --- LOCAL FALLBACK (XENOVA) ---
    if (scoredArticles.length === 0) {
        const pipe = await getExtractor();
        aiLogger.info(`Calculating semantic scores for ${articles.length} candidates using local CPU...`);

        const intentOutput = await pipe(userIntent, { pooling: 'mean', normalize: true });
        intentEmbedding = intentOutput.data;

        const BATCH_SIZE = 32;
        for (let i = 0; i < articles.length; i += BATCH_SIZE) {
            const batch = articles.slice(i, i + BATCH_SIZE);
            const textsToEmbed = batch.map(a => {
                const cleanSnippet = cleanText(a.contentSnippet || a.snippet || '');
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
            } catch (e) {
                aiLogger.error(`Local Batch error: ${e.message}`);
            }
        }
    }

    // 3. Strict Filtering & Sorting
    const keptArticles = scoredArticles
        .filter(a => a.relevanceScore >= MIN_RELEVANCE_SCORE)
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

    const discardedArticles = scoredArticles
        .filter(a => a.relevanceScore < MIN_RELEVANCE_SCORE)
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

    if (keptArticles.length > 0) {
        const highest = keptArticles[0];
        aiLogger.info(`[Score Stats] Highest: "${highest.title}" (${highest.relevanceScore.toFixed(4)})`);
    }

    if (discardedArticles.length > 0) {
        const bestLoser = discardedArticles[0];
        aiLogger.info(`[Discarded Debug] Best rejected: [${bestLoser.relevanceScore.toFixed(4)}] ${bestLoser.title}`);
    }

    aiLogger.info(`AI Filter Done: Kept ${keptArticles.length}/${articles.length}. Time: ${(Date.now() - totalStart) / 1000}s`);
    return keptArticles.slice(0, topK);
}

module.exports = { filterArticlesByRelevanceLocal };

module.exports = { filterArticlesByRelevanceLocal };