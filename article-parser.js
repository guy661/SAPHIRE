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
    if (cleanedContent.length < 250) {
        // parserLogger.warn(`Content is short (${cleanedContent.length} chars). Scanning for high-confidence paywall indicators.`);
        const pageText = $.text().toLowerCase();
        for (const keyword of PAYWALL_INDICATORS.keywords) {
            if (pageText.includes(keyword)) {
                // throw new PaywallError(`Paywall suspected: Content is short AND keyword "${keyword}" was found.`);
                 parserLogger.warn(`Potential Paywall detected but keeping content: ${keyword}`);
            }
        }
        for (const selector of PAYWALL_INDICATORS.selectors) {
            if ($(selector).length > 0) {
                // throw new PaywallError(`Paywall suspected: Content is short AND selector "${selector}" was found.`);
                 parserLogger.warn(`Potential Paywall detected but keeping content: ${selector}`);
            }
        }
    }
    // --- END NEW PAYWALL DETECTION ---

    // parserLogger.debug(`Successfully extracted content. Title: "${title}", Length: ${cleanedContent.length}`);
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
    // parserLogger.debug(`Extracting content from real URL: ${realUrl}`);
    try {
        // --- First attempt: Axios (fast) ---
        // parserLogger.debug(`Attempting extraction with Axios...`);
        const response = await axios.get(realUrl, {
            headers: {
                // Diese Header sind entscheidend gegen Blockaden:
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Referer': 'https://www.google.com/',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-User': '?1',
                'Pragma': 'no-cache',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000, 
            maxRedirects: 5,
            // Wichtig: Verhindert Fehler bei unvollständigen Zertifikats-Ketten
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
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

async function getArticleUrl(googleRssUrl) {
    try {
        // parserLogger.debug(`[getArticleUrl] Resolving: ${googleRssUrl}`);

        const response = await axios.get(googleRssUrl, { timeout: 15000 });
        
        const $ = cheerio.load(response.data);
        const data = $('c-wiz[data-p]').attr('data-p');
        if (!data) {
             // This can happen if it's not a google url, which is fine, or if the page structure changed.
            if (!googleRssUrl.includes('news.google.com')) {
                return googleRssUrl;
            }
            throw new Error('Could not find attribute "data-p" in Google News page.');
        }

        const obj = JSON.parse(data.replace('%.@.', '["garturlreq",'));

        const payload = {
          'f.req': JSON.stringify([[['Fbv4je', JSON.stringify([...obj.slice(0, -6), ...obj.slice(-2)]), 'null', 'generic']]])
        };

        const headers = {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
        };
        
        const postResponse = await axios.post('https://news.google.com/_/DotsSplashUi/data/batchexecute', payload, { headers, timeout: 15000 });
        
        const rawDataString = postResponse.data.replace(")]}'", "");
        const arrayString = JSON.parse(rawDataString)[0][2];
        const articleUrl = JSON.parse(arrayString)[1];
        
        if (!articleUrl) {
            throw new Error('Final article URL was null or undefined in the parsed response.');
        }
        // parserLogger.debug(`[getArticleUrl] Resolved to: ${articleUrl}`);

        return articleUrl;
    } catch (error) {
        parserLogger.error(`[getArticleUrl] Failed to resolve ${googleRssUrl}. Error: ${error.message}`);
        // Re-throw the error so the calling function knows it failed
        throw error;
    }
}


module.exports = { getArticleUrl, extractArticleText, PaywallError };
