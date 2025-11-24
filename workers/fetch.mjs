import { Worker } from 'bullmq';
import redisConnection from '../redis.mjs';
import queues from '../queues.mjs';
import * as db from '../database-postgres.js';
import { getArticleUrl, extractArticleText, PaywallError } from '../article-parser.js'; // PaywallError re-added to import
import { Logger, EMOJIS } from '../utils.js';

const logger = new Logger('Fetch Worker', 'blue', EMOJIS.fetch);
const bullLogger = new Logger('BullMQ', 'red', EMOJIS.bull);

const { semanticSummaryQueue } = queues;

const worker = new Worker('fetch', async (job) => {
    const { articleId, url: googleUrl, userId } = job.data; // Changed url to googleUrl for clarity
    logger.info(`Job ${job.id}: Processing articleId ${articleId}, url: ${googleUrl}`);

    let realUrl = googleUrl; // Initialize

    try {
        await db.updateArticleStatus(articleId, 'processing');

        // 1. Get the real article URL from the Google News redirect URL (re-added)
        logger.info(`Job ${job.id}: Google News URL detected. Extracting real URL...`);
        realUrl = await getArticleUrl(googleUrl); // Use the separate getArticleUrl
        logger.info(`Job ${job.id}: Real article URL: ${realUrl}`);
        
        // Update the article with the real URL right away for better tracking
        // (content and title will be empty for now, updated after extraction)
        await db.updateArticleContent(articleId, '', '', realUrl);


        // 2. Extract the article text and title (reverted to single call returning object)
        logger.info(`Job ${job.id}: Parsing content from real URL...`);
        const { title, content, finalUrl } = await extractArticleText(realUrl); // Call extractArticleText
        
        // No explicit content length check here, as extractArticleText now throws PaywallError for too short content
        
        logger.info(`Job ${job.id}: Content extracted. Length: ${content.length}`);
        
        // 3. Update the database with the content, title, and final URL
        await db.updateArticleContent(articleId, content, title, finalUrl);


        // 4. Get user's language preference and topic for the next stage
        const user = await db.getUserById(userId);
        if (!user) throw new Error(`Could not find user with userId ${userId}.`);
        
        const userTopic = await db.getTopicByUserId(user.id);
        if (!userTopic) throw new Error(`Could not find topic for userId ${userId}.`);

        // 5. Queue the article for the semantic summary stage
        await semanticSummaryQueue.add('semantic-summary', {
            articleId,
            userTopic,
            language: user?.language || 'de'
        });

        logger.info(`Job ${job.id}: Successfully processed and queued for semantic summary: ${articleId}`);
        return { success: true, finalUrl: realUrl }; // Use realUrl as finalUrl

    } catch (err) {
        // PaywallError specific handling re-added
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
    // Concurrency reverted to 10
    concurrency: 10
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