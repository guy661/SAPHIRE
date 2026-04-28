const Parser = require('rss-parser');
const fs = require('fs/promises');
const path = require('path');
const { Logger, EMOJIS } = require('./utils');
const axios = require('axios');
const pLimit = require('p-limit');

// Puppeteer imports for fallback
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml; q=0.1',
  }
});

const feedsFilePath = path.join(__dirname, 'feeds.json');
const aggregatorLogger = new Logger('Aggregator', 'blue', EMOJIS.fetch);

// Cache to avoid reading the file every time
let feedCategories;

const CATEGORY_MAPPING = {
  'news_politics_de': ['news_politics_dach_national', 'news_politics_dach_regional'],
  'news_politics_en': ['news_politics_international'],
  'dev_security_it_pro_en': ['dev_security_languages', 'dev_engineering_blogs'],
  'business_finance_de_en': ['business_finance_crypto'],
  'science_environment_education': ['science_space_edu'],
  'culture_design_lifestyle': ['lifestyle_culture_gaming'],
  'gaming_entertainment': ['lifestyle_culture_gaming'],
  'miscellaneous': ['miscellaneous_blogs'],
  'reddit': ['reddit_aggregators']
};

async function getFeedCategories() {
  if (!feedCategories) {
    const data = await fs.readFile(feedsFilePath, 'utf-8');
    feedCategories = JSON.parse(data);
  }
  return feedCategories;
}

