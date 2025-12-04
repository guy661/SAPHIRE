import { Worker } from 'bullmq';
import redisConnection from '../redis.mjs';
import db from '../database-postgres.js';
import { extractArticleText, PaywallError } from '../article-parser.js';
import { generateSynthesizedSummaryTask } from '../task.js';
import { Logger, EMOJIS } from '../utils.js';

const synthesisLogger = new Logger('SynthesisWorker', 'yellow', EMOJIS.worker);

const synthesisWorker = new Worker('synthesis', async (job) => {
    const { jobId, articles, user_intent, language, dashboardId } = job.data;
    synthesisLogger.info(`Starting synthesis for job ${jobId} with ${articles.length} articles.`);

    try {
        // Step 1: Fetch content for all articles in parallel
        const fetchPromises = articles.map(article => 
            extractArticleText(article.link)
                .then(content => ({ ...article, fetchedContent: content, status: 'fulfilled' }))
                .catch(error => ({ ...article, status: 'rejected', reason: error.message }))
        );

        const results = await Promise.allSettled(fetchPromises);
        
        const successfullyFetched = [];
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value.status === 'fulfilled') {
                successfullyFetched.push(result.value);
            } else {
                 const reason = result.status === 'rejected' ? result.reason : result.value.reason;
                 const link = result.status === 'rejected' ? 'N/A' : result.value.link;
                 synthesisLogger.warn(`Failed to fetch article ${link}: ${reason}`);
                 // Optionally save this failure to the database
                 // db.createJobArticle(jobId, { title: link, link: link, status: 'failed', error_message: reason });
            }
        });

        if (successfullyFetched.length === 0) {
            synthesisLogger.warn(`No articles could be fetched for job ${jobId}. Marking as failed.`);
            await db.updateJobStatus(jobId, 'failed');
            await db.updateJobMetaSummary(jobId, 'Konnte keine Artikelinhalte abrufen, um eine Zusammenfassung zu erstellen.');
            return;
        }

        synthesisLogger.info(`Successfully fetched ${successfullyFetched.length}/${articles.length} articles. Generating synthesized summary...`);
        
        // For simplicity, we are not saving individual articles to DB anymore in this flow.
        // We can add it back if needed for the UI.

        // Step 2: Generate the single, synthesized summary
        const summary = await generateSynthesizedSummaryTask({
            data: {
                articles: successfullyFetched, // Pass articles with their full content
                user_intent,
                language,
                currentDate: new Date().toLocaleDateString('de-DE')
            }
        });

        // Step 3: Save the final summary and mark the job as complete
        await db.updateJobMetaSummary(jobId, summary);
        await db.updateJobStatus(jobId, 'completed');
        
        synthesisLogger.info(`Synthesis job ${jobId} completed successfully.`);

    } catch (error) {
        synthesisLogger.error(`An error occurred during synthesis for job ${jobId}:`, error);
        await db.updateJobStatus(jobId, 'failed');
        await db.updateJobMetaSummary(jobId, `Ein Fehler ist aufgetreten: ${error.message}`);
        throw error; // Re-throw to let BullMQ know the job failed
    }
}, { connection: redisConnection });

synthesisLogger.info('Synthesis worker started and listening for jobs.');

export default synthesisWorker;
