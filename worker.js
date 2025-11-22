require('dotenv').config();
const { getPendingArticles, updateArticle, updateArticleStatus, updateJobStatus, getTopicByUserId, getPendingArticlesCountForJob } = require('./database.js');
const { callGemini, retry } = require('./utils.js');

const POLL_INTERVAL = 5000; // 5 seconds
const API_CALL_DELAY = 6000; // 6 seconds to stay under 10 calls/minute

async function processSingleArticle(article) {
    try {
        const userTopic = await getTopicByUserId(article.user_id);
        if (!userTopic) {
            console.error(`[Worker] ⚠️ No topic found for user ${article.user_id}. Skipping article ${article.id}.`);
            await updateArticleStatus(article.id, 'failed');
            return;
        }

        const prompt = `
You are a research assistant. Your task is to determine if an article is relevant to a user's specific interests.

User's interests:
- General Topic: "${userTopic.main_topic}"
- Must Include Themes: "${userTopic.include_keywords || 'N/A'}"
- Must Exclude Themes: "${userTopic.exclude_keywords || 'None'}"

Article Snippet:
---
${article.content.substring(0, 8000)}
---

Instructions:
1. Analyze if the article snippet is primarily about the "General Topic".
2. If "Must Include Themes" is not 'N/A', analyze if the article's content is clearly relevant to them.
3. Analyze if the article contains any of the "Must Exclude Themes".
4. Based on this, decide if the article is relevant. It is only relevant if it matches the "Must Include" criteria (if applicable) AND does not contain any "Must Exclude" criteria.
5. Respond in a valid JSON format with no other text or markdown: {"is_relevant": boolean, "reason": "A brief analysis of your decision."}
`;

        const decisionString = await retry(() => callGemini(prompt));
        const jsonMatch = decisionString.match(/\{.*\}/s); // Use 's' flag for multi-line matching

        if (jsonMatch) {
            try {
                const decision = JSON.parse(jsonMatch[0]);
                console.log(`[Worker] AI decision for ${article.link}: ${decision.is_relevant}. Reason: ${decision.reason}`);
                if (decision.is_relevant === true) {
                    await updateArticle(article.id, decision.reason, 'completed');
                } else {
                    await updateArticle(article.id, null, 'completed');
                }
            } catch (jsonError) {
                console.error(`[Worker] ⚠️ Invalid JSON in AI response for ${article.link}. Response: "${decisionString}"`, jsonError);
                await updateArticleStatus(article.id, 'failed');
            }
        } else {
            console.error(`[Worker] ⚠️ No JSON object found in AI response for ${article.link}. Response: "${decisionString}"`);
            await updateArticleStatus(article.id, 'failed');
        }
    } catch (e) {
        console.error(`[Worker] ⚠️ Could not process AI response for ${article.link}. Error: ${e.message}`);
        await updateArticleStatus(article.id, 'failed');
    }
}

async function processArticles() {
    console.log('[Worker] Polling for pending articles...');
    const articles = await getPendingArticles();

    if (articles.length > 0) {
        console.log(`[Worker] Found ${articles.length} articles to process.`);
        const processedJobIds = new Set();

        for (const article of articles) {
            processedJobIds.add(article.job_id);
            await processSingleArticle(article);
            console.log(`[Worker] Waiting for ${API_CALL_DELAY / 1000}s before next call.`);
            await new Promise(resolve => setTimeout(resolve, API_CALL_DELAY));
        }

        await checkJobsCompletion(Array.from(processedJobIds));
    }

    // Schedule the next poll
    setTimeout(processArticles, POLL_INTERVAL);
}

async function checkJobsCompletion(jobIds) {
    for (const jobId of jobIds) {
        const pendingCount = await getPendingArticlesCountForJob(jobId);
        if (pendingCount === 0) {
            await updateJobStatus(jobId, 'completed');
            console.log(`[Worker] Job ${jobId} completed.`);
        }
    }
}

function main() {
    console.log('[Worker] Starting worker process...');
    processArticles(); // Start the first poll
}

main();
