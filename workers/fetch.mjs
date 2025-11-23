import { Worker } from "bullmq";
import { connection } from "../redis.mjs";
import { semanticSummaryQueue } from "../queues.mjs";
import { updateArticleContent } from "../database.js";
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import fetch from 'node-fetch';
import { retry } from "../utils.js";
import { URL } from 'url';

// This is a simplified version of the fast path from _getArticleContent
async function extractArticleContent(url) {
    let targetUrl = url;

    // If it's a Google News URL, get the content and find the real URL inside
    if (url.includes('news.google.com')) {
        console.log(`[Fetch Worker] Google News URL detected. Attempting to get real URL: ${url}`);
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 15000);
        
        try {
            const response = await retry(() => fetch(url, {
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' },
                signal: controller.signal
            }).finally(() => clearTimeout(id)));

            if (!response.ok) {
                throw new Error(`Google News redirect fetch HTTP error! status: ${response.status}`);
            }
            targetUrl = response.url;
            console.log(`[Fetch Worker] Extracted real URL: ${targetUrl}`);
        } catch (error) {
            console.error('[Fetch Worker] Error getting real URL from Google News:', error);
            throw new Error('Could not extract real URL from Google News page.');
        }
    }

    // Fetch the final target URL (either original or the one extracted from Google News)
    const finalController = new AbortController();
    const finalId = setTimeout(() => finalController.abort(), 15000);
    
    const response = await retry(() => fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' },
        signal: finalController.signal
    }).finally(() => clearTimeout(finalId)));

    if (!response.ok) {
        throw new Error(`Fast Path HTTP error! status: ${response.status}`);
    }
    
    const html = await response.text();
    const finalUrl = response.url;
    const doc = new JSDOM(html, { url: finalUrl });
    const reader = new Readability(doc.window.document);
    const readableArticle = reader.parse();

    if (readableArticle && readableArticle.textContent && readableArticle.textContent.length > 250) {
        return {
            articleText: readableArticle.textContent,
            title: readableArticle.title,
            url: finalUrl
        };
    } else {
        throw new Error('Readability parsing failed or content too short.');
    }
}

new Worker(
  "fetch",
  async job => {
    const { articleId, url, userId } = job.data;
    console.log(`[Fetch Worker] Processing articleId: ${articleId}, url: ${url}`);
    try {
      const article = await extractArticleContent(url);
      
      await updateArticleContent(articleId, article.title, article.articleText);
      
      await semanticSummaryQueue.add("semantic-summary", {
        articleId,
        userId,
      });

      console.log(`[Fetch Worker] Successfully processed and queued for semantic summary: ${articleId}`);

    } catch (error) {
      console.error(`[Fetch Worker] FAILED for articleId: ${articleId}, url: ${url}`, error.message);
      // Optionally, update article status to 'fetch_failed'
      // await updateArticleStatus(articleId, 'fetch_failed');
    }
  },
  { connection, concurrency: 2 }
);