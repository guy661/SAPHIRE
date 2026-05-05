const { pipeline, env } = require('@xenova/transformers');
const { Logger, EMOJIS } = require('./utils');

// --- MAXIMALE SPEICHER-BEGRENZUNG ---
// Wir schalten native onnxruntime-node Module aus, wenn sie zu viel RAM fressen
// und nutzen stattdessen die WebAssembly-Version, die oft stabiler im RAM-Limit läuft.
env.allowLocalModels = true;
env.useBrowserCache = false;

// Wir begrenzen die Anzahl der Threads für ONNX, um CPU/RAM Spitzen zu vermeiden
// env.backends.onnx.wasm.numThreads = 1; 

const aiLogger = new Logger('AI-Filter', 'cyan', EMOJIS.semantic);

// Strictness threshold. 
const MIN_RELEVANCE_SCORE = 0.30; 

// Cache the local model globally
let extractor = null;

async function getExtractor() {
    if (!extractor) {
        aiLogger.info('Loading local embedding model (Xenova/paraphrase-multilingual-MiniLM-L12-v2)...');
        try {
            extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
                quantized: true,
            });
            aiLogger.info('Local multilingual model loaded successfully.');
        } catch (err) {
            aiLogger.error(`Failed to load model: ${err.message}`);
            throw err;
        }
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
 * Generates embeddings for a list of articles using local CPU. 
 */
async function embedArticles(articles) {
    if (!articles || articles.length === 0) return [];

    const totalStart = Date.now();
    const embeddedArticles = [];

    const pipe = await getExtractor();
    
    // Wir reduzieren die Batch-Size massiv, um RAM-Spitzen zu vermeiden
    const BATCH_SIZE = 8; 
    aiLogger.info(`Embedding ${articles.length} articles (Batch Size: ${BATCH_SIZE})...`);

    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
        const batch = articles.slice(i, i + BATCH_SIZE);
        const textsToEmbed = batch.map(a => {
            const cleanSnippet = cleanText(a.contentSnippet || a.snippet || '');
            return `${a.title}. ${cleanSnippet}`.substring(0, 300); // Noch kürzerer Text = kleinere Tensoren
        });

        try {
            const output = await pipe(textsToEmbed, { pooling: 'mean', normalize: true });
            
            // WICHTIG: Sofortige Konvertierung in normale JS-Arrays, um ONNX-Tensoren freizugeben
            const embeddingDim = output.dims[1];
            for (let j = 0; j < batch.length; j++) {
                const embedding = Array.from(output.data.subarray(j * embeddingDim, (j + 1) * embeddingDim));
                embeddedArticles.push({ ...batch[j], embedding: embedding });
            }
            
            // Kleiner manueller GC-Hint (hilft in Node manchmal)
            if (i % 32 === 0 && global.gc) {
                global.gc();
            }

        } catch (e) {
            aiLogger.error(`Local Batch error at index ${i}: ${e.message}`);
        }
    }

    aiLogger.info(`Embedding Done. Time: ${(Date.now() - totalStart) / 1000}s`);
    return embeddedArticles;
}

/**
 * Generates an embedding for a single string.
 */
async function embedText(text) {
    const pipe = await getExtractor();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
}

/**
 * Sorts and filters articles.
 */
async function filterArticlesByRelevanceLocal(articles, userIntent, topK = 500, precomputedIntentEmbedding = null) {
    if (!articles || articles.length === 0) return [];

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
}

module.exports = { filterArticlesByRelevanceLocal, embedArticles, embedText };
