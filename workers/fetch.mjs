import { Worker } from "bullmq";
import { connection } from "../redis.mjs";
import { semanticSummaryQueue } from "../queues.mjs";
import { updateArticleContent } from "../database.js";
import { Readability } from '@mozilla/readability';
import { retry } from "../utils.js";
import { URL } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';


async function getArticleUrl(googleRssUrl) {
    try {
        const response = await axios.get(googleRssUrl);
        const $ = cheerio.load(response.data);
        const data = $('c-wiz[data-p]').attr('data-p');

        if (!data) {
            console.warn(`[Fetch Worker] Could not find data-p attribute for ${googleRssUrl}`);
            throw new Error('Missing data-p attribute');
        }

        console.log(`[Fetch Worker] Found data-p for ${googleRssUrl}:`, data);
        
        const obj = JSON.parse(data.replace('%.@.', '["garturlreq",'));

        // The user mentioned a 'run' field, but the example code doesn't use it.
        // The core logic seems to be slicing the obj. We will make this safer.
        if (!Array.isArray(obj) || obj.length < 8) {
            console.warn(`[Fetch Worker] Unexpected obj structure for ${googleRssUrl}. Obj:`, obj);
            throw new Error('Unexpected data structure in data-p');
        }

        const payload = {
          'f.req': JSON.stringify([[['Fbv4je', JSON.stringify([...obj.slice(0, -6), ...obj.slice(-2)]), 'null', 'generic']]])
        };
        console.log(`[Fetch Worker] Batchexecute payload for ${googleRssUrl}:`, JSON.stringify(payload, null, 2));


        const headers = {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        };

        const postResponse = await axios.post('https://news.google.com/_/DotsSplashUi/data/batchexecute', payload, { headers });
        
        const responseBody = postResponse.data.replace(")]}'", "");
        const responseArray = JSON.parse(responseBody);
        
        const arrayString = responseArray?.[0]?.[2];
        if (!arrayString) {
            console.warn(`[Fetch Worker] Could not find arrayString in batchexecute response for ${googleRssUrl}. Response body:`, responseBody);
            throw new Error('Unexpected batchexecute response structure');
        }

        const articleUrl = JSON.parse(arrayString)[1];
        return articleUrl;

    } catch (error) {
        console.error(`[Fetch Worker] Failed to extract real URL for ${googleRssUrl}:`, error.message);
        // Re-throw the error to be caught by the job's catch block
        throw error;
    }
}

async function extractArticleContent(url) {
    let targetUrl = url;

    if (url.includes('news.google.com')) {
      console.log(`[Fetch Worker] Google News URL detected. Extracting real URL...`);
      targetUrl = await getArticleUrl(url);
      console.log(`[Fetch Worker] Real article URL: ${targetUrl}`);
    }

    // Fallback for YouTube videos
    if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
        console.log(`[Fetch Worker] YouTube URL detected. Skipping content fetch for ${targetUrl}`);
        // Can't get title without another fetch, so we'll have to settle for a placeholder
        return {
            articleText: 'This is a video article and cannot be summarized.',
            title: 'Video Article',
            url: targetUrl
        };
    }

    // Fetch the final target URL (either original or the one extracted from Google News)
    const finalController = new AbortController();
    const finalId = setTimeout(() => finalController.abort(), 15000);
    
    const response = await retry(async () => {
        const res = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' },
            signal: finalController.signal,
        });
        // Axios response URL is on the request object after redirects
        return { data: res.data, url: res.request.res.responseUrl || targetUrl };
    });

    const html = response.data;
    const finalUrl = response.url;
    const doc = new JSDOM(html, { url: finalUrl });
    const reader = new Readability(doc.window.document);
    const readableArticle = reader.parse();

    if (readableArticle && readableArticle.textContent && readableArticle.textContent.length > 250) {
        return {
            articleText: readableArticle.textContent,
            title: readableArticle.title || 'Title not found',
            url: finalUrl
        };
    } else {
        // If readability fails, return a graceful fallback
        console.warn(`[Fetch Worker] Readability parsing failed for ${finalUrl}. Returning fallback.`);
        return {
            articleText: `Could not parse article content. The content might be too short, dynamic, or in an unsupported format.`,
            title: 'Content not available',
            url: finalUrl
        };
    }
}

new Worker(
  "fetch",
  async job => {
    const { articleId, url, userId } = job.data;
    console.log(`[Fetch Worker] Processing articleId: ${articleId}, url: ${url}`);
    try {
      const article = await extractArticleContent(url);
      
      await updateArticleContent(articleId, article.title, article.articleText, article.url);
      
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