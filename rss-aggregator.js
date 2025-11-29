const Parser = require('rss-parser');
const fs = require('fs/promises');
const path = require('path');
const { Logger, EMOJIS } = require('./utils');

const parser = new Parser();
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

async function fetchAndParseFeed(feedUrl) {
  try {
    aggregatorLogger.info(`Fetching custom RSS feed: ${feedUrl}`);
    const feed = await parser.parseURL(feedUrl);
    return feed.items || [];
  } catch (error) {
    console.error(`Error fetching feed: ${feedUrl}`, error.message);
    return [];
  }
}

async function getAggregatedFeed(categories = []) {
  const allCategories = await getFeedCategories();
  let feedsToFetch = [];

  if (categories.length === 0) {
    // If no category is specified, fetch all feeds
    for (const categoryKey in allCategories) {
      feedsToFetch.push(...allCategories[categoryKey].feeds);
    }
  } else {
    // Fetch feeds from specified categories
    for (const category of categories) {
      if (allCategories[category]) {
        feedsToFetch.push(...allCategories[category].feeds);
      }
    }
  }

  if (feedsToFetch.length === 0) {
    return [];
  }

  const feedPromises = feedsToFetch.map(feed => fetchAndParseFeed(feed.url));
  const allItems = await Promise.all(feedPromises);

  // Flatten the array of arrays and sort by date
  const sortedItems = allItems
    .flat()
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  return sortedItems;
}

module.exports = {
  getAggregatedFeed,
  getFeedCategories
};