// Fallback function using Puppeteer
async function fetchFeedWithPuppeteer(url) {
  aggregatorLogger.warn(`Initiating Stealth Puppeteer fallback for: ${url}`);
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'] 
    });
    const page = await browser.newPage();
    
    // Set a realistic viewport and user agent
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    // Go to URL and wait for body
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Get the raw text content. 
    // Sometimes Chrome wraps XML in a visual tree (inside <body>), sometimes it's raw text.
    // We try to get the raw response text first if available from the network response.
    let content = await response.text();

    if (!content || content.length < 50) {
        // If response text is empty (some SPAs?), try evaluating body text
        content = await page.evaluate(() => document.body.innerText);
    }
    
    return content;

  } catch (err) {
    aggregatorLogger.error(`Puppeteer fallback failed for ${url}: ${err.message}`);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

async function fetchGoogleNewsForSite(siteUrl, lang, originalName) {
    if (!siteUrl) return [];
    
    try {
        const siteObj = new URL(siteUrl);
        const domain = siteObj.hostname.replace(/^www\./, '');
        // Construct Google News RSS URL
        // site:domain works well. We can also try site:full_url but that might be too restrictive if the RSS link is deep.
        // Let's stick to hostname for maximum yield, as the user requested.
        
        let hl = 'en-US';
        let gl = 'US';
        let ceid = 'US:en';
        
        if (lang === 'de') {
            hl = 'de';
            gl = 'DE';
            ceid = 'DE:de';
        }

        const googleUrl = `https://news.google.com/rss/search?q=site:${domain}+when:7d&hl=${hl}&gl=${gl}&ceid=${ceid}`;
        
        // Use Axios directly for Google (it usually works fine)
        const response = await axios.get(googleUrl, {
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            responseType: 'text'
        });

        const feed = await parser.parseString(response.data);
        return (feed.items || []).map(item => ({
            ...item,
            sourceName: `${originalName} (via Google)`, 
            _isBonus: true
        }));

    } catch (e) {
        // aggregatorLogger.warn(`Google Booster failed for ${siteUrl}: ${e.message}`);
        return [];
    }
}

async function fetchAndParseFeed(feedConfig) {
  const { name, url, lang } = feedConfig;
  let rawContent = '';
  let items = [];
  let feedLink = null;

  try {
    aggregatorLogger.info(`Fetching feed: ${name} ...`);

    // 1. Try Axios first (Faster, lighter)
    const response = await axios.get(url, {
      timeout: 10000, 
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      },
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
      responseType: 'text',
      validateStatus: (status) => status < 500 // Don't throw on 403 immediately, handle manually
    });

    if (response.status === 403 || response.status === 401 || response.status === 429) {
       throw new Error(`HTTP ${response.status}`);
    }

    rawContent = response.data;

  } catch (error) {
    const isBlockingError = error.message.includes('403') || error.message.includes('401') || error.message.includes('429') || error.message.includes('503');
    
    if (isBlockingError) {
        try {
            // 2. Fallback to Puppeteer
            rawContent = await fetchFeedWithPuppeteer(url);
        } catch (puppeteerError) {
             aggregatorLogger.warn(`Both Axios and Puppeteer failed for ${name} (${url}).`);
             // Even if main feed fails, we might still try Google Booster if we can guess the domain from the feed URL?
             // For now, let's just return empty to be safe, or we could try parsing the feed URL itself.
        }
    } else {
        // Standard errors (DNS, 404) - Log and return empty
        if (error.code === 'ENOTFOUND') {
            aggregatorLogger.warn(`DNS Error for ${url}: Host not found.`);
        } else if (error.response && error.response.status === 404) {
            aggregatorLogger.warn(`Feed not found (404): ${url}`);
        } else {
            aggregatorLogger.warn(`Error processing feed ${name}: ${error.message}`);
        }
    }
  }

  // Parse the content (whether from Axios or Puppeteer)
  if (rawContent) {
      try {
        // XML Cleaning
        let cleanXml = rawContent;
        if (typeof cleanXml === 'string') {
            cleanXml = cleanXml.trim();
            const xmlStart = cleanXml.indexOf('<');
            if (xmlStart > 0) {
                cleanXml = cleanXml.substring(xmlStart);
            }
        }

        const feed = await parser.parseString(cleanXml);
        items = feed.items || [];
        feedLink = feed.link;
        
        // Inject source
        items.forEach(item => {
          item.sourceName = name;
        });

      } catch (parseError) {
          // aggregatorLogger.warn(`XML Parsing failed for ${name}: ${parseError.message}`);
      }
  }

  // --- BOOSTER LOGIC: Fetch more items from Google News using the site link ---
  if (feedLink || url) {
      // Use feed.link if available (most reliable), otherwise try to extract base from feed url
      const targetUrl = feedLink || url;
      const bonusItems = await fetchGoogleNewsForSite(targetUrl, lang, name);
      
      if (bonusItems.length > 0) {
          const originalCount = items.length;
          
          // Deduplicate: Don't add if title is very similar
          const existingTitles = new Set(items.map(i => (i.title || '').toLowerCase().trim()));
          
          let addedCount = 0;
          bonusItems.forEach(bonus => {
              const cleanTitle = (bonus.title || '').toLowerCase().trim();
              // Google titles often have " - SourceName" at the end, strip it for comparison
              const cleanTitleNoSource = cleanTitle.split(' - ')[0];
              
              // Check if strictly already exists
              if (!existingTitles.has(cleanTitle) && !existingTitles.has(cleanTitleNoSource)) {
                  items.push(bonus);
                  existingTitles.add(cleanTitle); // Add to set to prevent double adding within bonus
                  addedCount++;
              }
          });
          
          if (addedCount > 0) {
             aggregatorLogger.info(`[Booster] ${name}: +${addedCount} extra items (Original: ${originalCount})`);
          }
      }
  }

  return items;
}

