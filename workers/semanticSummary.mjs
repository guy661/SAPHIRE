
import { Worker } from 'bullmq';
import redisConnection from '../redis.mjs';
import * as db from '../database-postgres.js';
import { semanticCheckTask } from '../task.js';
import { retry, Logger, EMOJIS } from '../utils.js';

const logger = new Logger('Semantic Worker', 'magenta', EMOJIS.semantic);
const bullLogger = new Logger('BullMQ', 'red', EMOJIS.bull);


const worker = new Worker('semantic-summary', async (job) => {
    const { articleId, userTopic, language } = job.data;
    logger.info(`Job ${job.id}: Processing articleId ${articleId}`);

    let article;
    try {
        // 1. Get the full article from the database
        article = await db.getArticle(articleId);
        if (!article || !article.content) {
            throw new Error(`Article ${articleId} or its content is missing from the database.`);
        }

        // 2. Perform the semantic check
        logger.info(`Starting semantic check for: ${article.link} (Lang: ${language})`);
        const semanticCheckResult = await retry(
            () => semanticCheckTask({ data: { article, userTopic, language, currentDate: new Date().toISOString() } }), 
            2, 
            2000
        );

        const { is_relevant, reason } = semanticCheckResult;
        logger.info(`Article ${articleId} is ${is_relevant ? '' : 'NOT '}relevant. Reason: ${reason}`);

        // 3. Update the database with the relevance result. This also sets the status to 'completed'.
        await db.updateArticleSemanticRelevance(articleId, is_relevant, reason);

        logger.info(`Job ${job.id}: Successfully processed and saved article ${articleId}.`);
        return { success: true, relevant: is_relevant };

    } catch (err) {
        logger.error(`Job ${job.id}: CRITICAL ERROR processing article ${articleId}.`, err);
        if (articleId) {
            await db.updateArticleStatus(articleId, 'failed', err.message);
        }
        throw err; // Let BullMQ know the job failed
    }
}, { 
    connection: redisConnection,
    concurrency: 4 // As requested by the user
});

worker.on('completed', (job, result) => {
    bullLogger.info(`Job ${job.id} in 'semantic-summary' has completed. Relevant: ${result.relevant}`);
});

worker.on('failed', (job, err) => {
    bullLogger.error(`Job ${job.id} in 'semantic-summary' has failed.`, err);
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
