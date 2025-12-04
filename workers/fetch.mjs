import { Worker } from 'bullmq';
import redisConnection from '../redis.mjs';
import queues from '../queues.mjs';
import * as db from '../database-postgres.js';
import { getArticleUrl, extractArticleText, PaywallError } from '../article-parser.js';
import pkg from '../task.js';
const { headlineCheckTask } = pkg;
import { Logger, EMOJIS, getApiKeyCount } from '../utils.js';

const logger = new Logger('Fetch Worker', 'blue', EMOJIS.fetch);
const bullLogger = new Logger('BullMQ', 'red', EMOJIS.bull);

const { semanticSummaryQueue } = queues;

// Dynamically set concurrency and rate limiting based on the number of API keys
const apiKeyCount = getApiKeyCount();
if (apiKeyCount === 0) {
    logger.error('No GEMINI_API_KEYS found in .env file. The fetch worker cannot start.');
    process.exit(1);
}

const concurrency = process.env.FETCH_WORKER_CONCURRENCY ? parseInt(process.env.FETCH_WORKER_CONCURRENCY, 10) : apiKeyCount;

logger.info(`Setting worker concurrency to ${concurrency}. (Source: ${process.env.FETCH_WORKER_CONCURRENCY ? 'env' : 'apiKeyCount'})`);

const worker = new Worker('fetch', async (job) => {
    const { articleId, url: googleUrl, dashboardId } = job.data;
    logger.info(`Job ${job.id}: Processing articleId ${articleId} for dashboardId ${dashboardId}`);

    let realUrl = googleUrl;

    try {
        await db.updateArticleStatus(articleId, 'processing');

        // 1. Get the real article URL
        realUrl = await getArticleUrl(googleUrl);
        logger.info(`Job ${job.id}: Real article URL: ${realUrl}`);
        
        await db.updateArticleContent(articleId, '', '', realUrl);

        // 2. Extract the article text and title
        logger.info(`Job ${job.id}: Parsing content from real URL...`);
        const { title, content, finalUrl } = await extractArticleText(realUrl);
        
        if (!content || content.trim().length === 0) {
            const failureReason = 'Extracted content was empty or null.';
            logger.warn(`Job ${job.id}: ${failureReason} for article ${articleId}.`);
            await db.updateArticleStatus(articleId, 'failed', failureReason);
            return { success: false, finalUrl: realUrl, reason: failureReason };
        }
        
        logger.info(`Job ${job.id}: Content extracted. Length: ${content.length}`);
        
        // 3. Update the database with the extracted content
        await db.updateArticleContent(articleId, content, title, finalUrl);

        // 4. Get dashboard and user info for the next stages
        const dashboard = await db.getDashboardById(dashboardId);
        if (!dashboard || !dashboard.user_intent) {
            throw new Error(`Could not find dashboard or user_intent for dashboardId ${dashboardId}.`);
        }
        
        const user = await db.getUserById(dashboard.user_id);
        if (!user) {
            throw new Error(`Could not find user with userId ${dashboard.user_id}.`);
        }

        // 5. Perform headline pre-check for cost saving
        const headlineCheck = await headlineCheckTask({
            data: {
                articleTitle: title,
                userTopic: dashboard.user_intent,
                language: user.language || 'de'
            }
        });

        if (!headlineCheck.is_headline_relevant) {
            const reason = 'Article headline deemed irrelevant during pre-check.';
            logger.info(`Job ${job.id}: ${reason} for article ${articleId}. Stopping processing.`);
            await db.updateArticleSemanticRelevance(articleId, false, reason);
            return { success: true, finalUrl: realUrl, relevant: false, reason: reason };
        }

        // 6. Queue the article for the full semantic summary stage
        await semanticSummaryQueue.add('semantic-summary', {
            articleId,
            userTopic: dashboard.user_intent,
            language: user.language || 'de'
        });

        logger.info(`Job ${job.id}: Successfully processed and queued for semantic summary: ${articleId}`);
        return { success: true, finalUrl: realUrl, relevant: true };

    } catch (err) {
        if (err instanceof PaywallError) {
            logger.warn(`Job ${job.id}: Paywall detected for article ${articleId}. Marking as failed.`);
            await db.updateArticleStatus(articleId, 'failed', `Paywall detected: ${err.message}`);
        } else {
            logger.error(`Job ${job.id}: FAILED to process article ${articleId}.`, err);
            await db.updateArticleStatus(articleId, 'failed', err.message);
        }
        throw err;
    }

}, {
    connection: redisConnection,
    concurrency: concurrency
});

worker.on('completed', (job, result) => {
    bullLogger.info(`Job ${job.id} in 'fetch' has completed. Final URL: ${result.finalUrl}`);
});

worker.on('failed', (job, err) => {
    bullLogger.error(`Job ${job.id} in 'fetch' has failed. Reason: ${err.message}`);
});

logger.info('Worker started and listening for jobs.');

// Graceful shutdown
const gracefulShutdown = async () => {
    logger.warn('Shutting down gracefully...');
    await worker.close();
    process.exit(0);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);