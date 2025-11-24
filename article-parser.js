const axios = require('axios');
const cheerio = require('cheerio');
const { Logger, EMOJIS } = require('./utils');

const parserLogger = new Logger('Parser', 'cyan', EMOJIS.task);

class PaywallError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PaywallError';
    }
}

// Refined keywords and selectors based on user feedback.
// Generic terms like "abonnement" or "subscribe" are removed.
const PAYWALL_INDICATORS = {
    keywords: [
        'paywall', 'jetzt freischalten', 'nur für abonnenten', 
        'exklusiver inhalt', 'vollständigen artikel lesen', 'anmelden zum lesen'
    ],
    selectors: [
        '.paywall', '#paywall-gate', '[id*="paywall"]', '[class*="paywall"]',
        '.premium-content', '.locked-content', '.subscription-required',
        '#js-paywall-screen', '.article-gating', '[class*="access-denied"]',
        '[class*="pay-wall"]'
    ]
};

// Source - https://stackoverflow.com/a
// Posted by GTK
// Retrieved 2025-11-24, License - CC BY-SA 4.0
async function getArticleUrl(googleRssUrl) {
    parserLogger.info(`Resolving Google News URL: ${googleRssUrl}`);
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
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

/**
 * Extrahiert Artikeltext zuverlässig mit Axios + Cheerio.
 * Funktioniert für praktisch alle Nachrichten-Seiten,
 * sofern sie den HTML-Content direkt ausliefern (kein JS-Rendering).
 */
async function extractArticleText(realUrl) {
    parserLogger.info(`Extracting content from real URL: ${realUrl}`);
    try {
        const response = await axios.get(realUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
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
        // Only run detection if the extracted content seems suspiciously short.
        if (cleanedContent.length < 400) {
            parserLogger.warn(`Content is short (${cleanedContent.length} chars). Scanning for high-confidence paywall indicators.`);
            const pageText = $.text().toLowerCase();
            for (const keyword of PAYWALL_INDICATORS.keywords) {
                if (pageText.includes(keyword)) {
                    throw new PaywallError(`Paywall suspected: Content is short AND keyword "${keyword}" was found.`);
                }
            }
            // Check for selectors only if content is short
            for (const selector of PAYWALL_INDICATORS.selectors) {
                if ($(selector).length > 0) {
                    throw new PaywallError(`Paywall suspected: Content is short AND selector "${selector}" was found.`);
                }
            }
        }
        // --- END NEW PAYWALL DETECTION ---

        parserLogger.info(`Successfully extracted content. Title: "${title}", Length: ${cleanedContent.length}`);
        
        return {
            title: title,
            content: cleanedContent,
            finalUrl: realUrl
        };

    } catch (err) {
        if (err instanceof PaywallError) {
            parserLogger.warn(err.message);
            throw err;
        }
        parserLogger.error(`Error fetching or parsing content from ${realUrl}:`, err);
        throw new Error(`Could not fetch or parse content from ${realUrl}: ${err.message}`);
    }
}

module.exports = { getArticleUrl, extractArticleText, PaywallError };