async function getAggregatedFeed(categories = [], minDate = null, keywords = {}) {
  const allCategories = await getFeedCategories();
  let feedsToFetch = [];

  // Resolve categories using mapping
  let resolvedCategories = [];
  if (categories.length === 0) {
      resolvedCategories = Object.keys(allCategories);
  } else {
      categories.forEach(cat => {
          if (CATEGORY_MAPPING[cat]) {
              resolvedCategories.push(...CATEGORY_MAPPING[cat]);
          } else {
              resolvedCategories.push(cat);
          }
      });
  }
  
  // Deduplicate categories
  resolvedCategories = [...new Set(resolvedCategories)];

  aggregatorLogger.info(`Resolved categories for fetching: ${resolvedCategories.join(', ')}`);

  for (const category of resolvedCategories) {
    if (allCategories[category]) {
      const catFeeds = allCategories[category].feeds.map(f => ({ ...f, _categoryLang: f.lang }));
      feedsToFetch.push(...catFeeds);
    } else {
       aggregatorLogger.warn(`Category "${category}" not found in feeds.json.`);
    }
  }

  aggregatorLogger.info(`Preparing to fetch ${feedsToFetch.length} feeds from ${resolvedCategories.length} categories.`);
  if (feedsToFetch.length === 0) {
    return [];
  }

  // Limit concurrency to 5 parallel fetches to prevent killing the server with Puppeteer instances
  const limit = pLimit(5);

  const feedPromises = feedsToFetch.map(feed => limit(() => fetchAndParseFeed(feed).then(items => {
      items.forEach(item => { item._feedLang = feed.lang || feed._categoryLang; });
      return items;
  })));
  
  const allItems = await Promise.all(feedPromises);
  const flattenedItems = allItems.flat();
  aggregatorLogger.info(`Total raw items fetched: ${flattenedItems.length}`);

  // Filter by date if minDate is provided
  let filteredItems = flattenedItems;
  if (minDate) {
      const thresholdDate = new Date(minDate);
      filteredItems = flattenedItems.filter(item => {
          if (!item.pubDate) return false;
          try {
              return new Date(item.pubDate) > thresholdDate;
          } catch (e) {
              return false;
          }
      });
      aggregatorLogger.info(`Date filtering: kept ${filteredItems.length} items newer than ${minDate}`);
  }

  // Filter by keywords if provided (Pre-filtering)
  let keywordObj = {};
  if (Array.isArray(keywords)) {
      keywordObj['default'] = keywords;
  } else if (typeof keywords === 'object' && keywords !== null) {
      keywordObj = keywords;
  }

  const hasKeywords = Object.keys(keywordObj).length > 0 && Object.values(keywordObj).some(arr => arr && arr.length > 0);

  if (hasKeywords) {
      const initialCount = filteredItems.length;
      const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\\]/g, '\\$&');
      
      const languageRegexes = {};
      Object.keys(keywordObj).forEach(lang => {
          const terms = keywordObj[lang] || [];
          languageRegexes[lang] = terms.map(k => ({
              term: k,
              regex: new RegExp(`\\b${escapeRegExp(k)}\\b`, 'i')
          }));
      });

      const allRegexes = Object.values(languageRegexes).flat();
      aggregatorLogger.info(`Applying Keyword Filter (Language Aware) on ${initialCount} items.`);
      
      const keptItems = [];

      filteredItems.forEach(item => {
          const title = (item.title || '');
          const content = (item.contentSnippet || item.content || ''); 
          
          let targetRegexes = allRegexes; 
          if (item._feedLang && languageRegexes[item._feedLang]) {
              targetRegexes = languageRegexes[item._feedLang];
          }

          const matched = targetRegexes.find(({ regex }) => regex.test(title) || regex.test(content));
          
          if (matched) {
              item.matchedKeyword = matched.term; 
              keptItems.push(item);
          }
      });
      
      filteredItems = keptItems;
      aggregatorLogger.info(`Keyword matching result: Kept ${filteredItems.length} items.`);
  }

  // Sort by date
  const sortedItems = filteredItems.sort((a, b) => {
      try {
        const dateA = a.pubDate ? new Date(a.pubDate) : new Date(0);
        const dateB = b.pubDate ? new Date(b.pubDate) : new Date(0);
        return dateB - dateA;
      } catch(e) {
        return 0; 
      }
  });
  
  aggregatorLogger.info(`Returning ${Math.min(sortedItems.length, 10000)} sorted items.`);
  return sortedItems.slice(0, 10000);
}

module.exports = {
  getAggregatedFeed,
  getFeedCategories
};