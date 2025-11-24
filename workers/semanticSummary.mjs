
import { Worker } from 'bullmq';
import redisConnection from '../redis.mjs';
import * as db from '../database-postgres.js';
import { summarizeArticleTask, semanticCheckTask } from '../task.js';
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

        // 2. Perform the semantic check first to see if the article is relevant
        logger.info(`Starting semantic check for: ${article.link} (Lang: ${language})`);
        const semanticCheckResult = await retry(
            () => semanticCheckTask({ data: { article, userTopic, language } }), 
            2, 
            2000
        );

        const { is_relevant, reason } = semanticCheckResult;
        logger.info(`Article ${articleId} is ${is_relevant ? '' : 'NOT '}relevant. Reason: ${reason}`);

        // 3. If not relevant, update and stop.
        if (!is_relevant) {
            await db.updateArticleSemanticRelevance(articleId, false, reason);
            logger.info(`Job ${job.id}: Finished. Article marked as not relevant.`);
            return { success: true, relevant: false };
        }

        // 4. If relevant, proceed with summarization.
        logger.info(`Starting summary for relevant article: ${article.link}`);
        
        const jobInfo = await db.getJob(article.job_id);
        const summaryStyle = jobInfo.summary_style || 'paragraph';
        
        const summaryResult = await retry(
            () => summarizeArticleTask({ data: { article, language, style: summaryStyle } }),
            3,
            2000
        );
        const { summary } = summaryResult;

        // 5. Update the database with all the results.
        logger.info(`Job ${job.id}: Saving final results to database for article ${articleId}.`);
        await db.updateArticleSummary(articleId, summary);
        await db.updateArticleSemanticRelevance(articleId, true, reason); // This sets status to 'completed'

        logger.info(`Job ${job.id}: Successfully processed and saved article ${articleId}.`);
        return { success: true, relevant: true };

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
