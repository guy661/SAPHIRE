import { Worker as BullMQWorker } from 'bullmq';
import redisConnection from '../redis.mjs';
import queues from '../queues.mjs';
import * as db from '../database-postgres.js';
import pkg from '../task.js';
const { semanticClusteringTask } = pkg;
import { Logger, EMOJIS } from '../utils.js';

const logger = new Logger('SemanticWorker', 'magenta', EMOJIS.semantic);
const bullLogger = new Logger('BullMQ', 'red', EMOJIS.bull);
const { fetchAllQueue } = queues;

const worker = new BullMQWorker('semantic-summary', async (job) => {
    const { jobId, articles, user_intent, language, userId, dashboardId } = job.data;
    logger.info(`Job ${job.id}: Starting semantic clustering (Headline Scan) for ${articles.length} articles.`);

    try {
        await db.updateJobStatus(jobId, 'semantic_check');
        
        // 1. No Pre-filter based on content length anymore, as we only have headlines.
        const candidates = articles; // Raw RSS items
        
        if (candidates.length === 0) {
             logger.warn(`No articles to process for job ${jobId}.`);
             await db.updateJobStatus(jobId, 'failed', 'No articles found.');
             return;
        }

        // 2. AI Clustering on Headlines
        
        // Fetch last job timestamp for temporal filtering
        const lastJob = await db.getLatestCompletedJobForDashboard(dashboardId);
        const lastSummaryTime = lastJob ? lastJob.created_at : null;

        const clusters = await semanticClusteringTask({
            data: { 
                articles: candidates, 
                user_intent, 
                language,
                currentDate: new Date().toLocaleString(),
                lastSummaryTime: lastSummaryTime ? new Date(lastSummaryTime).toLocaleString() : null
            }
        });

        logger.info(`AI processing complete. Analyzed ${candidates.length} headlines against intent: "${user_intent.substring(0, 50)}..."`);

        if (clusters.length === 0) {
            logger.warn(`No relevant clusters found for job ${jobId}. Marking as failed.`);
            await db.updateJobStatus(jobId, 'failed', 'No relevant topics found.');
            return;
        }

        // 3. Re-structure data for Fetching
        const clusteredArticles = [];
        let keptClustersCount = 0;
        let discardedClustersCount = 0;
        
        clusters.forEach(cluster => {
            const clusterArticles = cluster.article_ids.map(id => candidates[id]).filter(Boolean);
            const articleTitles = clusterArticles.map(a => `"${a.title}"`).join(', ');

            // Filter based on AI's relevance decision
            if (cluster.is_relevant_to_intent) {
                keptClustersCount++;
                logger.info(`[✅ KEPT] Cluster: "${cluster.title}" (${clusterArticles.length} articles). Reason: ${cluster.reason || 'No reason provided.'} | Articles: ${articleTitles}`);
                
                clusterArticles.forEach(article => {
                    clusteredArticles.push({
                        ...article,
                        aiClusterTitle: cluster.title
                    });
                });
            } else {
                discardedClustersCount++;
                logger.info(`[❌ DROPPED] Cluster: "${cluster.title}" (${clusterArticles.length} articles). Reason: ${cluster.reason || 'No reason provided.'} | Articles: ${articleTitles}`);
            }
        });
        
        logger.info(`Filtering summary: Kept ${keptClustersCount} clusters (${clusteredArticles.length} articles), Discarded ${discardedClustersCount} clusters.`);

        if (clusteredArticles.length === 0) {
             logger.warn(`No relevant articles remained after AI headline filter for job ${jobId}. Marking as failed.`);
             await db.updateJobStatus(jobId, 'failed', 'No relevant content found after AI filter.');
             return;
        }

        // Push to FETCH queue now
        await fetchAllQueue.add('fetch-all', {
            jobId,
            dashboardId,
            userId,
            articles: clusteredArticles, // These now have 'aiClusterTitle'
            user_intent,
            language
        });

        await db.updateJobStatus(jobId, 'fetching'); // Next step is fetching
        logger.info(`Job ${job.id}: Queued ${clusteredArticles.length} articles in ${keptClustersCount} clusters for fetching.`);

        return { success: true, clusters: keptClustersCount, articles: clusteredArticles.length };

    } catch (err) {
        logger.error(`Job ${job.id}: CRITICAL ERROR in semantic worker.`, err);
        await db.updateJobStatus(jobId, 'failed', err.message);
        throw err;
    }
}, { 
    connection: redisConnection,
    concurrency: 5 // Can be higher now as it's just LLM calls, no scraping
});

worker.on('completed', (job, result) => {
    bullLogger.info(`Job ${job.id} in 'semantic-summary' completed. Found ${result.clusters} clusters.`);
});

worker.on('failed', (job, err) => {
    bullLogger.error(`Job ${job.id} in 'semantic-summary' failed.`, err);
});

logger.info('Semantic Worker (Headline Filter) started and listening for jobs.');

export default worker;