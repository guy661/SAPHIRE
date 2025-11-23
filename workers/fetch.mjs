import { Worker } from "bullmq";
import { connection } from "../redis.mjs";
import { semanticSummaryQueue } from "../queues.mjs";
import { updateArticleContent } from "../database.js";
import { retry } from "../utils.js";
import { URL } from 'url';
import axios from 'axios';
import * as cheerio from 'cheerio';


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
        throw error;
    }
}

function extractArticleWithCheerio(html, url) {
    const $ = cheerio.load(html);
    const title = $('title').text();
    let text;

    // Domain-specific selectors
    if (url.includes('tagesschau.de')) {
        text = $('main article p').map((i, el) => $(el).text()).get().join('\n');
    } else if (url.includes('spiegel.de')) {
        text = $('article section p').map((i, el) => $(el).text()).get().join('\n');
    } else if (url.includes('derstandard.de')) {
        text = $('article div.article-body p').map((i, el) => $(el).text()).get().join('\n');
    } else if (url.includes('heise.de')) {
        text = $('div.article-content p').map((i, el) => $(el).text()).get().join('\n');
    } else if (url.includes('taz.de')) {
        text = $('main p').map((i, el) => $(el).text()).get().join('\n');
    } else {
        // Fallback: all <p> tags
        text = $('p').map((i, el) => $(el).text()).get().join('\n');
    }

    return { text, title };
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

    const finalController = new AbortController();
    const finalId = setTimeout(() => finalController.abort(), 15000);
    
    const response = await retry(async () => {
        const res = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36' },
            signal: finalController.signal,
        });
        return { data: res.data, url: res.request.res.responseUrl || targetUrl };
    });

    const html = response.data;
    const finalUrl = response.url;
    
    const { text: articleText, title } = extractArticleWithCheerio(html, finalUrl);

    if (articleText && articleText.length > 250) {
        return {
            articleText,
            title: title || 'Title not found',
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