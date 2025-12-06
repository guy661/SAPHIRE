import { Worker as BullMQWorker } from 'bullmq';
import redisConnection from '../redis.mjs';
import queues from '../queues.mjs';
import * as db from '../database-postgres.js';
import { semanticClusteringTask } from '../task.js'; // IMPORT CHANGED
import { Logger, EMOJIS } from '../utils.js';

const logger = new Logger('SemanticWorker', 'magenta', EMOJIS.semantic);
const bullLogger = new Logger('BullMQ', 'red', EMOJIS.bull);
const { synthesisQueue } = queues;

const worker = new BullMQWorker('semantic-summary', async (job) => {
    const { jobId, articles, user_intent, language, userId, dashboardId } = job.data;
    logger.info(`Job ${job.id}: Starting semantic clustering for ${articles.length} articles.`);

    try {
        await db.updateJobStatus(jobId, 'semantic_check');
        
        // 1. Pre-filter: Remove obviously empty/short content
        const candidates = articles.filter(a => a.fetchedContent && a.fetchedContent.content.length >= 100);
        
        if (candidates.length === 0) {
             logger.warn(`No valid articles to process for job ${jobId}.`);
             await db.updateJobStatus(jobId, 'failed', 'No valid content found.');
             return;
        }

        // 2. AI Clustering
        // We send all candidates at once (up to ~50 articles fits in context)
        // If we had >100, we might need chunking, but for 50 it's fine.
        
        const clusters = await semanticClusteringTask({
            data: { articles: candidates, user_intent, language }
        });

        logger.info(`AI processing complete. Analyzed ${candidates.length} articles against intent: "${user_intent.substring(0, 50)}..."`);

        if (clusters.length === 0) {
            logger.warn(`No relevant clusters found for job ${jobId}. Marking as failed.`);
            await db.updateJobStatus(jobId, 'failed', 'No relevant topics found.');
            return;
        }

        // 3. Re-structure data for Synthesis
        // Instead of sending a flat list, we send the grouped structure.
        // The Synthesis worker needs to be adapted to handle this "pre-clustered" data.
        // For now, we will FLATTEN it back but attach the 'clusterTitle' so Synthesis can use it.
        
        const clusteredArticles = [];
        let keptClustersCount = 0;
        let discardedClustersCount = 0;
        
        clusters.forEach(cluster => {
            const clusterArticles = cluster.article_ids.map(id => candidates[id]).filter(Boolean);
            const articleTitles = clusterArticles.map(a => `"${a.fetchedContent.title}"`).join(', ');

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
             logger.warn(`No relevant articles remained after AI filtering for job ${jobId}. Marking as failed.`);
             await db.updateJobStatus(jobId, 'failed', 'No relevant content found after AI filter.');
             return;
        }

        await synthesisQueue.add('synthesize', {
            jobId,
            dashboardId,
            userId,
            articles: clusteredArticles,
            user_intent,
            language
        });

        await db.updateJobStatus(jobId, 'synthesizing');
        logger.info(`Job ${job.id}: Queued ${clusteredArticles.length} articles in ${clusters.length} clusters for synthesis.`);

        return { success: true, clusters: clusters.length, articles: clusteredArticles.length };

    } catch (err) {
        logger.error(`Job ${job.id}: CRITICAL ERROR in semantic worker.`, err);
        await db.updateJobStatus(jobId, 'failed', err.message);
        throw err;
    }
}, { 
    connection: redisConnection,
    concurrency: 2 // Lower concurrency as this is a heavy task
});

worker.on('completed', (job, result) => {
    bullLogger.info(`Job ${job.id} in 'semantic-summary' completed. Found ${result.clusters} clusters.`);
});

worker.on('failed', (job, err) => {
    bullLogger.error(`Job ${job.id} in 'semantic-summary' failed.`, err);
});

logger.info('Semantic Worker started and listening for jobs.');

export default worker;
