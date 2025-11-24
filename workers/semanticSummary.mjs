import { Worker } from "bullmq";
import { connection } from "../redis.mjs";
import db from '../database-postgres.js';
const { getJobArticle, getTopicByUserId, updateArticle, getPendingArticlesCountForJob, updateJobStatus, getUserById } = db;
import { semanticCheckTask, summarizeArticleTask } from "../task.js";
import pkg from '../utils.js';
const { getApiKeyCount } = pkg;

const apiKeyCount = getApiKeyCount();
const concurrency = apiKeyCount > 0 ? apiKeyCount : 1;
console.log(`[Semantic Worker] Setting concurrency to ${concurrency} based on ${apiKeyCount} API keys.`);

new Worker(
  "semantic-summary",
  async (job) => {
    const { articleId, userId } = job.data;
    console.log(`[Semantic Worker] Processing articleId: ${articleId}`);

    try {
      const user = await getUserById(userId); // Fetch user to get language
      if (!user || !user.language) {
          throw new Error(`User or user language not found for userId: ${userId}`);
      }

      const article = await getJobArticle(articleId);
      if (!article || !article.content) {
        throw new Error(`Article or article content not found for id: ${articleId}`);
      }

      const userTopic = await getTopicByUserId(userId);
      if (!userTopic) {
        throw new Error(`User topic not found for user: ${userId}`);
      }

      const articleForTask = {
        link: article.link,
        title: article.title,
        articleText: article.content
      };

      const semanticResult = await semanticCheckTask({ data: { article: articleForTask, userTopic, language: user.language } }); // Pass language

      if (semanticResult.is_relevant) {
        console.log(`[Semantic Worker] ✅ RELEVANT: Article ${articleId} is relevant. Reason: ${semanticResult.reason}. Summarizing...`);
        const summaryResult = await summarizeArticleTask({ data: { article: articleForTask, language: user.language } }); // Pass language
        
        await updateArticle(articleId, summaryResult.summary, 'completed', semanticResult.reason);

      } else {
        console.log(`[Semantic Worker] Article ${articleId} is NOT relevant. Reason: ${semanticResult.reason}`);
        await updateArticle(articleId, '', 'rejected', semanticResult.reason);
      }

      // Check if the parent job is now complete
      const pendingCount = await getPendingArticlesCountForJob(article.job_id);
      if (pendingCount === 0) {
        console.log(`[Semantic Worker] Job ${article.job_id} has no more pending articles. Marking as complete.`);
        await updateJobStatus(article.job_id, 'completed');
      }

    } catch (error) {
      console.error(`[Semantic Worker] FAILED for articleId: ${articleId}`, error);
      await updateArticle(articleId, '', 'failed');
    }
  },
  { connection, concurrency: concurrency }
);