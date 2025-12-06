import { Worker as BullMQWorker } from 'bullmq';
import redisConnection from '../redis.mjs';
import queues from '../queues.mjs';
import * as db from '../database-postgres.js';
import { getArticleUrl, extractArticleText } from '../article-parser.js';
import { Logger, EMOJIS } from '../utils.js';

const logger = new Logger('FetchAllWorker', 'blue', EMOJIS.fetch);
const bullLogger = new Logger('BullMQ', 'red', EMOJIS.bull);

const { semanticQueue } = queues;

const worker = new BullMQWorker('fetch-all', async (job) => {
    const { jobId, articles, user_intent, language, userId, dashboardId } = job.data;
    logger.info(`Job ${job.id}: Starting fetch-all for job ${jobId} with ${articles.length} articles.`);

    try {
        await db.updateJobStatus(jobId, 'fetching');

        const fetchPromises = articles.map(async (article) => {
            let targetUrl = article.link;
            try {
                // FIX: Pre-resolve Google News URLs before extracting content
                if (article.link.includes('news.google.com')) {
                    // logger.debug(`Resolving Google URL: ${article.link}`);
                    targetUrl = await getArticleUrl(article.link);
                    // logger.debug(`Resolved to: ${targetUrl}`);
                }
                
                const content = await extractArticleText(targetUrl);
                return { ...article, fetchedContent: content, finalUrl: targetUrl, status: 'fulfilled' };

            } catch (error) {
                logger.error(`Failed to process article ${targetUrl} (Original: ${article.link}). Reason: ${error.message}`);
                return { ...article, status: 'rejected', reason: error.message };
            }
        });

        const results = await Promise.all(fetchPromises);
        const successfullyFetched = results.filter(r => r.status === 'fulfilled');

        if (successfullyFetched.length === 0) {
            logger.warn(`No articles could be fetched for job ${jobId}. Marking as failed.`);
            await db.updateJobStatus(jobId, 'failed');
            return;
        }
        
        
        logger.info(`Successfully fetched ${successfullyFetched.length}/${articles.length} articles. Queuing for semantic check.`);

        await semanticQueue.add('semantic-summary', {
            jobId: jobId,
            dashboardId: dashboardId,
            userId: userId,
            articles: successfullyFetched,
            user_intent: user_intent,
            language: language
        });

        await db.updateJobStatus(jobId, 'semantic_check');

        logger.info(`Job ${job.id}: Successfully queued for semantic check.`);
        return { success: true, fetchedCount: successfullyFetched.length };

    } catch (err) {
        logger.error(`Job ${job.id}: CRITICAL FAILED to process job ${jobId}.`, err);
        await db.updateJobStatus(jobId, 'failed', err.message);
        throw err;
    }

}, {
    connection: redisConnection,
    concurrency: 10
});

worker.on('completed', (job, result) => {
    bullLogger.info(`Job ${job.id} in 'fetch-all' has completed. Fetched ${result.fetchedCount} articles.`);
});

worker.on('failed', (job, err) => {
    bullLogger.error(`Job ${job.id} in 'fetch-all' has failed. Reason: ${err.message}`);
});

logger.info('Fetch-All worker started and listening for jobs.');
