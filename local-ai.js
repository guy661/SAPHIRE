const { pipeline, env } = require('@xenova/transformers');
const { Logger, EMOJIS } = require('./utils');
const path = require('path');

// --- MAXIMALE SPEICHER-BEGRENZUNG ---
env.allowLocalModels = true;
env.useBrowserCache = false;

// Wir setzen einen expliziten Cache-Pfad in einem Unterordner des Projekts,
// um zu verhindern, dass /home/render/.cache (Standard auf Linux/Render) überläuft.
const CACHE_DIR = path.join(__dirname, '.model_cache');
env.cacheDir = CACHE_DIR;

const aiLogger = new Logger('AI-Filter', 'cyan', EMOJIS.semantic);

// Strictness threshold. 
const MIN_RELEVANCE_SCORE = 0.30; 

// Cache the local model globally
let extractor = null;

async function getExtractor() {
    if (!extractor) {
        aiLogger.info(`Loading local embedding model... (Cache: ${CACHE_DIR})`);
        try {
            // Wir erzwingen die Nutzung von FP16 oder Quantized, um RAM zu sparen
            extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
                quantized: true,
                // Revision stellt sicher, dass wir eine stabile Version nutzen
                revision: 'main',
            });
            aiLogger.info('Local multilingual model loaded successfully.');
        } catch (err) {
            aiLogger.error(`Failed to load model: ${err.message}`);
            // Wenn der lokale Download fehlschlägt, ist oft der Storage voll
            if (err.message.includes('ENOSPC')) {
                aiLogger.error('DISK SPACE OVERLOAD: The model cache is full.');
            }
            throw err;
        }
    }
    return extractor;
}

// Helper to compute cosine similarity
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
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
 * Generates embeddings for a list of articles using local CPU. 
 */
async function embedArticles(articles) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    const embeddedArticles = [];

    const pipe = await getExtractor();
    
    // Wir reduzieren die Batch-Size NOCH weiter auf 4, um absolute Sicherheit zu haben
    const BATCH_SIZE = 4; 
    aiLogger.info(`Embedding ${articles.length} articles (Extremely small batch size: ${BATCH_SIZE})...`);

    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
        const batch = articles.slice(i, i + BATCH_SIZE);
        const textsToEmbed = batch.map(a => {
            const cleanSnippet = cleanText(a.contentSnippet || a.snippet || '');
            // Radikale Kürzung auf 200 Zeichen für maximale RAM-Schonung
            return `${a.title}. ${cleanSnippet}`.substring(0, 200);
        });

        try {
            // pooling: 'mean' sorgt für kleinere, konsistente Vektoren
            const output = await pipe(textsToEmbed, { pooling: 'mean', normalize: true });
            
            const embeddingDim = output.dims[1];
            for (let j = 0; j < batch.length; j++) {
                // Wir kopieren die Daten explizit aus dem Float32Array in ein normales Array
                const start = j * embeddingDim;
                const end = (j + 1) * embeddingDim;
                const embedding = Array.from(output.data.subarray(start, end));
                embeddedArticles.push({ ...batch[j], embedding: embedding });
            }
            
            // Garbage Collection Hint
            if (global.gc) {
                global.gc();
            }

        } catch (e) {
            aiLogger.error(`Local Batch error at index ${i}: ${e.message}`);
            // Bei einem Error in der Mitte brechen wir nicht ab, sondern machen mit dem nächsten Batch weiter
        }
    }

    aiLogger.info(`Embedding Done. Processed ${embeddedArticles.length} articles.`);
    return embeddedArticles;
}

/**
 * Generates an embedding for a single string.
 */
async function embedText(text) {
    try {
        const pipe = await getExtractor();
        const output = await pipe(text, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    } catch (err) {
        aiLogger.error(`Single text embedding failed: ${err.message}`);
        throw err;
    }
}

/**
 * Sorts and filters articles.
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 500, precomputedIntentEmbedding = null) {
    if (!articles || articles.length === 0) return [];

    try {
        const intentEmbedding = precomputedIntentEmbedding || await embedText(userIntent);

        let articlesWithEmbeddings = [];
        if (articles[0] && articles[0].embedding) {
            articlesWithEmbeddings = articles;
        } else {
            articlesWithEmbeddings = await embedArticles(articles);
        }

        const scoredArticles = articlesWithEmbeddings.map(a => {
            if (!a.embedding) return { ...a, relevanceScore: 0 };
            const score = cosineSimilarity(intentEmbedding, a.embedding);
            return { ...a, relevanceScore: score };
        });

        const keptArticles = scoredArticles
            .filter(a => a.relevanceScore >= MIN_RELEVANCE_SCORE)
            .sort((a, b) => b.relevanceScore - a.relevanceScore);

        aiLogger.info(`Relevance Check Done: Kept ${keptArticles.length}/${articles.length}.`);
        return keptArticles.slice(0, topK);
    } catch (err) {
        aiLogger.error(`Filter process failed: ${err.message}`);
        // Im Fehlerfall geben wir lieber die ungefilterten Artikel zurück (Notbetrieb) 
        // statt die ganze App abstürzen zu lassen.
        return articles.slice(0, topK);
    }
}

module.exports = { filterArticlesByRelevanceLocal, embedArticles, embedText };
