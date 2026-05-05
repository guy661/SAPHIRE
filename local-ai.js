const { genAI, Logger, EMOJIS } = require('./utils');

const aiLogger = new Logger('AI-Filter', 'cyan', EMOJIS.semantic);

// Strictness threshold. 
const MIN_RELEVANCE_SCORE = 0.30; 

/**
 * Helper to compute cosine similarity (still needed for comparison, 
 * although Gemini embeddings are typically normalized).
 */
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
 * Generates embeddings using Gemini API (text-embedding-004).
 */
async function embedText(text) {
    if (!genAI) throw new Error('Gemini API not configured for embeddings');
    
    try {
        const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const result = await model.embedContent(text.substring(0, 8000)); // Gemini limit is high, but let's be safe
        return result.embedding.values;
    } catch (e) {
        aiLogger.error(`Gemini Embedding error: ${e.message}`);
        throw e;
    }
}

/**
 * Generates embeddings for multiple articles using Gemini API.
 */
async function embedArticles(articles) {
    if (!articles || articles.length === 0) return [];
    if (!genAI) throw new Error('Gemini API not configured for embeddings');

    const totalStart = Date.now();
    const embeddedArticles = [];
    const model = genAI.getGenerativeModel({ model: "text-embedding-004" });

    aiLogger.info(`Embedding ${articles.length} articles using Gemini API...`);

    // Gemini supports batch embedding
    const BATCH_SIZE = 100; 
    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
        const batch = articles.slice(i, i + BATCH_SIZE);
        const requests = batch.map(a => {
            const cleanSnippet = cleanText(a.contentSnippet || a.snippet || '');
            return { content: { parts: [{ text: `${a.title}. ${cleanSnippet}`.substring(0, 1000) }] } };
        });

        try {
            const result = await model.batchEmbedContents({ requests });
            result.embeddings.forEach((emb, index) => {
                embeddedArticles.push({ ...batch[index], embedding: emb.values });
            });
        } catch (e) {
            aiLogger.error(`Gemini Batch Embedding error at index ${i}: ${e.message}`);
        }
    }

    aiLogger.info(`Embedding Done for ${embeddedArticles.length} articles. Time: ${(Date.now() - totalStart) / 1000}s`);
    return embeddedArticles;
}

/**
 * Sorts and filters a list of articles based on semantic similarity using Gemini Embeddings.
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

    if (keptArticles.length > 0) {
        const highest = keptArticles[0];
        aiLogger.info(`[Intent Match] Highest: "${highest.title}" (${highest.relevanceScore.toFixed(4)})`);
    }

    aiLogger.info(`Relevance Check Done: Kept ${keptArticles.length}/${articles.length}.`);
    return keptArticles.slice(0, topK);
}

module.exports = { filterArticlesByRelevanceLocal, embedArticles, embedText };
