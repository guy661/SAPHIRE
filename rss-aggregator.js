const Parser = require('rss-parser');
const fs = require('fs/promises');
const path = require('path');
const { Logger, EMOJIS } = require('./utils');

// FIX: Configure a browser-like User-Agent to prevent getting blocked
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

async function getFeedCategories() {
  if (!feedCategories) {
    const data = await fs.readFile(feedsFilePath, 'utf-8');
    feedCategories = JSON.parse(data);
  }
  return feedCategories;
}

const axios = require('axios');
// const Parser is already required at the top

async function fetchAndParseFeed(feedConfig) {
  const { name, url } = feedConfig;
  try {
    // aggregatorLogger.info(`Fetching custom RSS feed: ${name} (${url})`);

    // 1. Abrufen mit echten Browser-Headern & SSL-Toleranz
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, text/html, */*',
        'Cache-Control': 'no-cache'
      },
      // Ignoriert abgelaufene/falsche Zertifikate
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
      // Erzwingt, dass Axios den Body als Text zurückgibt (vermeidet Parsing-Probleme)
      responseType: 'text'
    });

    // 2. XML bereinigen (Fix für "Non-whitespace before first tag", BOM, etc.)
    let cleanXml = response.data;
    if (typeof cleanXml === 'string') {
        cleanXml = cleanXml.trim();
        // Schneidet alles vor dem ersten '<' ab (z.B. Leerzeichen oder Debug-Output vom Server)
        const xmlStart = cleanXml.indexOf('<');
        if (xmlStart > 0) {
            cleanXml = cleanXml.substring(xmlStart);
        }
    }

    // 3. String parsen
    const feed = await parser.parseString(cleanXml);
    const items = feed.items || [];
    
    // Inject the source name into each article
    items.forEach(item => {
      item.sourceName = name;
    });
    return items;

  } catch (error) {
    // Fehlerbehandlung: DNS-Fehler (ENOTFOUND) und 404 sind "normal" bei toten Feeds
    if (error.code === 'ENOTFOUND') {
        // aggregatorLogger.warn(`DNS Error for ${url}: Host not found.`);
    } else if (error.response && error.response.status === 404) {
        // aggregatorLogger.warn(`Feed not found (404): ${url}`);
    } else if (error.response && error.response.status === 403) {
        // aggregatorLogger.warn(`Access denied (403) for ${url} - checking headers might help.`);
    } else {
        // XML Fehler loggen, aber nicht crashen
        aggregatorLogger.warn(`Error processing feed ${name}: ${error.message}`);
    }
    return [];
  }
}

async function getAggregatedFeed(categories = []) {
  // aggregatorLogger.info(`Aggregator called with categories: [${categories.join(', ')}]`);
  const allCategories = await getFeedCategories();
  let feedsToFetch = [];

  if (categories.length === 0) {
    // aggregatorLogger.warn(`No categories provided. Fetching all feeds from all categories.`);
    for (const categoryKey in allCategories) {
      feedsToFetch.push(...allCategories[categoryKey].feeds);
    }
  } else {
    for (const category of categories) {
      if (allCategories[category]) {
        feedsToFetch.push(...allCategories[category].feeds);
      } else {
        aggregatorLogger.warn(`Category "${category}" not found in feeds.json.`);
      }
    }
  }

  // aggregatorLogger.info(`Found ${feedsToFetch.length} feeds to fetch in total.`);
  if (feedsToFetch.length === 0) {
    return [];
  }

  const feedPromises = feedsToFetch.map(feed => fetchAndParseFeed(feed));
  const allItems = await Promise.all(feedPromises);
  const flattenedItems = allItems.flat();
  // aggregatorLogger.info(`Total items fetched from all feeds: ${flattenedItems.length}`);

  // Sort by date
  const sortedItems = flattenedItems.sort((a, b) => {
      try {
        return new Date(b.pubDate) - new Date(a.pubDate);
      } catch(e) {
        return 0; // Don't sort if dates are invalid
      }
  });
  
  // aggregatorLogger.info(`Returning ${Math.min(sortedItems.length, 50)} sorted items.`);
  return sortedItems.slice(0, 50);
}

module.exports = {
  getAggregatedFeed,
  getFeedCategories
};
