#!/usr/bin/env npx tsx
/**
 * X Integration - Search Tweets
 * Usage: echo '{"query":"BTC","count":20,"tab":"latest"}' | npx tsx search.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface SearchInput {
  /** Search query (e.g., "BTC", "from:elonmusk", "#crypto") */
  query: string;
  /** Number of tweets to return. Default 20, max 50. */
  count?: number;
  /** Search tab. Default 'latest'. */
  tab?: 'top' | 'latest' | 'people' | 'media';
}

interface TweetAuthor {
  name: string;
  handle: string;
}

interface TweetMetrics {
  replies: number;
  retweets: number;
  likes: number;
}

interface TweetData {
  author: TweetAuthor;
  text: string;
  time: string;
  url: string;
  metrics: TweetMetrics;
  isRetweet: boolean;
  isQuote: boolean;
}

/**
 * Map the tab value to the X search filter param.
 */
function tabToFilter(tab: SearchInput['tab']): string {
  switch (tab) {
    case 'latest': return 'live';
    case 'people':  return 'user';
    case 'media':   return 'media';
    case 'top':
    default:        return '';
  }
}

/**
 * Parse a metric count string like "1.2K" or "42" into a number.
 */
function parseCount(raw: string | null): number {
  if (!raw) return 0;
  const s = raw.trim().replace(/,/g, '');
  if (s.endsWith('K')) return Math.round(parseFloat(s) * 1_000);
  if (s.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000);
  return parseInt(s, 10) || 0;
}

async function searchTweets(input: SearchInput): Promise<ScriptResult> {
  const { query, count = 20, tab = 'latest' } = input;

  if (!query || query.trim().length === 0) {
    return { success: false, message: 'Please provide a search query' };
  }

  const limit = Math.min(count, 50);
  const filter = tabToFilter(tab);
  const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query${filter ? `&f=${filter}` : ''}`;

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto(url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check login status
    const isLoggedIn = await page
      .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
      .isVisible()
      .catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page
        .locator('input[autocomplete="username"]')
        .isVisible()
        .catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.' };
      }
    }

    // Scroll until we have enough tweets or no new ones load
    const articleSelector = 'article[data-testid="tweet"]';
    let previousCount = 0;
    let staleRounds = 0;

    while (staleRounds < 3) {
      const currentCount = await page.locator(articleSelector).count().catch(() => 0);
      if (currentCount >= limit) break;
      if (currentCount === previousCount) {
        staleRounds++;
      } else {
        staleRounds = 0;
        previousCount = currentCount;
      }
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(1500);
    }

    // Extract tweet data
    const articles = await page.locator(articleSelector).all();
    const tweets: TweetData[] = [];

    for (const article of articles.slice(0, limit)) {
      // Author name and handle
      const authorEl = article.locator('[data-testid="User-Name"]').first();
      const authorText = await authorEl.innerText().catch(() => '');
      const authorLines = authorText.split('\n').map(s => s.trim()).filter(Boolean);
      const author: TweetAuthor = {
        name:   authorLines[0] ?? '',
        handle: authorLines.find(l => l.startsWith('@')) ?? '',
      };

      // Tweet text
      const text = await article
        .locator('[data-testid="tweetText"]')
        .first()
        .innerText()
        .catch(() => '');

      // Timestamp
      const time = await article
        .locator('time[datetime]')
        .first()
        .getAttribute('datetime')
        .catch(() => '') ?? '';

      // Permalink — <a> containing the <time>
      const url = await article
        .locator('a[href*="/status/"]')
        .first()
        .getAttribute('href')
        .catch(() => null);
      const permalink = url ? `https://x.com${url}` : '';

      // Metrics
      const likeRaw = await article
        .locator('[data-testid="like"] span, [data-testid="unlike"] span')
        .first()
        .innerText()
        .catch(() => null);
      const retweetRaw = await article
        .locator('[data-testid="retweet"] span, [data-testid="unretweet"] span')
        .first()
        .innerText()
        .catch(() => null);
      const replyRaw = await article
        .locator('[data-testid="reply"] span')
        .first()
        .innerText()
        .catch(() => null);

      const metrics: TweetMetrics = {
        replies:  parseCount(replyRaw),
        retweets: parseCount(retweetRaw),
        likes:    parseCount(likeRaw),
      };

      // Retweet / quote flags
      const isRetweet = await article
        .locator('[data-testid="socialContext"]')
        .first()
        .innerText()
        .then(t => /retweeted/i.test(t))
        .catch(() => false);

      const isQuote = await article
        .locator('[data-testid="tweet"] [data-testid="tweet"]')
        .count()
        .then(n => n > 0)
        .catch(() => false);

      tweets.push({ author, text, time, url: permalink, metrics, isRetweet, isQuote });
    }

    return {
      success: true,
      message: `Found ${tweets.length} tweet${tweets.length === 1 ? '' : 's'} for query: ${query}`,
      data: { tweets, query },
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<SearchInput>(searchTweets);
