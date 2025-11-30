const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { Logger, EMOJIS } = require('./utils');

const parserLogger = new Logger('Parser', 'cyan', EMOJIS.task);

class PaywallError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PaywallError';
    }
}

const PAYWALL_INDICATORS = {
    keywords: ['paywall', 'jetzt freischalten', 'nur für abonnenten', 'exklusiver inhalt', 'vollständigen artikel lesen', 'anmelden zum lesen'],
    selectors: ['.paywall', '#paywall-gate', '[id*="paywall"]', '[class*="paywall"]', '.premium-content', '.locked-content', '.subscription-required', '#js-paywall-screen', '.article-gating', '[class*="access-denied"]', '[class*="pay-wall"]']
};

function _parseHtmlWithCheerio(html, realUrl) {
    const $ = cheerio.load(html);
    const domain = new URL(realUrl).hostname;
    
    let articleContent = '';

    // DOMAIN-SPEZIFISCHE REGELN
    if (domain.includes('tagesschau.de')) {
        articleContent = $('main article p').map((i, el) => $(el).text().trim()).get().join('\n');
    } else if (domain.includes('spiegel.de')) {
        articleContent = $('article section p').map((i, el) => $(el).text().trim()).get().join('\n');
    } else if (domain.includes('fr.de') || domain.includes('welt.de') || domain.includes('faz.net') || domain.includes('taz.de') || domain.includes('hasepost.de')) {
        articleContent = $('article p, section p, main p').map((i, el) => $(el).text().trim()).get().join('\n');
    } else {
        // Fallback
        articleContent = $('p').map((i, el) => $(el).text().trim()).get().join('\n');
    }
    
    const title = $('head title').text().trim() || 'No Title Found';
    const cleanedContent = articleContent.replace(/\s{3,}/g, '\n\n').trim();

    // --- NEW "INTELLIGENT" PAYWALL DETECTION ---
    if (cleanedContent.length < 400) {
        parserLogger.warn(`Content is short (${cleanedContent.length} chars). Scanning for high-confidence paywall indicators.`);
        const pageText = $.text().toLowerCase();
        for (const keyword of PAYWALL_INDICATORS.keywords) {
            if (pageText.includes(keyword)) {
                throw new PaywallError(`Paywall suspected: Content is short AND keyword "${keyword}" was found.`);
            }
        }
        for (const selector of PAYWALL_INDICATORS.selectors) {
            if ($(selector).length > 0) {
                throw new PaywallError(`Paywall suspected: Content is short AND selector "${selector}" was found.`);
            }
        }
    }
    // --- END NEW PAYWALL DETECTION ---

    parserLogger.info(`Successfully extracted content. Title: "${title}", Length: ${cleanedContent.length}`);
    return { title, content: cleanedContent, finalUrl: realUrl };
}

async function _extractWithPuppeteer(realUrl) {
    parserLogger.warn(`Axios failed. Falling back to Puppeteer for: ${realUrl}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setJavaScriptEnabled(true);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        
        await page.goto(realUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        const html = await page.content();
        return _parseHtmlWithCheerio(html, realUrl);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function extractArticleText(realUrl) {
    parserLogger.info(`Extracting content from real URL: ${realUrl}`);
    try {
        // --- First attempt: Axios (fast) ---
        parserLogger.debug(`Attempting extraction with Axios...`);
        const response = await axios.get(realUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br, zstd',
                'Accept-Language': 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
                'DNT': '1',
                'Upgrade-Insecure-Requests': '1',
                'Referer': 'https://www.google.com/'
            },
            timeout: 30000,
            maxRedirects: 10
        });
        return _parseHtmlWithCheerio(response.data, realUrl);

    } catch (err) {
        // --- Fallback: Puppeteer (robust) ---
        const isNetworkError = err.isAxiosError && (!err.response || [403, 401, 503].includes(err.response.status));
        const isTimeout = err.code === 'ECONNABORTED';
        const isRedirectError = err.message && err.message.toLowerCase().includes('many redirects');

        if (isNetworkError || isTimeout || isRedirectError) {
            try {
                return await _extractWithPuppeteer(realUrl);
            } catch (puppeteerError) {
                if (puppeteerError instanceof PaywallError) {
                    parserLogger.warn(puppeteerError.message);
                    throw puppeteerError;
                }
                parserLogger.error(`Puppeteer fallback also failed for ${realUrl}:`, puppeteerError);
                throw new Error(`Puppeteer fallback failed: ${puppeteerError.message}`);
            }
        }
        
        if (err instanceof PaywallError) {
            parserLogger.warn(err.message);
            throw err;
        }

        parserLogger.error(`Unhandled error fetching or parsing content from ${realUrl}:`, err);
        throw new Error(`Could not fetch or parse content from ${realUrl}: ${err.message}`);
    }
}

// Source - https://stackoverflow.com/a
// Posted by GTK
// Retrieved 2025-11-24, License - CC BY-SA 4.0
async function getArticleUrl(googleRssUrl) {
    parserLogger.info(`Resolving Google News URL: ${googleRssUrl.substring(0, 100)}...`);
    const response = await axios.get(googleRssUrl, { timeout: 10000 });
    const $ = cheerio.load(response.data);
    const data = $('c-wiz[data-p]').attr('data-p');
    
    if (!data) {
        if (!googleRssUrl.includes('news.google.com')) {
            parserLogger.warn(`'data-p' attribute not found for ${googleRssUrl}. Returning original URL.`);
            return googleRssUrl;
        }
        throw new Error('Could not find article data in Google News redirect page.');
    }

    const jsonString = data.replace('%.@.', '["garturlreq",');
    let obj;
    try {
        obj = JSON.parse(jsonString);
    } catch (e) {
        parserLogger.error('Error parsing Google News data:', e);
        throw e;
    }

    const payload = {
      'f.req': JSON.stringify([[['Fbv4je', JSON.stringify([...obj.slice(0, -6), ...obj.slice(-2)]), 'null', 'generic']]])
    };

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    };

    const postResponse = await axios.post('https://news.google.com/_/DotsSplashUi/data/batchexecute', payload, { headers, timeout: 10000 });
    let arrayString;
    try {
        arrayString = JSON.parse(postResponse.data.replace(")]}'", ""))[0][2];
    } catch (e) {
        parserLogger.error('Error parsing batch execute response:', e);
        throw e;
    }
    
    let articleUrl;
    try {
        articleUrl = JSON.parse(arrayString)[1];
    } catch (e) {
        parserLogger.error('Error parsing article URL from array:', e);
        throw e;
    }

    if (!articleUrl) {
        throw new Error('Failed to extract final article URL from batch execute response.');
    }
    parserLogger.info(`Resolved to final URL: ${articleUrl}`);
    return articleUrl;
}


module.exports = { getArticleUrl, extractArticleText, PaywallError };
