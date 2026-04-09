#!/usr/bin/env npx tsx
/**
 * X Integration - Read Home Timeline
 * Usage: echo '{"count":20}' | npx tsx read_timeline.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface ReadTimelineInput {
  /** Number of tweets to scrape. Default 20, max 50. */
  count?: number;
}

interface TweetAuthor {
  name: string;
  handle: string;
}

interface TweetMetrics {
  replies: number | null;
  retweets: number | null;
  likes: number | null;
}

interface Tweet {
  author: TweetAuthor;
  text: string;
  time: string | null;
  url: string | null;
  metrics: TweetMetrics;
  isRetweet: boolean;
  isQuote: boolean;
}

/**
 * Parse a metric count string like "1.2K", "42", or "" into a number or null.
 */
function parseMetricCount(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('k')) {
    const val = parseFloat(lower);
    return isNaN(val) ? null : Math.round(val * 1000);
  }
  if (lower.endsWith('m')) {
    const val = parseFloat(lower);
    return isNaN(val) ? null : Math.round(val * 1_000_000);
  }
  const val = parseInt(trimmed, 10);
  return isNaN(val) ? null : val;
}

async function readTimeline(input: ReadTimelineInput): Promise<ScriptResult> {
  const count = Math.min(input.count ?? 20, 50);

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://x.com/home', {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
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
        return {
          success: false,
          message: 'X login expired. Run /x-integration to re-authenticate.',
        };
      }
      return {
        success: false,
        message: 'Not logged in to X. Run /x-integration to authenticate.',
      };
    }

    // Scroll incrementally to load the desired number of tweets
    const seenUrls = new Set<string>();
    let scrollAttempts = 0;
    const maxScrollAttempts = 15;

    while (scrollAttempts < maxScrollAttempts) {
      const articles = await page.locator('article[data-testid="tweet"]').all();
      if (articles.length >= count) break;

      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(config.timeouts.afterClick * 1.5);
      scrollAttempts++;
    }

    // Extract tweet data from DOM
    const articles = await page.locator('article[data-testid="tweet"]').all();
    const tweets: Tweet[] = [];

    for (const article of articles) {
      if (tweets.length >= count) break;

      // --- author ---
      const userNameEl = article.locator('[data-testid="User-Name"]');
      const authorText = await userNameEl.textContent().catch(() => null);

      // X renders the name block as "Display Name@handle" or similar combined text.
      // Extract display name (first span) and handle (contains @).
      const nameSpans = await userNameEl.locator('span').allTextContents().catch(() => [] as string[]);
      const handle = nameSpans.find(s => s.startsWith('@')) ?? '';
      const name = nameSpans.find(s => s && !s.startsWith('@') && s.trim().length > 0) ?? authorText ?? '';

      // --- text ---
      const tweetTextEl = article.locator('[data-testid="tweetText"]');
      const text = await tweetTextEl.textContent().catch(() => '') ?? '';

      // --- time / url ---
      const timeEl = article.locator('time[datetime]');
      const time = await timeEl.getAttribute('datetime').catch(() => null);

      // The permalink wraps the <time> element
      const linkEl = timeEl.locator('xpath=..').locator('a');
      const href = await linkEl.getAttribute('href').catch(() => null);
      const url = href ? `https://x.com${href}` : null;

      // Deduplicate by URL when available, otherwise by text+author
      const dedupKey = url ?? `${name}|${text.slice(0, 80)}`;
      if (seenUrls.has(dedupKey)) continue;
      seenUrls.add(dedupKey);

      // --- metrics ---
      const replyRaw = await article
        .locator('[data-testid="reply"] span')
        .first()
        .textContent()
        .catch(() => null);

      // Retweet button switches testid when active
      const retweetRaw = await article
        .locator('[data-testid="retweet"] span, [data-testid="unretweet"] span')
        .first()
        .textContent()
        .catch(() => null);

      // Like button switches testid when active
      const likeRaw = await article
        .locator('[data-testid="like"] span, [data-testid="unlike"] span')
        .first()
        .textContent()
        .catch(() => null);

      const metrics: TweetMetrics = {
        replies: parseMetricCount(replyRaw),
        retweets: parseMetricCount(retweetRaw),
        likes: parseMetricCount(likeRaw),
      };

      // --- retweet / quote indicators ---
      const isRetweet = await article
        .locator('[data-testid="socialContext"]')
        .isVisible()
        .catch(() => false);

      // A quote tweet contains a nested tweet card inside the article
      const isQuote = await article
        .locator('[data-testid="tweet"] [data-testid="tweetText"]')
        .count()
        .then(n => n > 1)
        .catch(() => false);

      tweets.push({
        author: { name: name.trim(), handle: handle.trim() },
        text: text.trim(),
        time,
        url,
        metrics,
        isRetweet,
        isQuote,
      });
    }

    return {
      success: true,
      message: `Read ${tweets.length} tweet${tweets.length !== 1 ? 's' : ''} from timeline`,
      data: { tweets },
    };

  } finally {
    if (context) await context.close();
  }
}

runScript<ReadTimelineInput>(readTimeline);
