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
    const response = await axios.get(googleRssUrl);
    const $ = cheerio.load(response.data);
    const data = $('c-wiz[data-p]').attr('data-p');
    const obj = JSON.parse(data.replace('%.@.', '["garturlreq",'));

    const payload = {
      'f.req': JSON.stringify([[['Fbv4je', JSON.stringify([...obj.slice(0, -6), ...obj.slice(-2)]), 'null', 'generic']]])
    };

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    };

    
    const postResponse = await axios.post('https://news.google.com/_/DotsSplashUi/data/batchexecute', payload, { headers });
    const arrayString = JSON.parse(postResponse.data.replace(")]}'", ""))[0][2];
    const articleUrl = JSON.parse(arrayString)[1];

    return articleUrl;
}

async function extractArticleContent(url) {
    let targetUrl = url;

    if (url.includes('news.google.com')) {
      console.log(`[Fetch Worker] Google News URL detected. Extracting real URL...`);
      targetUrl = await getArticleUrl(url);
      console.log(`[Fetch Worker] Real article URL: ${targetUrl}`);
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