import { Worker as BullMQWorker } from 'bullmq';
import redisConnection from '../redis.mjs';
import db from '../database-postgres.js';
import { extractArticleText } from '../article-parser.js';
import { generateClusterAnalysisTask, generateSynthesizedSummaryTask } from '../task.js';
import { Logger, EMOJIS } from '../utils.js';
import { pipeline, cos_sim } from '@xenova/transformers';

import { getApiKeyCount } from '../utils.js';

const synthesisLogger = new Logger('SynthesisWorker', 'yellow', EMOJIS.worker);

// --- Model Pipeline Setup ---
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
const SIMILARITY_THRESHOLD = 0.8;

const generateEmbeddings = async (texts) => {
    const embeddings = await extractor(texts, { pooling: 'mean', normalize: true });
    return embeddings.tolist();
};

// --- Worker Definition ---
const synthesisWorker = new BullMQWorker('synthesis', async (job) => {
    const { jobId, articles, user_intent, language } = job.data;
    synthesisLogger.info(`Starting synthesis for job ${jobId} with ${articles.length} articles.`);

    try {
        // Step 1 is now removed (fetching done separately).

        // --- Step 2: Cluster Articles and Save to DB ---
        const articlesWithClusterId = [];
        
        // Check if we have AI-generated clusters from the previous step
        const hasAIClusters = articles.length > 0 && articles[0].aiClusterTitle;

        if (hasAIClusters) {
            synthesisLogger.info('Using AI-generated clusters...');
            
            // Map cluster titles to DB IDs
            const titleToClusterId = new Map();

            for (const article of articles) {
                const clusterTitle = article.aiClusterTitle || 'Sonstiges';
                
                let clusterId = titleToClusterId.get(clusterTitle);
                if (!clusterId) {
                    // Create new cluster in DB with the AI title
                    const newCluster = await db.createCluster(clusterTitle);
                    clusterId = newCluster.id;
                    titleToClusterId.set(clusterTitle, clusterId);
                }

                await db.createArticle(jobId, article, clusterId, article.sourceName || 'Unknown');
                articlesWithClusterId.push({ ...article, clusterId });
            }

        } else {
            // FALLBACK: Old Embedding-based Clustering
            synthesisLogger.info('No AI clusters found. Falling back to embedding-based clustering...');
            
            const recentClusters = await db.getRecentClusters('48 hours');
            const articleTitles = articles.map(a => a.title);
            const articleEmbeddings = await generateEmbeddings(articleTitles);
            
            let clusterEmbeddings = [];
            if (recentClusters.length > 0) {
                clusterEmbeddings = await generateEmbeddings(recentClusters.map(c => c.representative_title));
            }

            for (let i = 0; i < articles.length; i++) {
                const article = articles[i];
                const articleEmbedding = articleEmbeddings[i];
                let bestMatch = { clusterId: null, score: -1 };

                for (let j = 0; j < recentClusters.length; j++) {
                    const clusterId = recentClusters[j].id;
                    const score = cos_sim(articleEmbedding, clusterEmbeddings[j]);
                    if (score > bestMatch.score) {
                        bestMatch = { clusterId, score };
                    }
                }

                let assignedClusterId;
                if (bestMatch.score > SIMILARITY_THRESHOLD) {
                    assignedClusterId = bestMatch.clusterId;
                    await db.touchCluster(assignedClusterId);
                } else {
                    const newCluster = await db.createCluster(article.title);
                    assignedClusterId = newCluster.id;
                    recentClusters.push({ id: assignedClusterId, representative_title: article.title });
                    clusterEmbeddings.push(articleEmbedding);
                }
                await db.createArticle(jobId, article, assignedClusterId, article.sourceName || 'Unknown');
                articlesWithClusterId.push({ ...article, clusterId: assignedClusterId });
            }
        }
        
        synthesisLogger.info('Clustering complete. All articles saved to database.');
        
        // --- Step 3: Perform Analysis on Each Cluster ---
        // synthesisLogger.info('Starting analysis for each cluster...');
        const articlesByCluster = articlesWithClusterId.reduce((acc, article) => {
            if (!acc[article.clusterId]) {
                acc[article.clusterId] = [];
            }
            acc[article.clusterId].push(article);
            return acc;
        }, {});
        
        // Process clusters in chunks to respect rate limits
        const clusterEntries = Object.entries(articlesByCluster);
        const analysisResults = [];
        const CHUNK_SIZE = getApiKeyCount() || 1; // Limit concurrency to API key count

        for (let i = 0; i < clusterEntries.length; i += CHUNK_SIZE) {
            const chunk = clusterEntries.slice(i, i + CHUNK_SIZE);
            const chunkResults = await Promise.all(
                chunk.map(async ([clusterId, clusterArticles]) => {
                    const analysisResult = await generateClusterAnalysisTask({
                        data: {
                            articles: clusterArticles,
                            user_intent,
                            language
                        }
                    });
                    await db.updateClusterWithAnalysis(clusterId, analysisResult);
                    // synthesisLogger.info(`Analysis for cluster ${clusterId} saved.`);
                    // Return the result for the next step
                    return { ...analysisResult, title: clusterArticles[0]?.title || 'Unbekanntes Thema' };
                })
            );
            analysisResults.push(...chunkResults);
            
            // Small delay between chunks if there are more to process
            if (i + CHUNK_SIZE < clusterEntries.length) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        // synthesisLogger.info('All cluster analyses complete.');

        // --- Step 4: Generate Final Meta-Summary (Summary of Summaries) ---
        // synthesisLogger.info('Generating final meta-summary from cluster summaries...');
        
        // NEW: Get user feedback and history context
        const { userId, dashboardId } = job.data;
        const userContext = await db.getFeedbackAndHistory(userId, dashboardId);
        
        // NEW: Get the full summary text of the last completed job for context
        const lastJob = await db.getLatestCompletedJobForDashboard(dashboardId);
        const previousSummary = lastJob ? lastJob.meta_summary : null;

        // synthesisLogger.info(`Context for user ${userId}: ${userContext.likedClusterIds.length} likes, ${userContext.dislikedClusterIds.length} dislikes, ${userContext.previousClusterIds.length} previous clusters.`);

        // Adapt cluster summaries to the format expected by generateSynthesizedSummaryTask
        const fakeArticlesForMetaSummary = analysisResults.map(res => ({
            link: 'http://localhost/cluster-summary', // Dummy link, not used in the prompt logic itself
            fetchedContent: {
                title: res.title,
                content: res.summary
            },
            // Pass cluster ID along for context matching
            clusterId: Object.keys(articlesByCluster).find(key => articlesByCluster[key][0].title === res.title)
        }));

        const metaSummary = await generateSynthesizedSummaryTask({
            data: {
                articles: fakeArticlesForMetaSummary,
                user_intent,
                language,
                currentDate: new Date().toLocaleDateString('de-DE'),
                // Pass the new context to the task
                userContext,
                previousSummary // Pass the text of the last summary
            }
        });
        await db.updateJobMetaSummary(jobId, metaSummary);
        synthesisLogger.info('Final meta-summary saved.');


        // --- Step 5: Finalize Job ---
        await db.updateJobStatus(jobId, 'completed');
        
        synthesisLogger.info(`Synthesis job ${jobId} completed successfully.`);

    } catch (error) {
        synthesisLogger.error(`An error occurred during synthesis for job ${jobId}:`, error);
        await db.updateJobStatus(jobId, 'failed');
        // No meta summary to update in case of error
        throw error;
    }
}, { connection: redisConnection });

synthesisLogger.info('Synthesis worker started and listening for jobs.');

export default synthesisWorker;
