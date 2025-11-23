import { Worker } from "bullmq";
import { connection } from "../redis.mjs";
import { semanticSummaryQueue } from "../queues.mjs";
import { updateArticleContent } from "../database.js";
import { retry } from "../utils.js";
import { URL } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';

async function getArticleUrl(googleRssUrl) {
    // This function remains as implemented before, to get the real URL from a Google News RSS link.
    try {
        const response = await axios.get(googleRssUrl);
        const $ = cheerio.load(response.data);
        const data = $('c-wiz[data-p]').attr('data-p');
        if (!data) {
            console.warn(`[Fetch Worker] Could not find data-p attribute for ${googleRssUrl}`);
            throw new Error('Missing data-p attribute');
        }
        const obj = JSON.parse(data.replace('%.@.', '["garturlreq",'));
        
        // Safely access nested property as hinted by the user to prevent crash
        const run = obj?.[0]?.[2]?.[0];
        if (!run) {
            console.warn(`[Fetch Worker] Unexpected obj structure: nested property missing for ${googleRssUrl}.`);
            throw new Error('Unexpected data structure in data-p, nested property missing.');
        }

        if (!Array.isArray(obj) || obj.length < 8) {
            console.warn(`[Fetch Worker] Unexpected obj structure for ${googleRssUrl}.`);
            throw new Error('Unexpected data structure in data-p');
        }
        const payload = { 'f.req': JSON.stringify([[['Fbv4je', JSON.stringify([...obj.slice(0, -6), ...obj.slice(-2)]), 'null', 'generic']]]) };
        const headers = {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        };
        const postResponse = await axios.post('https://news.google.com/_/DotsSplashUi/data/batchexecute', payload, { headers });
        const responseBody = postResponse.data.replace(")]}'", "");
        const responseArray = JSON.parse(responseBody);
        const arrayString = responseArray?.[0]?.[2];
        if (!arrayString) {
            console.warn(`[Fetch Worker] Could not find arrayString in batchexecute response for ${googleRssUrl}.`);
            throw new Error('Unexpected batchexecute response structure');
        }
        const articleUrl = JSON.parse(arrayString)[1];
        return articleUrl;
    } catch (error) {
        console.error(`[Fetch Worker] Failed to extract real URL for ${googleRssUrl}:`, error.message);
        throw error;
    }
}

async function extractArticleDetailsWithCheerio(url) {
    try {
        const { data, request } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
            }
        });
        const $ = cheerio.load(data);
        const title = $('title').text() || 'Title not found';
        const finalUrl = request.res.responseUrl || url;
        let text;

        // Domain-specific selectors
        if (finalUrl.includes('tagesschau.de')) {
            text = $('main article p').map((i, el) => $(el).text()).get().join('\n');
        } else if (finalUrl.includes('spiegel.de')) {
            text = $('article section p').map((i, el) => $(el).text()).get().join('\n');
        } else if (finalUrl.includes('derstandard.de')) {
            text = $('article div.article-body p').map((i, el) => $(el).text()).get().join('\n');
        } else if (finalUrl.includes('heise.de')) {
            text = $('div.article-content p').map((i, el) => $(el).text()).get().join('\n');
        } else if (finalUrl.includes('taz.de')) {
            text = $('main p').map((i, el) => $(el).text()).get().join('\n');
        } else {
            // Fallback: all <p> tags
            text = $('p').map((i, el) => $(el).text()).get().join('\n');
        }

        return { text, title, finalUrl };
    } catch (error) {
        console.error(`[Fetch Worker] Cheerio extraction failed for ${url}:`, error.message);
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

    if (targetUrl.includes('youtube.com') || targetUrl.includes('youtu.be')) {
        console.log(`[Fetch Worker] YouTube URL detected. Skipping content fetch for ${targetUrl}`);
        return {
            articleText: 'This is a video article and cannot be summarized.',
            title: 'Video Article',
            url: targetUrl
        };
    }
    
    const { text: articleText, title, finalUrl } = await extractArticleDetailsWithCheerio(targetUrl);

    if (articleText && articleText.length > 250) {
        return {
            articleText,
            title,
            url: finalUrl
        };
    } else {
        console.warn(`[Fetch Worker] Cheerio parsing failed or content too short for ${finalUrl}.`);
        return {
            articleText: `Could not parse article content. The content might be too short or in an unsupported format.`,
            title: title || 'Content not available',
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
    }
  },
  { connection, concurrency: 2 }
);