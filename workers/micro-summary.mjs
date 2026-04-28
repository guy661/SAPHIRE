import { Worker as BullMQWorker } from 'bullmq';
import redisConnection from '../redis.mjs';
import db from '../database-postgres.js';
import { generateMicroSummaryTask } from '../task.js';
import { Logger, EMOJIS } from '../utils.js';

const summaryLogger = new Logger('MicroSummary', 'magenta', EMOJIS.worker);

const microSummaryWorker = new BullMQWorker('micro-summary', async (job) => {
    const { dashboardArticleId, dashboardId, userIntent, article } = job.data;
    
    summaryLogger.info(`Processing micro-summary for article: "${article.title}" (Dashboard ${dashboardId})`);

    try {
        // --- RECYCLING LOGIC ---
        // Check if we already summarized this link for another dashboard or user
        const existingSummary = await db.findExistingSummaryByLink(article.link);
        
        if (existingSummary) {
            summaryLogger.info(`[Recycling] Re-using existing summary for: ${article.link}`);
            await db.updateDashboardArticleSummary(dashboardArticleId, existingSummary);
            return;
        }

        // Only if no summary exists, we ask the AI
        const microSummary = await generateMicroSummaryTask({
            data: { article, user_intent: userIntent, language: 'de' }
        });

        await db.updateDashboardArticleSummary(dashboardArticleId, microSummary);
        summaryLogger.info(`Successfully generated new micro-summary for article ${dashboardArticleId}`);

    } catch (error) {
        summaryLogger.error(`Error processing micro-summary for article ${dashboardArticleId}:`, error);
        throw error;
    }
}, { connection: redisConnection });

summaryLogger.info('Micro-Summary worker started and listening for jobs.');

export default microSummaryWorker;
