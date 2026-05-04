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
 * Generates embeddings for a list of articles. 
 * Returns the same articles but with an added 'embedding' property.
 */
async function embedArticles(articles) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    const embeddedArticles = [];

    if (genAI) {
        aiLogger.info(`Embedding ${articles.length} articles using Cloud (Gemini)...`);
        const model = genAI.getGenerativeModel({ model: "gemini-embedding-2" });

        const BATCH_SIZE = 50; // Gemini supports up to 100, but 50 is safer
        for (let i = 0; i < articles.length; i += BATCH_SIZE) {
            const batch = articles.slice(i, i + BATCH_SIZE);
            const requests = batch.map(a => {
                const cleanSnippet = cleanText(a.contentSnippet || a.snippet || '');
                const text = `Title: ${a.title}\nContent: ${cleanSnippet}`.substring(0, 1000);
                return { content: { role: "user", parts: [{ text }] } };
            });

            try {
                // Add a small delay between batches if we have many to avoid rapid-fire 429s
                if (i > 0) await new Promise(resolve => setTimeout(resolve, 1000));

                const batchRes = await model.batchEmbedContents({ requests });
                
                batchRes.embeddings.forEach((emb, index) => {
                    embeddedArticles.push({ ...batch[index], embedding: emb.values });
                });
            } catch (error) {
                aiLogger.warn(`Gemini Batch Error at index ${i}: ${error.message}. Switching to local for this batch...`);
                
                // Fallback for this specific failed batch
                const pipe = await getExtractor();
                const textsToEmbed = batch.map(a => {
                    const cleanSnippet = cleanText(a.contentSnippet || a.snippet || '');
                    return `${a.title}. ${cleanSnippet}`.substring(0, 500);
                });

                try {
                    const output = await pipe(textsToEmbed, { pooling: 'mean', normalize: true });
                    const embeddingDim = output.dims[1];
                    for (let j = 0; j < batch.length; j++) {
                        const embedding = output.data.subarray(j * embeddingDim, (j + 1) * embeddingDim);
                        embeddedArticles.push({ ...batch[j], embedding: Array.from(embedding) });
                    }
                } catch (localErr) {
                    aiLogger.error(`Local fallback also failed: ${localErr.message}`);
                    // If everything fails, we still need to keep the structure but without embedding (or skip)
                }
            }
        }
    } else {
        // Pure Local Mode
        const pipe = await getExtractor();
        aiLogger.info(`Embedding ${articles.length} articles using local CPU...`);

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
                    embeddedArticles.push({ ...batch[j], embedding: Array.from(embedding) });
                }
            } catch (e) {
                aiLogger.error(`Local Batch error at index ${i}: ${e.message}`);
            }
        }
    }

    aiLogger.info(`Embedding Done for ${embeddedArticles.length} articles. Time: ${(Date.now() - totalStart) / 1000}s`);
    return embeddedArticles;
}

/**
 * Generates an embedding for a single string (intent).
 */
async function embedText(text) {
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
            const res = await model.embedContent(text);
            return res.embedding.values;
        } catch (e) {
            aiLogger.warn(`Cloud intent embedding failed, falling back to local: ${e.message}`);
        }
    }

    const pipe = await getExtractor();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

/**
 * Sorts and filters a list of articles based on semantic similarity to the user intent.
 * Now optionally accepts pre-embedded articles.
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 500, precomputedIntentEmbedding = null) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    
    // 1. Get Intent Embedding
    const intentEmbedding = precomputedIntentEmbedding || await embedText(userIntent);

    // 2. Ensure articles have embeddings
    let articlesWithEmbeddings = [];
    if (articles[0] && articles[0].embedding) {
        articlesWithEmbeddings = articles;
    } else {
        articlesWithEmbeddings = await embedArticles(articles);
    }

    // 3. Score
    const scoredArticles = articlesWithEmbeddings.map(a => {
        if (!a.embedding) return { ...a, relevanceScore: 0 };
        const score = cosineSimilarity(intentEmbedding, a.embedding);
        return { ...a, relevanceScore: score };
    });

    // 4. Strict Filtering & Sorting
    const keptArticles = scoredArticles
        .filter(a => a.relevanceScore >= MIN_RELEVANCE_SCORE)
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

    const discardedArticles = scoredArticles
        .filter(a => a.relevanceScore < MIN_RELEVANCE_SCORE)
        .sort((a, b) => b.relevanceScore - a.relevanceScore);

    if (keptArticles.length > 0) {
        const highest = keptArticles[0];
        aiLogger.info(`[Intent Match] Highest: "${highest.title}" (${highest.relevanceScore.toFixed(4)})`);
    }

    aiLogger.info(`Relevance Check Done: Kept ${keptArticles.length}/${articles.length}.`);
    return keptArticles.slice(0, topK);
}

module.exports = { filterArticlesByRelevanceLocal, embedArticles, embedText };