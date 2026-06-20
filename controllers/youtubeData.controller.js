'use strict';

require('dotenv').config();

const { fetch, Agent } = require('undici');
const YouTubeData = require('../models/youtubeData.model');

let saveErrorLog = async () => {};
try {
  saveErrorLog = require('../services/errorLog.service');
} catch (_) {}

function tryRequireModel(paths) {
  for (const p of paths) {
    try {
      return require(p);
    } catch (_) {}
  }
  return null;
}

const Campaign =
  tryRequireModel([
    '../models/campaign.model',
    '../models/campaignModel',
    '../models/Campaign',
    '../models/campaign',
  ]) || null;

const InfoMediaKit =
  tryRequireModel([
    '../models/infoMediaKit.model',
    '../models/infoMediaKit',
    '../models/InfoMediaKit',
  ]) || null;

/* -------------------------------------------------------------------------- */
/*                            YouTube key rotation                            */
/* -------------------------------------------------------------------------- */

const YT_API_KEYS = String(process.env.YOUTUBE_API_KEY || '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

let keyIndex = 0;

function currentKey() {
  return YT_API_KEYS[keyIndex] || '';
}

function rotateKey() {
  if (YT_API_KEYS.length > 1) {
    keyIndex = (keyIndex + 1) % YT_API_KEYS.length;
  }
}

function isQuotaError(status, body) {
  if (status !== 403 && status !== 429) return false;
  return /quota|dailyLimit|rateLimit|userRateLimit|exceeded|suspended|keyInvalid/i.test(
    String(body || '')
  );
}

/* -------------------------------------------------------------------------- */
/*                            YouTube HTTP wrapper                            */
/* -------------------------------------------------------------------------- */

const YT_TIMEOUT_MS = Number(process.env.YOUTUBE_TIMEOUT_MS || 12000);
const RECENT_VIDEO_SAMPLE = Number(process.env.YOUTUBE_RECENT_VIDEO_SAMPLE || 25);

// Fetch enough YouTube candidates for discovery.
// YouTube returns max 50 videos per search page, so we use pageToken pagination.
const SEARCH_RESULTS_PER_QUERY = Number(process.env.YOUTUBE_SEARCH_RESULTS_PER_QUERY || 50);
const SEARCH_PAGES_PER_QUERY = Number(process.env.YOUTUBE_SEARCH_PAGES_PER_QUERY || 4);
const MAX_SEARCH_QUERIES = Number(process.env.YOUTUBE_MAX_SEARCH_QUERIES || 20);
const TARGET_CHANNELS_PER_SEARCH = Number(process.env.YOUTUBE_TARGET_CHANNELS_PER_SEARCH || 100);
const RAW_CHANNELS_PER_SEARCH = Number(
  process.env.YOUTUBE_RAW_CHANNELS_PER_SEARCH || Math.max(300, TARGET_CHANNELS_PER_SEARCH * 4)
);
const MIN_AVG_VIEWS_DEFAULT = Number(process.env.YOUTUBE_MIN_AVG_VIEWS || 0);

// Creator activity lookback. Old Apps Script used 90 days; this update uses last 2 years.
// You can override with CREATOR_LOOKBACK_DAYS or DAYS_LOOKBACK_CREATORS in .env.
const CREATOR_LOOKBACK_DAYS = Number(
  process.env.CREATOR_LOOKBACK_DAYS || process.env.DAYS_LOOKBACK_CREATORS || 730
);

// Default behavior is soft filtering, so each discovery search can return a full candidate pool.
// Pass strictFilters=true in the API query only when you want tier/country to be hard filters.
const STRICT_FILTERS_DEFAULT =
  String(process.env.YOUTUBE_STRICT_FILTERS_DEFAULT || 'false').toLowerCase() === 'true';

/* -------------------------------------------------------------------------- */
/*                     Optional OpenAI creator intelligence                   */
/* -------------------------------------------------------------------------- */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_ANALYSIS_ENABLED =
  String(process.env.OPENAI_CREATOR_ANALYSIS_ENABLED || 'true').toLowerCase() !== 'false' &&
  Boolean(OPENAI_API_KEY);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 25000);
const OPENAI_MAX_ANALYSIS_PER_REQUEST = Number(
  process.env.OPENAI_MAX_ANALYSIS_PER_REQUEST || 50
);

const httpAgent = new Agent({
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 60000,
});

const YT_BASE = process.env.YOUTUBE_API_BASE_URL || 'https://www.googleapis.com/youtube/v3';
const YT_SEARCH = `${YT_BASE}/search`;
const YT_CHANNELS = `${YT_BASE}/channels`;
const YT_PLAYLIST_ITEMS = `${YT_BASE}/playlistItems`;
const YT_VIDEOS = `${YT_BASE}/videos`;

async function ytFetch(baseUrl, params, timeoutMs = YT_TIMEOUT_MS) {
  if (!YT_API_KEYS.length) {
    const err = new Error('Missing YOUTUBE_API_KEY in backend .env');
    err.status = 500;
    throw err;
  }

  let lastErr = null;

  for (let attempt = 0; attempt < YT_API_KEYS.length; attempt += 1) {
    params.set('key', currentKey());

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('YouTube API timeout')), timeoutMs);

    try {
      const res = await fetch(`${baseUrl}?${params.toString()}`, {
        dispatcher: httpAgent,
        signal: ac.signal,
      });

      if (res.ok) return await res.json();

      const body = await res.text().catch(() => '');

      if (isQuotaError(res.status, body)) {
        lastErr = new Error(`YouTube key #${keyIndex + 1} quota/forbidden (${res.status})`);
        lastErr.status = res.status;
        rotateKey();
        continue;
      }

      const err = new Error(`YouTube API ${res.status}: ${body || res.statusText}`);
      err.status = res.status;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  const exhausted = lastErr || new Error('All YouTube API keys are exhausted or invalid');
  exhausted.status = exhausted.status || 429;
  throw exhausted;
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function cleanStr(v) {
  if (v === null || typeof v === 'undefined') return '';
  return String(v).trim();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toIntOrNull(v) {
  if (v === null || v === '' || typeof v === 'undefined') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickThumb(thumbnails = {}) {
  return (
    thumbnails?.maxres?.url ||
    thumbnails?.standard?.url ||
    thumbnails?.high?.url ||
    thumbnails?.medium?.url ||
    thumbnails?.default?.url ||
    ''
  );
}

function channelUrlFor(channelId, customUrl) {
  const handle = cleanStr(customUrl);
  if (handle) return `https://www.youtube.com/${handle.startsWith('@') ? handle : `@${handle.replace(/^@/, '')}`}`;
  return channelId ? `https://www.youtube.com/channel/${channelId}` : '';
}

function labelFromWikiUrl(url) {
  try {
    const last = decodeURIComponent(String(url).split('/').pop() || '');
    return last.replace(/_/g, ' ');
  } catch {
    return String(url || '');
  }
}

function chunkArray(arr = [], size = 50) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function daysBetween(a, b) {
  const x = new Date(a).getTime();
  const y = new Date(b).getTime();
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.abs(y - x) / (1000 * 60 * 60 * 24);
}

function getCreatorLookbackStartDate() {
  if (!CREATOR_LOOKBACK_DAYS || CREATOR_LOOKBACK_DAYS <= 0) return null;
  return new Date(Date.now() - CREATOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

function isCreatorActiveWithinLookback(doc) {
  const startDate = getCreatorLookbackStartDate();
  if (!startDate) return true;

  const recentUploadDate = doc?.recentUploadDate ? new Date(doc.recentUploadDate) : null;
  if (!recentUploadDate || Number.isNaN(recentUploadDate.getTime())) return false;

  return recentUploadDate >= startDate;
}

function countVideosWithinLookback(videos = []) {
  const startDate = getCreatorLookbackStartDate();
  if (!startDate) return videos.length;

  return (videos || []).filter((video) => {
    const publishedAt = video?.publishedAt ? new Date(video.publishedAt) : null;
    return publishedAt && !Number.isNaN(publishedAt.getTime()) && publishedAt >= startDate;
  }).length;
}

function splitWords(value) {
  return cleanStr(value)
    .split(/[\s,|/]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function getSubscriberTierRange(tier) {
  const value = cleanStr(tier).toLowerCase();
  const map = {
    nano: { min: 1000, max: 10000 },
    micro: { min: 10000, max: 100000 },
    mid: { min: 100000, max: 500000 },
    'mid-tier': { min: 100000, max: 500000 },
    mid_tier: { min: 100000, max: 500000 },
    midtier: { min: 100000, max: 500000 },
    macro: { min: 500000, max: 1000000 },
    mega: { min: 1000000, max: null },
  };
  return map[value] || null;
}

function getTierFromSubscribers(subscribers) {
  const subs = Number(subscribers || 0);
  if (subs >= 1000000) return 'Mega';
  if (subs >= 500000) return 'Macro';
  if (subs >= 100000) return 'Mid-tier';
  if (subs >= 10000) return 'Micro';
  return 'Nano';
}

function parsePercentOrNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const n = parseFloat(String(value).replace('%', '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function detectLanguage(text = '') {
  const value = String(text || '');
  if (/[\u0900-\u097F]/.test(value)) return 'Hindi';
  if (/[\u0B80-\u0BFF]/.test(value)) return 'Tamil';
  if (/[\u0C00-\u0C7F]/.test(value)) return 'Telugu';
  if (/[\u0980-\u09FF]/.test(value)) return 'Bengali';
  if (/[\u0600-\u06FF]/.test(value)) return 'Arabic';
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(value)) return 'Japanese/Chinese';
  if (/[áéíóúñ¿¡]/i.test(value)) return 'Spanish';
  return 'English';
}

function estimateAudienceCountry(channelCountry, text = '') {
  const country = cleanStr(channelCountry).toUpperCase();
  const hay = String(text || '').toLowerCase();

  if (country) {
    return { estimatedAudienceCountry: country, audienceCountryConfidence: 75 };
  }

  const signalMap = {
    IN: ['india', 'hindi', 'rupees', '₹', 'flipkart', 'myntra', 'zomato', 'swiggy', 'upi', 'paytm', 'zerodha', 'upstox', 'delhi', 'mumbai', 'bangalore', 'bengaluru'],
    US: ['usa', 'united states', 'dollar', '$', 'walmart', 'best buy', 'target'],
    GB: ['uk', 'united kingdom', 'london', 'pound', '£'],
    AE: ['uae', 'dubai', 'dirham', 'aed'],
  };

  const scored = Object.entries(signalMap)
    .map(([code, signals]) => ({ code, score: signals.reduce((n, s) => n + (hay.includes(s) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score)[0];

  if (!scored || scored.score === 0) return { estimatedAudienceCountry: '', audienceCountryConfidence: 0 };
  return { estimatedAudienceCountry: scored.code, audienceCountryConfidence: Math.min(90, 45 + scored.score * 10) };
}

function extractUrls(text = '') {
  const matches = String(text || '').match(/https?:\/\/[^\s)\]}>"']+/gi);
  return Array.from(new Set(matches || []));
}

function extractEmails(text = '') {
  const matches = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return filterJunkEmails(Array.from(new Set(matches || [])));
}

const JUNK_PATTERNS = ['example.com', 'sentry', 'webpack', 'google.com', 'youtube.com', 'schema.org', 'gstatic', 'googleapis', 'w3.org', 'noreply', 'no-reply', 'wixpress', 'cloudflare'];

function filterJunkEmails(emails = []) {
  return emails.filter((email) => {
    const emailLower = String(email).toLowerCase();
    if (emailLower.length < 6) return false;
    return !JUNK_PATTERNS.some((pat) => emailLower.includes(pat));
  });
}

function extractContactAndSponsors(channelDescription = '', videos = []) {
  const allText = [channelDescription, ...videos.map((v) => `${v.title || ''}\n${v.description || ''}`)].join('\n\n');
  const urls = extractUrls(allText);
  const emails = extractEmails(allText);

  const socials = urls.filter((url) => /instagram\.com|twitter\.com|x\.com|facebook\.com|tiktok\.com|linkedin\.com|threads\.net/i.test(url));
  const websites = urls.filter((url) => !/youtube\.com|youtu\.be|instagram\.com|twitter\.com|x\.com|facebook\.com|tiktok\.com|linkedin\.com|threads\.net/i.test(url));

  const sponsors = [];
  for (const video of videos) {
    const text = `${video.title || ''}\n${video.description || ''}`;
    if (/sponsored by|sponsor|partnered with|in partnership with|collaboration with|collab with|thanks to|use code|promo code|#ad|#sponsored/i.test(text)) {
      const brandMatches = text.match(/\b(Samsung|OnePlus|Boat|boAt|Amazon|Flipkart|Myntra|Google|Apple|Baseus|Anker|Nike|Adidas|Razorpay|Zerodha|Upstox|Notion|Canva|NordVPN|Surfshark|Skillshare|Squarespace|Audible)\b/gi);
      if (brandMatches) sponsors.push(...brandMatches);
    }
  }

  const instagram = socials.find((x) => /instagram\.com/i.test(x)) || '';
  const twitter = socials.find((x) => /twitter\.com|x\.com/i.test(x)) || '';
  const facebook = socials.find((x) => /facebook\.com/i.test(x)) || '';
  const linkedin = socials.find((x) => /linkedin\.com/i.test(x)) || '';
  const website = websites[0] || '';

  return {
    emails,
    socials: Array.from(new Set(socials)),
    websites: Array.from(new Set(websites)),
    sponsors: Array.from(new Set(sponsors.map((s) => s.trim()))),
    otherLinks: Array.from(new Set(urls.filter((u) => !socials.includes(u) && !websites.includes(u)))),
    instagram,
    twitter,
    facebook,
    linkedin,
    website,
    youtubeAboutEmail: emails[0] || '',
    totalEmails: emails,
  };
}



/* -------------------------------------------------------------------------- */
/*             OpenAI analysis: Apps Script-style intelligence layer           */
/* -------------------------------------------------------------------------- */

function safeJsonParse(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (_) {}

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function mergeUniqueArray(...lists) {
  const seen = new Set();
  const out = [];

  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const clean = cleanStr(item);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
    }
  }

  return out;
}

async function callOpenAIForJSON(messages, timeoutMs = OPENAI_TIMEOUT_MS) {
  if (!OPENAI_ANALYSIS_ENABLED) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('OpenAI API timeout')), timeoutMs);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      dispatcher: httpAgent,
      signal: ac.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 1800,
        response_format: { type: 'json_object' },
      }),
    });

    const body = await res.text();

    if (!res.ok) {
      const err = new Error(`OpenAI API ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }

    const json = JSON.parse(body);
    const content = json?.choices?.[0]?.message?.content || '';
    return safeJsonParse(content);
  } finally {
    clearTimeout(timer);
  }
}

function buildCreatorAIPrompt(doc, campaignDetails = {}) {
  const videos = (doc.recentVideos || []).slice(0, 12).map((video, index) => ({
    number: index + 1,
    title: video.title || '',
    description: String(video.description || '').slice(0, 700),
    views: video.views || 0,
    likes: video.likes || 0,
    comments: video.comments || 0,
    publishedAt: video.publishedAt || '',
  }));

  return [
    {
      role: 'system',
      content:
        'You analyze YouTube creators for influencer discovery. Return strict JSON only. Be conservative and do not invent contact details. Use null/empty arrays when unknown.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Analyze this YouTube creator using the same logic as a creator discovery/shortlist pipeline.',
        campaign: {
          productName: campaignDetails.productName || '',
          niche: campaignDetails.campaignNiche || '',
          targetCountry: campaignDetails.targetCountry || '',
          keywords: campaignDetails.keywords || [],
        },
        creator: {
          channelName: doc.channelName,
          channelUrl: doc.channelUrl,
          subscribers: doc.subscribers,
          country: doc.country,
          estimatedAudienceCountry: doc.estimatedAudienceCountry,
          avgViews: doc.avgViews,
          avgLikes: doc.avgLikes,
          avgComments: doc.avgComments,
          engagementRate: doc.engagementRate,
          totalVideos: doc.totalVideos,
          totalViews: doc.totalViews,
          category: doc.category,
          description: String(doc.description || '').slice(0, 1500),
          channelTags: doc.channelTags || [],
          foundViaQuery: doc.foundViaQuery,
          sourceVideoTitle: doc.sourceVideoTitle,
          recentVideos: videos,
        },
        outputSchema: {
          channelCategory: 'specific 1-3 word category, e.g. Tech Reviews, Beauty, Fitness, Gaming, Lifestyle, Education',
          contentFlag: 'one of Original, AI Generated, Compilation, Mixed, Brand Channel',
          contentQuality: 'one of Original Reviews, Mixed, Listicle/Voiceover, Brand/Official, Low Quality',
          nicheFit: 'number 1-10',
          previousSponsors: 'string, comma-separated brand names or N/A',
          countryMatch: 'Yes, No, or Unknown',
          estimatedAudienceCountry: 'ISO 2-letter country code or empty string',
          audienceCountryConfidence: 'number 0-100',
          brandSafetyScore: 'number 0-100',
          sponsorshipScore: 'number 0-100',
          relevancyScore: 'number 0-100',
          authenticityScore: 'number 0-100',
          shortlistScore: 'number 0-100',
          shortlistStatus: 'Shortlisted or Excluded',
          filterFailureReason: 'empty string if Shortlisted, otherwise reason',
          channelTags: ['deduplicated topical tags'],
          contact: {
            emails: ['emails explicitly visible in descriptions only'],
            socials: ['social URLs explicitly visible only'],
            websites: ['website URLs explicitly visible only'],
            sponsors: ['sponsor/partner brand names explicitly detected only'],
          },
        },
      }),
    },
  ];
}

async function analyzeCreatorWithOpenAI(doc, campaignDetails = {}) {
  try {
    return await callOpenAIForJSON(buildCreatorAIPrompt(doc, campaignDetails));
  } catch (err) {
    // OpenAI should improve quality, not break discovery. Fall back to deterministic scoring.
    return null;
  }
}

function applyOpenAIAnalysisToDoc(doc, ai = {}) {
  if (!ai || typeof ai !== 'object') return doc;

  const channelCategory = cleanStr(ai.channelCategory);
  const contentFlag = cleanStr(ai.contentFlag);
  const contentQuality = cleanStr(ai.contentQuality);
  const estimatedCountry = cleanStr(ai.estimatedAudienceCountry).toUpperCase();

  if (channelCategory) {
    doc.channelCategory = channelCategory;
    doc.category = channelCategory;
  }

  if (contentFlag) doc.contentFlag = contentFlag;
  if (estimatedCountry) doc.estimatedAudienceCountry = estimatedCountry;

  doc.channelTags = mergeUniqueArray(doc.channelTags, ai.channelTags);

  doc.contact = {
    ...(doc.contact || {}),
    emails: mergeUniqueArray(doc.contact?.emails, ai.contact?.emails),
    socials: mergeUniqueArray(doc.contact?.socials, ai.contact?.socials),
    websites: mergeUniqueArray(doc.contact?.websites, ai.contact?.websites),
    sponsors: mergeUniqueArray(doc.contact?.sponsors, ai.contact?.sponsors),
    instagram:
      doc.contact?.instagram ||
      (ai.contact?.socials || []).find((x) => /instagram\.com/i.test(x)) ||
      '',
    twitter:
      doc.contact?.twitter ||
      (ai.contact?.socials || []).find((x) => /twitter\.com|x\.com/i.test(x)) ||
      '',
    facebook:
      doc.contact?.facebook ||
      (ai.contact?.socials || []).find((x) => /facebook\.com/i.test(x)) ||
      '',
    linkedin:
      doc.contact?.linkedin ||
      (ai.contact?.socials || []).find((x) => /linkedin\.com/i.test(x)) ||
      '',
    website: doc.contact?.website || ai.contact?.websites?.[0] || '',
  };

  doc.contact.totalEmails = mergeUniqueArray(doc.contact.totalEmails, doc.contact.emails);
  doc.contact.youtubeAboutEmail = doc.contact.youtubeAboutEmail || doc.contact.totalEmails?.[0] || '';

  doc.scores = {
    ...(doc.scores || {}),
    sponsorshipScore: clampNumber(ai.sponsorshipScore, 0, 100, doc.scores?.sponsorshipScore || 0),
    brandSafetyScore: clampNumber(ai.brandSafetyScore, 0, 100, doc.scores?.brandSafetyScore || 90),
    relevancyScore: clampNumber(ai.relevancyScore, 0, 100, doc.scores?.relevancyScore || 0),
    authenticityScore: clampNumber(ai.authenticityScore, 0, 100, doc.scores?.authenticityScore || 85),
    audienceCountryConfidence: clampNumber(
      ai.audienceCountryConfidence,
      0,
      100,
      doc.scores?.audienceCountryConfidence || 0
    ),
    shortlistScore: clampNumber(ai.shortlistScore, 0, 100, doc.scores?.shortlistScore || 0),
    nicheFit: clampNumber(ai.nicheFit, 1, 10, doc.scores?.nicheFit || 1),
  };

  const aiStatus = cleanStr(ai.shortlistStatus);
  const aiFailureReason = cleanStr(ai.filterFailureReason);

  doc.shortlist = {
    ...(doc.shortlist || {}),
    nicheFit: doc.scores.nicheFit,
    contentQuality: contentQuality || doc.shortlist?.contentQuality || detectContentQuality(doc.recentVideos || []),
    previousSponsors: cleanStr(ai.previousSponsors) || doc.shortlist?.previousSponsors || detectPreviousSponsors(doc),
    uploadFrequency:
      doc.shortlist?.uploadFrequency ||
      getUploadFrequencyLabel(doc.uploadFrequency30Days, doc.uploadFrequency90Days),
    countryMatch: cleanStr(ai.countryMatch) || doc.shortlist?.countryMatch || 'Unknown',
    score: doc.scores.shortlistScore || doc.shortlist?.score || doc.scores.relevancyScore || 0,
    status: aiStatus === 'Excluded' ? 'Excluded' : aiFailureReason ? 'Excluded' : 'Shortlisted',
    filterFailureReason: aiFailureReason,
  };

  return doc;
}

/* -------------------------------------------------------------------------- */
/*                Influencer discovery logic mirroring Apps Script            */
/* -------------------------------------------------------------------------- */

function detectContentFlag(channel, videos = []) {
  const snippet = channel?.snippet || {};
  const title = cleanStr(snippet.title).toLowerCase();
  const desc = cleanStr(snippet.description).toLowerCase();
  const text = `${title} ${desc} ${videos.map((v) => `${v.title} ${v.description}`).join(' ')}`.toLowerCase();

  if (/official|company|brand|store|shop|inc\.|llc|private limited|pvt ltd|corporation/.test(title) || /official channel|official youtube channel|home to everything|welcome to the official|manufacturer|global leader/i.test(desc)) return 'Brand Channel';
  if (/compilation|clips|highlights|reupload|re-upload|best moments|top moments/.test(text)) return 'Compilation';
  if (/ai generated|generated by ai|text to speech|synthetic voice|ai voice/.test(text)) return 'AI Generated';
  if (/review|unboxing|tested|hands on|vlog|tutorial|demo|comparison|vs/.test(text)) return 'Original';
  return 'Mixed';
}

function getFilterFailureReasonForCreator(doc) {
  const contentFlag = cleanStr(doc.contentFlag).toLowerCase();
  const category = cleanStr(doc.channelCategory || doc.category).toLowerCase();
  const engagement = parsePercentOrNumber(doc.engagementRate);

  if (contentFlag === 'ai generated' || contentFlag === 'compilation' || contentFlag === 'brand channel') return `Content Flag: ${doc.contentFlag}`;
  if (category.includes('publication') || category.includes('trade') || category.includes('news outlet')) return `Channel Category: ${doc.channelCategory || doc.category}`;
  if (engagement < 0.5) return `Engagement Rate below 0.5%: ${doc.engagementRate}`;
  return '';
}

function getUploadFrequencyLabel(uploadFrequency30Days, uploadFrequency90Days) {
  const uploads30 = Number(uploadFrequency30Days || 0);
  const uploads90 = Number(uploadFrequency90Days || 0);
  if (uploads30 >= 20) return 'Daily';
  if (uploads30 >= 8) return '2x/week';
  if (uploads30 >= 4) return 'Weekly';
  if (uploads90 >= 3) return 'Monthly';
  return 'Unknown';
}

function detectContentQuality(recentVideos = []) {
  const text = recentVideos.map((v) => `${v.title || ''} ${v.description || ''}`).join(' ').toLowerCase();
  if (/top\s*\d+|best|list|ranking|compilation|voiceover/.test(text)) return 'Listicle/Voiceover';
  if (/review|unboxing|unbox|tested|hands on|demo|comparison|vs|first look/.test(text)) return 'Original Reviews';
  return 'Mixed';
}

function detectPreviousSponsors(doc) {
  const existingSponsors = doc.contact?.sponsors || [];
  if (existingSponsors.length) return existingSponsors.join(', ');

  const sponsors = [];
  for (const video of doc.recentVideos || []) {
    const text = `${video.title || ''} ${video.description || ''}`;
    if (/sponsored|partnered|collaboration|#ad|#sponsored|use code|promo code|thanks to/i.test(text)) sponsors.push(video.title || 'Sponsored video detected');
  }
  return sponsors.length ? sponsors.slice(0, 5).join(', ') : 'N/A';
}

function calculateNicheFit(doc, campaignKeyword) {
  const target = cleanStr(campaignKeyword || doc.category || doc.channelCategory).toLowerCase();
  if (!target) return 1;

  const words = splitWords(target);
  if (!words.length) return 1;

  const creatorText = [
    doc.channelName,
    doc.description,
    doc.category,
    doc.channelCategory,
    ...(doc.channelTags || []),
    ...(doc.recentVideos || []).map((v) => `${v.title || ''} ${v.description || ''}`),
  ].join(' ').toLowerCase();

  const matched = words.filter((word) => creatorText.includes(word)).length;
  return Math.max(1, Math.min(10, Math.round((matched / words.length) * 10)));
}

function getCountryMatch(doc, targetCountry) {
  const target = cleanStr(targetCountry).toUpperCase();
  if (!target) return 'Unknown';

  const channelCountry = cleanStr(doc.country).toUpperCase();
  const estimatedCountry = cleanStr(doc.estimatedAudienceCountry).toUpperCase();
  if (channelCountry === target || estimatedCountry === target) return 'Yes';
  if (!channelCountry && !estimatedCountry) return 'Unknown';
  return 'No';
}

function calculateShortlistScore({ nicheFit, engagementRate, avgViews, subscribers, contentQuality, countryMatch }) {
  let score = 0;
  score += nicheFit * 5;
  if (contentQuality === 'Original Reviews') score += 15;
  else if (contentQuality === 'Mixed') score += 8;
  else score += 5;
  if (countryMatch === 'Yes') score += 15;
  else if (countryMatch === 'Unknown') score += 7;
  if (engagementRate >= 5) score += 15;
  else if (engagementRate >= 2) score += 10;
  else if (engagementRate >= 0.5) score += 5;
  if (avgViews >= 100000) score += 10;
  else if (avgViews >= 50000) score += 8;
  else if (avgViews >= 10000) score += 5;
  if (subscribers >= 100000) score += 10;
  else if (subscribers >= 10000) score += 6;
  else score += 3;
  return Math.max(1, Math.min(100, Math.round(score)));
}

function computeScores({ subscribers, avgViews, avgLikes, avgComments, recentVideos, campaignKeyword, category, description, audienceCountryConfidence, countryMatch }) {
  const safeViews = Math.max(1, avgViews);
  const engagementRaw = ((avgLikes + avgComments) / safeViews) * 100;
  const engagementScore = Math.min(100, Math.round(engagementRaw * 12));

  const sponsoredCount = recentVideos.filter((v) => /sponsored|partnered with|in partnership|collaboration|collab|#ad|#sponsored|thanks to|use code|promo code/i.test(`${v.title || ''}\n${v.description || ''}`)).length;
  const sponsorshipScore = Math.min(100, Math.round((sponsoredCount / Math.max(1, recentVideos.length)) * 100));

  const now = new Date();
  const uploads30 = recentVideos.filter((v) => v.publishedAt && daysBetween(v.publishedAt, now) <= 30).length;
  const uploads90 = recentVideos.filter((v) => v.publishedAt && daysBetween(v.publishedAt, now) <= 90).length;
  const consistencyScore = Math.min(100, Math.round(uploads90 * 8 + uploads30 * 3));

  const allText = `${description || ''}\n${recentVideos.map((v) => `${v.title} ${v.description}`).join('\n')}`;
  const brandSafetyScore = /gambling|casino|adult|porn|hate speech|violence|weapon|drugs|scam|political extremism|extremist/i.test(allText) ? 55 : 95;

  const nicheFit = calculateNicheFit({ description, category, channelCategory: category, recentVideos, channelTags: [] }, campaignKeyword || category);
  const contentQuality = detectContentQuality(recentVideos);
  const shortlistScore = calculateShortlistScore({ nicheFit, engagementRate: engagementRaw, avgViews, subscribers, contentQuality, countryMatch });

  const viewSubRatio = avgViews / Math.max(1, subscribers);
  const authenticityScore = Math.max(55, Math.min(98, Math.round(85 + Math.min(10, viewSubRatio * 20) - (engagementRaw < 0.2 ? 12 : 0))));

  return {
    sponsorshipScore,
    engagementScore,
    consistencyScore,
    brandSafetyScore,
    relevancyScore: shortlistScore,
    authenticityScore,
    audienceCountryConfidence: audienceCountryConfidence || 0,
    shortlistScore,
    nicheFit,
  };
}

function buildInfluencerDiscoveryData(doc, context = {}) {
  const campaignKeyword = cleanStr(context.keyword) || cleanStr(context.category) || cleanStr(doc.category) || cleanStr(doc.channelCategory);
  const targetCountry = cleanStr(context.country);
  const filterFailureReason = getFilterFailureReasonForCreator(doc);
  const nicheFit = calculateNicheFit(doc, campaignKeyword);
  const contentQuality = detectContentQuality(doc.recentVideos || []);
  const previousSponsors = detectPreviousSponsors(doc);
  const uploadFrequency = getUploadFrequencyLabel(doc.uploadFrequency30Days, doc.uploadFrequency90Days);
  const countryMatch = getCountryMatch(doc, targetCountry);
  const score = calculateShortlistScore({
    nicheFit,
    engagementRate: Number(doc.engagementRate || 0),
    avgViews: Number(doc.avgViews || 0),
    subscribers: Number(doc.subscribers || 0),
    contentQuality,
    countryMatch,
  });

  const emails = Array.from(new Set([...(doc.contact?.emails || []), ...(doc.contact?.totalEmails || []), doc.contact?.youtubeAboutEmail].filter(Boolean)));
  const latestContext = (doc.campaignContexts || [])[doc.campaignContexts?.length - 1] || {};

  return {
    // Compatibility keys used by current frontend
    channelId: doc.channelId,
    channelName: doc.channelName,
    channelUrl: doc.channelUrl,
    thumbnail: doc.thumbnail,
    category: doc.category || doc.channelCategory,
    channelCategory: doc.channelCategory || doc.category,
    subscribers: doc.subscribers || 0,
    country: doc.country || '',
    estimatedAudienceCountry: doc.estimatedAudienceCountry || '',
    primaryLanguage: doc.primaryLanguage || '',
    totalVideos: doc.totalVideos || 0,
    totalViews: doc.totalViews || 0,
    avgViews: doc.avgViews || 0,
    avgLikes: doc.avgLikes || 0,
    avgComments: doc.avgComments || 0,
    engagementRate: doc.engagementRate || 0,
    recentUploadDate: doc.recentUploadDate,
    description: doc.description || '',

    // Apps Script Raw Creator Data-like output
    creatorTier: getTierFromSubscribers(doc.subscribers),
    sourceVideoTitle: doc.sourceVideoTitle || latestContext.sourceVideoTitle || '',
    sourceVideoUrl: doc.sourceVideoUrl || latestContext.sourceVideoUrl || '',
    foundViaQuery: doc.foundViaQuery || latestContext.foundViaQuery || '',
    allSearchKeywordsUsed: doc.allSearchKeywordsUsed || latestContext.allSearchKeywordsUsed || [],
    subscriberCount: doc.subscribers || 0,
    // Old Apps Script used last 90 days. CollabGlam now uses last 2 years for activity filtering.
    totalVideosLast90Days: doc.uploadFrequency90Days || 0,
    totalVideosLast2Years: countVideosWithinLookback(doc.recentVideos || []),
    activityLookbackDays: CREATOR_LOOKBACK_DAYS,
    totalLifetimeVideos: doc.totalVideos || 0,
    totalLifetimeViews: doc.totalViews || 0,
    channelCreatedDate: doc.createdDate,
    yearsOnYouTube: doc.yearsOnYouTube || 0,
    channelDescription: doc.description || '',
    contentFlag: doc.contentFlag || 'Original',
    recentVideoTitles: (doc.recentVideos || []).map((v, index) => ({
      number: index + 1,
      title: v.title,
      publishedAt: v.publishedAt,
      views: v.views,
      likes: v.likes,
      comments: v.comments,
      url: v.url,
      thumbnail: v.thumbnail,
    })),
    channelTags: doc.channelTags || [],

    // Apps Script Creator Shortlist-like output
    shortlist: {
      nicheFit,
      contentQuality,
      previousSponsors,
      uploadFrequency,
      countryMatch,
      score,
      status: filterFailureReason ? 'Excluded' : 'Shortlisted',
      filterFailureReason,
    },

    // Apps Script contact/social columns
    contact: {
      instagram: doc.contact?.instagram || doc.contact?.socials?.find((x) => /instagram\.com/i.test(x)) || '',
      twitter: doc.contact?.twitter || doc.contact?.socials?.find((x) => /twitter\.com|x\.com/i.test(x)) || '',
      facebook: doc.contact?.facebook || doc.contact?.socials?.find((x) => /facebook\.com/i.test(x)) || '',
      linkedin: doc.contact?.linkedin || doc.contact?.socials?.find((x) => /linkedin\.com/i.test(x)) || '',
      website: doc.contact?.website || doc.contact?.websites?.[0] || '',
      otherSocials: doc.contact?.socials || [],
      totalEmails: emails,
      youtubeAboutEmail: emails[0] || '',
    },

    scores: {
      sponsorshipScore: doc.scores?.sponsorshipScore || 0,
      engagementScore: doc.scores?.engagementScore || 0,
      consistencyScore: doc.scores?.consistencyScore || 0,
      brandSafetyScore: doc.scores?.brandSafetyScore || 0,
      relevancyScore: doc.scores?.relevancyScore || score,
      authenticityScore: doc.scores?.authenticityScore || 0,
      audienceCountryConfidence: doc.scores?.audienceCountryConfidence || 0,
      shortlistScore: score,
      nicheFit,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                         Campaign details based logic                        */
/* -------------------------------------------------------------------------- */

function normalizeCampaignDetails(campaign = {}) {
  const campaignName = cleanStr(campaign.campaignName) || cleanStr(campaign.name) || cleanStr(campaign.title) || cleanStr(campaign.campaignTitle);
  const productName = cleanStr(campaign.productName) || cleanStr(campaign.product) || cleanStr(campaign.productTitle) || cleanStr(campaign.productDetails?.name) || cleanStr(campaign.productInfo?.name);
  const campaignNiche = cleanStr(campaign.productNiche) || cleanStr(campaign.niche) || cleanStr(campaign.category) || cleanStr(campaign.industry) || cleanStr(campaign.creatorCategory) || cleanStr(campaign.productDetails?.niche) || cleanStr(campaign.productInfo?.category);
  const targetCountry = cleanStr(campaign.targetCountry) || cleanStr(campaign.country) || cleanStr(campaign.audienceCountry) || cleanStr(campaign.targetAudience?.country) || cleanStr(campaign.location);
  const minSubscribers = toIntOrNull(campaign.minSubscribers) ?? toIntOrNull(campaign.minSub) ?? toIntOrNull(campaign.creatorMinSubscribers) ?? toIntOrNull(campaign.creatorCriteria?.minSubscribers) ?? toIntOrNull(campaign.requirements?.minSubscribers);
  const maxSubscribers = toIntOrNull(campaign.maxSubscribers) ?? toIntOrNull(campaign.maxSub) ?? toIntOrNull(campaign.creatorMaxSubscribers) ?? toIntOrNull(campaign.creatorCriteria?.maxSubscribers) ?? toIntOrNull(campaign.requirements?.maxSubscribers);
  const minAvgViews = toIntOrNull(campaign.minAvgViews) ?? toIntOrNull(campaign.averageViews) ?? toIntOrNull(campaign.creatorCriteria?.minAvgViews) ?? toIntOrNull(campaign.requirements?.minAvgViews);
  const rawKeywords = [
    ...(Array.isArray(campaign.keywords) ? campaign.keywords : []),
    ...(Array.isArray(campaign.searchKeywords) ? campaign.searchKeywords : []),
    cleanStr(campaign.keyword),
    cleanStr(campaign.searchKeyword),
    campaignNiche,
    productName,
  ].filter(Boolean);

  return {
    campaignId: cleanStr(campaign._id || campaign.id),
    campaignName,
    productName,
    campaignNiche,
    targetCountry,
    minSubscribers,
    maxSubscribers,
    minAvgViews,
    keywords: Array.from(new Set(rawKeywords.map(cleanStr).filter(Boolean))),
  };
}

async function getCampaignDetailsById(campaignId) {
  if (!campaignId) return null;
  if (!Campaign) {
    const err = new Error('Campaign model not found. Update the Campaign require path in youtubeData.controller.js');
    err.status = 500;
    throw err;
  }
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }
  return normalizeCampaignDetails(campaign);
}

function buildRequestCampaignDetails(q = {}) {
  const requestedCategory = cleanStr(q.category || q.niche);
  const keyword = cleanStr(q.keyword || q.search);
  const tierRange = getSubscriberTierRange(q.subscriberTier);
  return {
    campaignId: cleanStr(q.campaignId),
    campaignName: '',
    productName: keyword,
    campaignNiche: requestedCategory || keyword,
    targetCountry: cleanStr(q.country),
    minSubscribers: toIntOrNull(q.minSubscribers) ?? tierRange?.min ?? null,
    maxSubscribers: toIntOrNull(q.maxSubscribers) ?? tierRange?.max ?? null,
    minAvgViews: toIntOrNull(q.minAvgViews) ?? MIN_AVG_VIEWS_DEFAULT,
    keywords: Array.from(new Set([keyword, requestedCategory].filter(Boolean))),
  };
}

function buildCampaignSearchQueries(campaignDetails = {}) {
  const product = cleanStr(campaignDetails.productName);
  const niche = cleanStr(campaignDetails.campaignNiche);
  const country = cleanStr(campaignDetails.targetCountry).toUpperCase();
  const baseKeyword = product || niche;
  const recommendationQueries = Array.isArray(campaignDetails.recommendationSearchQueries)
    ? campaignDetails.recommendationSearchQueries
    : [];

  const querySeeds = [
    ...recommendationQueries,
    ...campaignDetails.keywords,
    baseKeyword,
    product,
    niche,
    `${baseKeyword} review`,
    `${baseKeyword} reviews`,
    `${baseKeyword} unboxing`,
    `${baseKeyword} comparison`,
    `${baseKeyword} vs`,
    `best ${baseKeyword}`,
    `top ${baseKeyword}`,
    `${baseKeyword} test`,
    `${baseKeyword} demo`,
    `${baseKeyword} buying guide`,
    `${baseKeyword} product review`,
    `${baseKeyword} sponsored`,
    `${baseKeyword} creator`,
    `${baseKeyword} youtube`,
    `${baseKeyword} influencer`,
    country ? `${baseKeyword} ${country}` : '',
    country ? `${baseKeyword} review ${country}` : '',
    country ? `${baseKeyword} creator ${country}` : '',
    country ? `best ${baseKeyword} ${country}` : '',
  ];

  const lower = [baseKeyword, niche, ...(campaignDetails.keywords || [])].join(' ').toLowerCase();
  if (/drone|dji|mavic|fpv|uav|aerial|action\s*cam|gopro|insta360|osmo/.test(lower)) {
    querySeeds.push(
      'drone review',
      'drone camera review',
      'best drone camera',
      'dji drone review',
      'mavic drone review',
      'fpv drone review',
      'aerial photography drone',
      'aerial videography drone',
      'action camera review',
      'gopro action camera review',
      'insta360 action camera review',
      country ? `drone review ${country}` : '',
      country ? `dji drone review ${country}` : '',
      country ? `aerial photography drone ${country}` : ''
    );
  }

  if (/pool|cleaner|vacuum|lawn|garden|home/.test(lower)) {
    querySeeds.push(
      'home improvement product review',
      'smart home product review',
      'outdoor gadget review',
      'robot vacuum review',
      'robot lawn mower review',
      'home gadget review',
      'backyard gadget review',
      'home tech review'
    );
  }

  return Array.from(new Set(querySeeds.map(cleanStr).filter(Boolean))).slice(0, MAX_SEARCH_QUERIES);
}
/* -------------------------------------------------------------------------- */
/*                         YouTube Data API calls                              */
/* -------------------------------------------------------------------------- */

async function searchVideoCreatorChannels(
  query,
  maxResults = SEARCH_RESULTS_PER_QUERY,
  requestedCategory = '',
  targetLimit = RAW_CHANNELS_PER_SEARCH,
  targetCountry = ''
) {
  const map = new Map();
  let pageToken = '';

  for (let page = 0; page < SEARCH_PAGES_PER_QUERY; page += 1) {
    const params = new URLSearchParams({
      part: 'snippet',
      q: cleanStr(query),
      type: 'video',
      maxResults: String(Math.min(50, Math.max(1, maxResults))),
      order: 'relevance',
    });

    const regionCode = cleanStr(targetCountry).toUpperCase();
    if (/^[A-Z]{2}$/.test(regionCode)) params.set('regionCode', regionCode);
    if (pageToken) params.set('pageToken', pageToken);

    const data = await ytFetch(YT_SEARCH, params);

    for (const item of Array.isArray(data?.items) ? data.items : []) {
      const channelId = item?.snippet?.channelId;
      if (!channelId || map.has(channelId)) continue;

      map.set(channelId, {
        channelId,
        channelName: item?.snippet?.channelTitle || '',
        sourceVideoTitle: item?.snippet?.title || '',
        sourceVideoUrl: item?.id?.videoId ? `https://www.youtube.com/watch?v=${item.id.videoId}` : '',
        foundViaQuery: query,
        requestedCategory: cleanStr(requestedCategory) || query,
      });

      if (map.size >= targetLimit) break;
    }

    if (map.size >= targetLimit) break;
    pageToken = data?.nextPageToken || '';
    if (!pageToken) break;
  }

  return Array.from(map.values()).slice(0, targetLimit);
}

async function fetchChannelsByIds(channelIds = []) {
  const ids = Array.from(new Set((channelIds || []).map(cleanStr).filter(Boolean)));
  if (!ids.length) return [];
  const all = [];
  for (const batch of chunkArray(ids, 50)) {
    const params = new URLSearchParams({
      part: 'snippet,statistics,topicDetails,contentDetails,brandingSettings',
      id: batch.join(','),
    });
    const data = await ytFetch(YT_CHANNELS, params);
    if (Array.isArray(data?.items)) all.push(...data.items);
  }
  return all;
}

async function fetchRecentVideos(uploadsPlaylistId, limit = RECENT_VIDEO_SAMPLE) {
  if (!uploadsPlaylistId) return [];

  const listParams = new URLSearchParams({
    part: 'snippet,contentDetails',
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.min(50, Math.max(1, limit))),
  });

  const list = await ytFetch(YT_PLAYLIST_ITEMS, listParams);
  const videoIds = (list?.items || []).map((it) => it?.contentDetails?.videoId || it?.snippet?.resourceId?.videoId).filter(Boolean);
  if (!videoIds.length) return [];

  const videoParams = new URLSearchParams({
    part: 'snippet,statistics,contentDetails',
    id: videoIds.join(','),
  });

  const data = await ytFetch(YT_VIDEOS, videoParams);
  return (Array.isArray(data?.items) ? data.items : []).map((v) => ({
    videoId: v.id,
    title: cleanStr(v?.snippet?.title),
    description: cleanStr(v?.snippet?.description),
    url: `https://www.youtube.com/watch?v=${v.id}`,
    thumbnail: pickThumb(v?.snippet?.thumbnails),
    publishedAt: v?.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null,
    views: toNum(v?.statistics?.viewCount),
    likes: toNum(v?.statistics?.likeCount),
    comments: toNum(v?.statistics?.commentCount),
  }));
}

/* -------------------------------------------------------------------------- */
/*                            Metrics and document                            */
/* -------------------------------------------------------------------------- */

function computeVideoMetrics(videos = []) {
  const rows = videos.filter((v) => v.publishedAt && !Number.isNaN(new Date(v.publishedAt).getTime())).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  if (!rows.length) {
    return { avgViews: 0, avgLikes: 0, avgComments: 0, engagementRate: 0, recentUploadDate: null, uploadFrequency30Days: 0, uploadFrequency90Days: 0, topVideos: [] };
  }

  const avgViews = Math.round(rows.reduce((a, r) => a + toNum(r.views), 0) / rows.length);
  const avgLikes = Math.round(rows.reduce((a, r) => a + toNum(r.likes), 0) / rows.length);
  const avgComments = Math.round(rows.reduce((a, r) => a + toNum(r.comments), 0) / rows.length);
  const engagementRate = avgViews > 0 ? Number((((avgLikes + avgComments) / avgViews) * 100).toFixed(2)) : 0;
  const now = new Date();

  return {
    avgViews,
    avgLikes,
    avgComments,
    engagementRate,
    recentUploadDate: rows[0].publishedAt,
    uploadFrequency30Days: rows.filter((v) => daysBetween(v.publishedAt, now) <= 30).length,
    uploadFrequency90Days: rows.filter((v) => daysBetween(v.publishedAt, now) <= 90).length,
    topVideos: [...rows].sort((a, b) => b.views - a.views).slice(0, 5),
  };
}

function buildCreatorDoc(channel, videos, campaignDetails, discoveryInfo, allSearchKeywordsUsed = []) {
  const snippet = channel?.snippet || {};
  const stats = channel?.statistics || {};
  const topic = channel?.topicDetails || {};
  const branding = channel?.brandingSettings?.channel || {};
  const topicCategories = Array.isArray(topic.topicCategories) ? topic.topicCategories : [];
  const requestedCategory = cleanStr(campaignDetails?.campaignNiche) || cleanStr(discoveryInfo?.requestedCategory) || cleanStr(discoveryInfo?.foundViaQuery);
  const youtubeCategory = topicCategories.length > 0 ? labelFromWikiUrl(topicCategories[0]) : '';
  const category = requestedCategory || youtubeCategory || cleanStr(branding.keywords).split(/\s+/)[0] || '';

  const metrics = computeVideoMetrics(videos);
  const createdDate = snippet.publishedAt ? new Date(snippet.publishedAt) : null;
  const fullText = [snippet.title, snippet.description, branding.keywords, campaignDetails.productName, campaignDetails.campaignNiche, ...videos.map((v) => `${v.title}\n${v.description}`)].join('\n');
  const countryEstimate = estimateAudienceCountry(snippet.country, fullText);
  const contact = extractContactAndSponsors(snippet.description, videos);
  const countryMatch = getCountryMatch({ country: snippet.country, estimatedAudienceCountry: countryEstimate.estimatedAudienceCountry }, campaignDetails.targetCountry);
  const campaignKeyword = [campaignDetails.productName, campaignDetails.campaignNiche, ...campaignDetails.keywords].filter(Boolean).join(' ');
  const contentFlag = detectContentFlag(channel, videos);
  const channelCategory = category;

  const scores = computeScores({
    subscribers: toNum(stats.subscriberCount),
    avgViews: metrics.avgViews,
    avgLikes: metrics.avgLikes,
    avgComments: metrics.avgComments,
    recentVideos: videos,
    campaignKeyword,
    category,
    description: snippet.description,
    audienceCountryConfidence: countryEstimate.audienceCountryConfidence,
    countryMatch,
  });

  const draftDoc = {
    channelId: channel.id,
    channelName: cleanStr(snippet.title),
    channelUrl: channelUrlFor(channel.id, snippet.customUrl),
    thumbnail: pickThumb(snippet.thumbnails),
    sourceVideoTitle: discoveryInfo?.sourceVideoTitle || '',
    sourceVideoUrl: discoveryInfo?.sourceVideoUrl || '',
    foundViaQuery: discoveryInfo?.foundViaQuery || '',
    allSearchKeywordsUsed,
    subscribers: toNum(stats.subscriberCount),
    country: cleanStr(snippet.country).toUpperCase(),
    estimatedAudienceCountry: countryEstimate.estimatedAudienceCountry,
    primaryLanguage: detectLanguage(fullText),
    totalVideos: toNum(stats.videoCount),
    totalViews: toNum(stats.viewCount),
    avgViews: metrics.avgViews,
    avgLikes: metrics.avgLikes,
    avgComments: metrics.avgComments,
    engagementRate: metrics.engagementRate,
    recentUploadDate: metrics.recentUploadDate,
    createdDate,
    yearsOnYouTube: createdDate ? Math.max(0, Math.floor(daysBetween(createdDate, new Date()) / 365)) : 0,
    uploadFrequency30Days: metrics.uploadFrequency30Days,
    uploadFrequency90Days: metrics.uploadFrequency90Days,
    category,
    channelCategory,
    contentFlag,
    description: cleanStr(snippet.description),
    channelTags: cleanStr(branding.keywords).match(/"[^"]+"|\S+/g)?.map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean) || [],
    recentVideos: videos,
    topVideos: metrics.topVideos,
    contact,
    scores,
    lastCampaignId: campaignDetails.campaignId,
    campaignContext: {
      campaignId: campaignDetails.campaignId,
      campaignName: campaignDetails.campaignName,
      campaignNiche: campaignDetails.campaignNiche,
      campaignProduct: campaignDetails.productName,
      campaignCountry: campaignDetails.targetCountry,
      foundViaQuery: discoveryInfo?.foundViaQuery || '',
      sourceVideoTitle: discoveryInfo?.sourceVideoTitle || '',
      sourceVideoUrl: discoveryInfo?.sourceVideoUrl || '',
      allSearchKeywordsUsed,
    },
    lastFetchedAt: new Date(),
  };

  const filterFailureReason = getFilterFailureReasonForCreator(draftDoc);
  const nicheFit = calculateNicheFit(draftDoc, campaignKeyword);
  const contentQuality = detectContentQuality(videos);
  const previousSponsors = detectPreviousSponsors(draftDoc);
  const uploadFrequency = getUploadFrequencyLabel(metrics.uploadFrequency30Days, metrics.uploadFrequency90Days);
  const shortlistScore = calculateShortlistScore({
    nicheFit,
    engagementRate: metrics.engagementRate,
    avgViews: metrics.avgViews,
    subscribers: draftDoc.subscribers,
    contentQuality,
    countryMatch,
  });

  draftDoc.shortlist = {
    nicheFit,
    contentQuality,
    previousSponsors,
    uploadFrequency,
    countryMatch,
    score: shortlistScore,
    status: filterFailureReason ? 'Excluded' : 'Shortlisted',
    filterFailureReason,
  };
  draftDoc.scores.shortlistScore = shortlistScore;
  draftDoc.scores.nicheFit = nicheFit;
  draftDoc.scores.relevancyScore = shortlistScore;

  return draftDoc;
}

function passesCampaignRules(doc, campaignDetails = {}) {
  const minSubscribers = campaignDetails.minSubscribers;
  const maxSubscribers = campaignDetails.maxSubscribers;
  const minAvgViews = campaignDetails.minAvgViews;
  const targetCountry = cleanStr(campaignDetails.targetCountry).toUpperCase();
  const strictFilters = Boolean(campaignDetails.strictFilters);
  const strictCountry = Boolean(campaignDetails.strictCountry);
  const strictTier = Boolean(campaignDetails.strictTier);

  // Activity gate: keep creators who uploaded at least once within the configured lookback window.
  // Default is 730 days / last 2 years.
  if (!isCreatorActiveWithinLookback(doc)) return false;

  // Do not recommend official brand/manufacturer/news pages as influencers.
  const failureReason = getFilterFailureReasonForCreator(doc);
  if (/brand channel|news outlet|publication|trade/i.test(failureReason)) return false;

  if (minAvgViews != null && doc.avgViews < minAvgViews) return false;

  // Country is a hard filter when selected. Use actual YouTube channel country only.
  if (strictCountry && targetCountry) {
    const channelCountry = cleanStr(doc.country).toUpperCase();
    if (channelCountry !== targetCountry) return false;
  }

  if (strictTier || strictFilters) {
    if (minSubscribers != null && doc.subscribers < minSubscribers) return false;
    if (maxSubscribers != null && doc.subscribers > maxSubscribers) return false;
  }

  if (!strictFilters) return true;

  return true;
}

async function refreshChannelsForCampaign(campaignDetails) {
  const rawLimit = Math.max(
    1,
    Number(campaignDetails.rawChannelLimit || campaignDetails.rawChannelsPerSearch || RAW_CHANNELS_PER_SEARCH)
  );
  const targetSaveCount = Math.min(
    rawLimit,
    Math.max(
      1,
      Number(campaignDetails.targetSaveCount || TARGET_CHANNELS_PER_SEARCH)
    )
  );
  const maxSearchQueries = Math.max(
    1,
    Number(campaignDetails.maxSearchQueries || MAX_SEARCH_QUERIES)
  );
  const searchResultsPerQuery = Math.max(
    1,
    Number(campaignDetails.searchResultsPerQuery || SEARCH_RESULTS_PER_QUERY)
  );
  const recentVideoSample = Math.max(
    1,
    Number(campaignDetails.recentVideoSample || RECENT_VIDEO_SAMPLE)
  );
  const maxDiscoveryMs = Number(campaignDetails.maxDiscoveryMs || 0);
  const startedAt = Date.now();
  const shouldStopForTime = () => Boolean(maxDiscoveryMs && Date.now() - startedAt >= maxDiscoveryMs);

  const searchQueries = buildCampaignSearchQueries(campaignDetails).slice(0, maxSearchQueries);
  if (!searchQueries.length) return 0;

  const discoveryMap = new Map();

  // Build a bounded raw pool first. This keeps campaign/browse discovery fast enough
  // for production while still using the same Apps Script style search -> channel -> recent video flow.
  for (const query of searchQueries) {
    if (discoveryMap.size >= rawLimit || shouldStopForTime()) break;

    const channels = await searchVideoCreatorChannels(
      query,
      searchResultsPerQuery,
      campaignDetails.campaignNiche,
      rawLimit,
      campaignDetails.targetCountry
    );

    for (const item of channels) {
      if (!discoveryMap.has(item.channelId)) {
        discoveryMap.set(item.channelId, {
          ...item,
          requestedCategory: campaignDetails.campaignNiche || item.requestedCategory || query,
        });
      }

      if (discoveryMap.size >= rawLimit) break;
    }
  }

  const discoveryRows = Array.from(discoveryMap.values());
  const channelIds = discoveryRows.map((x) => x.channelId);
  if (!channelIds.length) return 0;

  const channels = await fetchChannelsByIds(channelIds);
  let upserts = 0;
  let aiAnalyses = 0;

  for (const channel of channels) {
    if (shouldStopForTime()) break;

    const discoveryInfo = discoveryMap.get(channel.id);
    try {
      const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads || null;
      const videos = await fetchRecentVideos(uploadsPlaylistId, recentVideoSample);
      let doc = buildCreatorDoc(channel, videos, campaignDetails, discoveryInfo, searchQueries);

      if (
        !campaignDetails.skipOpenAIAnalysis &&
        OPENAI_ANALYSIS_ENABLED &&
        (OPENAI_MAX_ANALYSIS_PER_REQUEST <= 0 || aiAnalyses < OPENAI_MAX_ANALYSIS_PER_REQUEST)
      ) {
        const aiAnalysis = await analyzeCreatorWithOpenAI(doc, campaignDetails);
        if (aiAnalysis) {
          doc = applyOpenAIAnalysisToDoc(doc, aiAnalysis);
          aiAnalyses += 1;
        }
      }

      if (!passesCampaignRules(doc, campaignDetails)) continue;

      const campaignContext = doc.campaignContext;
      delete doc.campaignContext;

      await YouTubeData.updateOne(
        { channelId: doc.channelId },
        {
          $set: doc,
          $addToSet: { campaignContexts: campaignContext },
        },
        { upsert: true }
      );
      upserts += 1;

      if (typeof campaignDetails.onCreatorSaved === 'function') {
        const shouldContinue = await campaignDetails.onCreatorSaved({
          doc,
          campaignContext,
          discoveryInfo,
          savedCount: upserts,
        });
        if (shouldContinue === false) break;
      }

      // Stop after saving the requested discovery target.
      if (upserts >= targetSaveCount) break;
    } catch (err) {
      if (err?.status === 429 || err?.status === 403 || err?.status === 500) throw err;
    }
  }

  return upserts;
}

/* -------------------------------------------------------------------------- */
/*                           Query/filter builders                            */
/* -------------------------------------------------------------------------- */

const SORT_MAP = {
  relevance: { 'scores.shortlistScore': -1, 'scores.relevancyScore': -1, subscribers: -1 },
  score_desc: { 'scores.shortlistScore': -1 },
  subscribers_desc: { subscribers: -1 },
  subscribers_asc: { subscribers: 1 },
  avg_views_desc: { avgViews: -1 },
  avg_views_asc: { avgViews: 1 },
  engagement_desc: { engagementRate: -1 },
  recent_upload: { recentUploadDate: -1 },
  sponsorship_desc: { 'scores.sponsorshipScore': -1 },
  relevancy_desc: { 'scores.relevancyScore': -1 },
  brand_safety_desc: { 'scores.brandSafetyScore': -1 },
};

function buildMongoFilter({
  keyword,
  country,
  minSubscribers,
  maxSubscribers,
  minAvgViews,
  minEngagement,
  category,
  campaignId,
  includeExcluded,
  strictFilters,
  activeSinceDate,
}) {
  const and = [];

  if (activeSinceDate) {
    and.push({ recentUploadDate: { $gte: activeSinceDate } });
  }

  if (campaignId) {
    and.push({ $or: [{ lastCampaignId: campaignId }, { 'campaignContexts.campaignId': campaignId }] });
  }

  if (keyword) {
    const rx = new RegExp(escapeRegex(keyword), 'i');
    and.push({
      $or: [
        { channelName: rx },
        { description: rx },
        { category: rx },
        { channelCategory: rx },
        { channelTags: rx },
        { 'recentVideos.title': rx },
        { 'recentVideos.description': rx },
      ],
    });
  }

  if (category) {
    const rx = new RegExp(escapeRegex(category), 'i');
    and.push({
      $or: [
        { category: rx },
        { channelCategory: rx },
        { channelTags: rx },
        { description: rx },
        { channelName: rx },
        { 'recentVideos.title': rx },
        { 'recentVideos.description': rx },
        { 'campaignContexts.campaignNiche': rx },
        { 'campaignContexts.foundViaQuery': rx },
        { 'campaignContexts.sourceVideoTitle': rx },
      ],
    });
  }

  if (country) {
    const c = country.toUpperCase();
    // Country filter is exact: only creators whose actual YouTube channel country matches.
    and.push({ country: c });
  }

  if (strictFilters && (minSubscribers != null || maxSubscribers != null)) {
    const range = {};
    if (minSubscribers != null) range.$gte = minSubscribers;
    if (maxSubscribers != null) range.$lte = maxSubscribers;
    and.push({ subscribers: range });
  }

  if (minAvgViews != null) and.push({ avgViews: { $gte: minAvgViews } });
  if (minEngagement != null) and.push({ engagementRate: { $gte: minEngagement } });
  if (!includeExcluded) and.push({ 'shortlist.status': { $ne: 'Excluded' } });

  return and.length ? { $and: and } : {};
}

function getRequestedTierLabelFromRange(minSubscribers, maxSubscribers, subscriberTier) {
  const direct = cleanStr(subscriberTier);
  if (direct) return direct;

  const min = Number(minSubscribers || 0);
  const max = maxSubscribers == null || maxSubscribers === '' ? null : Number(maxSubscribers);

  if (min >= 1000000) return 'mega';
  if (min >= 500000 && max === 1000000) return 'macro';
  if (min >= 100000 && max === 500000) return 'mid-tier';
  if (min >= 10000 && max === 100000) return 'micro';
  if (min >= 1000 && max === 10000) return 'nano';

  return '';
}

function isSubscriberTierMatch(subscribers, minSubscribers, maxSubscribers) {
  const subs = Number(subscribers || 0);

  if (minSubscribers != null && subs < Number(minSubscribers)) return false;
  if (maxSubscribers != null && maxSubscribers !== '' && subs > Number(maxSubscribers)) return false;

  return true;
}

function isCountryMatchForFilter(doc, country) {
  const target = cleanStr(country).toUpperCase();
  if (!target) return true;

  const channelCountry = cleanStr(doc.country).toUpperCase();
  return channelCountry === target;
}

function creatorListDTO(doc, context = {}) {
  const data = buildInfluencerDiscoveryData(doc, context);

  data.filterMatch = {
    requestedTier: getRequestedTierLabelFromRange(
      context.minSubscribers,
      context.maxSubscribers,
      context.subscriberTier
    ),
    subscriberTierMatch: isSubscriberTierMatch(
      doc.subscribers,
      context.minSubscribers,
      context.maxSubscribers
    ),
    countryMatch: isCountryMatchForFilter(doc, context.country),
    softFiltersApplied: !context.strictFilters,
  };

  return data;
}

function sortDiscoveryDataForSelectedFilters(items = [], context = {}) {
  const hasTierFilter = Boolean(
    cleanStr(context.subscriberTier) ||
      context.minSubscribers != null ||
      context.maxSubscribers != null
  );
  const hasCountryFilter = Boolean(cleanStr(context.country));

  return [...items].sort((a, b) => {
    if (hasTierFilter) {
      const aTier = a.filterMatch?.subscriberTierMatch ? 1 : 0;
      const bTier = b.filterMatch?.subscriberTierMatch ? 1 : 0;
      if (aTier !== bTier) return bTier - aTier;
    }

    if (hasCountryFilter) {
      const aCountry = a.filterMatch?.countryMatch ? 1 : 0;
      const bCountry = b.filterMatch?.countryMatch ? 1 : 0;
      if (aCountry !== bCountry) return bCountry - aCountry;
    }

    const aScore = Number(a.shortlist?.score || a.scores?.shortlistScore || a.scores?.relevancyScore || 0);
    const bScore = Number(b.shortlist?.score || b.scores?.shortlistScore || b.scores?.relevancyScore || 0);
    if (aScore !== bScore) return bScore - aScore;

    return Number(b.subscriberCount || b.subscribers || 0) - Number(a.subscriberCount || a.subscribers || 0);
  });
}


/* -------------------------------------------------------------------------- */
/*                    Incremental 5-by-5 discovery job helpers                */
/* -------------------------------------------------------------------------- */

const DISCOVERY_BATCH_SIZE = Number(process.env.YOUTUBE_DISCOVERY_BATCH_SIZE || 5);
const DISCOVERY_JOB_TTL_MS = Number(process.env.YOUTUBE_DISCOVERY_JOB_TTL_MS || 20 * 60 * 1000);
const discoveryJobs = new Map();

function makeDiscoveryJobId(prefix = 'ytjob') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function getCreatorUniqueKeyForJob(creator = {}) {
  return cleanStr(
    creator.channelId ||
      creator.ids?.youtubeChannelId ||
      creator.channelUrl ||
      creator.channelName
  ).toLowerCase();
}

function createDiscoveryJob({ type, target = 25, limit = 50, batchSize = DISCOVERY_BATCH_SIZE, meta = {} }) {
  const jobId = makeDiscoveryJobId(type || 'ytjob');
  const job = {
    jobId,
    type,
    target: Math.max(1, Number(target || 25)),
    limit: Math.max(1, Number(limit || 50)),
    batchSize: Math.max(1, Number(batchSize || DISCOVERY_BATCH_SIZE)),
    meta,
    data: [],
    seen: new Set(),
    done: false,
    processing: true,
    error: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  discoveryJobs.set(jobId, job);
  setTimeout(() => discoveryJobs.delete(jobId), DISCOVERY_JOB_TTL_MS).unref?.();
  return job;
}

function addCreatorToDiscoveryJob(job, creator, sorter) {
  if (!job || !creator) return false;
  const key = getCreatorUniqueKeyForJob(creator);
  if (!key || job.seen.has(key)) return false;

  job.seen.add(key);
  job.data.push(creator);
  if (typeof sorter === 'function') {
    job.data = sorter(job.data).slice(0, job.limit);
  } else {
    job.data = job.data.slice(0, job.limit);
  }
  job.updatedAt = new Date();
  return true;
}

function finishDiscoveryJob(job, error = '') {
  if (!job) return;
  job.done = true;
  job.processing = false;
  job.error = error || '';
  job.updatedAt = new Date();
}

function getVisibleJobData(job) {
  if (!job) return [];
  if (job.done) return job.data.slice(0, job.limit);

  // Only expose full 5-row batches while a job is running. This prevents
  // the frontend from flickering 1, 2, 3 rows and matches the Apps Script
  // incremental write feel: show a useful chunk, then append the next chunk.
  const visibleCount = Math.floor(job.data.length / job.batchSize) * job.batchSize;
  return job.data.slice(0, Math.min(visibleCount, job.limit));
}

function buildJobResponse(job, extra = {}) {
  const data = getVisibleJobData(job);
  return {
    success: true,
    mode: 'incremental',
    jobId: job.jobId,
    type: job.type,
    processing: job.processing,
    done: job.done,
    error: job.error || '',
    batchSize: job.batchSize,
    target: job.target,
    limit: job.limit,
    count: data.length,
    returnedCount: data.length,
    totalFound: job.data.length,
    data,
    creators: data,
    recommendations: data,
    recommendedCreators: data,
    meta: job.meta || {},
    ...extra,
  };
}

function startDiscoveryJob(job, worker) {
  Promise.resolve()
    .then(worker)
    .then(() => finishDiscoveryJob(job))
    .catch((err) => {
      finishDiscoveryJob(job, err?.message || 'Discovery job failed');
      try {
        saveErrorLog({}, err, err?.status || 500, `YOUTUBE_${String(job.type || 'DISCOVERY').toUpperCase()}_JOB`);
      } catch (_) {}
    });
}

async function getYouTubeDiscoveryJob(req, res) {
  const jobId = cleanStr(req.params.jobId || req.query.jobId);
  const job = discoveryJobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: 'Discovery job not found or expired',
    });
  }

  return res.status(200).json(buildJobResponse(job));
}

function shouldUseIncrementalMode(_q = {}) {
  // Incremental 5-row streaming is disabled. Browse and invitation now return
  // one accurate response: 25 minimum for invite, 50 for Browse.
  return false;
}

/* -------------------------------------------------------------------------- */
/*                                Controllers                                 */
/* -------------------------------------------------------------------------- */

async function startBrowseIncrementalJob({
  req,
  res,
  campaignDetails,
  filter,
  context,
  campaignId,
  keyword,
  category,
  country,
  minSubscribers,
  maxSubscribers,
  minAvgViews,
  strictFilters,
  strictCountry,
  limit,
  minimumResults,
  sort,
  shouldRefresh,
}) {
  const q = { ...req.query, ...req.body };
  const batchSize = Math.max(1, toIntOrNull(q.batchSize) || DISCOVERY_BATCH_SIZE);
  const job = createDiscoveryJob({
    type: 'browse-creators',
    target: minimumResults,
    limit,
    batchSize,
    meta: {
      campaignId,
      keyword,
      category,
      country,
      subscriberTier: context.subscriberTier,
      minSubscribers,
      maxSubscribers,
      strictCountry,
      source: 'browse-influencer',
    },
  });

  const addBrowseCreator = (creatorOrDoc) => {
    const creator = creatorOrDoc?.filterMatch
      ? creatorOrDoc
      : creatorListDTO(creatorOrDoc, context);

    if (country && !isCountryMatchForFilter(creator, country)) return false;

    return addCreatorToDiscoveryJob(job, creator, (items) =>
      sortDiscoveryDataForSelectedFilters(items, context)
    );
  };

  startDiscoveryJob(job, async () => {
    const cachedDocs = await YouTubeData.find(filter)
      .sort(SORT_MAP[sort] || SORT_MAP.relevance)
      .limit(Math.max(limit, minimumResults))
      .lean();

    for (const doc of cachedDocs) {
      addBrowseCreator(doc);
      if (job.data.length >= limit) break;
    }

    if (job.data.length >= limit || (!shouldRefresh && job.data.length >= minimumResults)) return;

    if (shouldRefresh) {
      await refreshChannelsForCampaign({
        ...campaignDetails,
        campaignNiche: category || campaignDetails.campaignNiche || keyword,
        productName: campaignDetails.productName || keyword,
        targetCountry: country,
        minSubscribers: null,
        maxSubscribers: null,
        minAvgViews,
        strictFilters,
        strictCountry,
        targetSaveCount: Math.min(50, Math.max(limit, minimumResults)),
        rawChannelLimit: Math.min(120, Math.max(limit * 2, minimumResults * 2, 60)),
        recentVideoSample: 8,
        maxSearchQueries: 8,
        searchResultsPerQuery: 25,
        maxDiscoveryMs: 285000,
        skipOpenAIAnalysis: true,
        keywords: Array.from(new Set([...(campaignDetails.keywords || []), keyword, category].filter(Boolean))),
        onCreatorSaved: async ({ doc }) => {
          addBrowseCreator(doc);
          return job.data.length < limit;
        },
      });
    }

    const finalDocs = await YouTubeData.find(filter)
      .sort(SORT_MAP[sort] || SORT_MAP.relevance)
      .limit(Math.max(limit * 2, minimumResults * 2))
      .lean();

    for (const doc of finalDocs) {
      addBrowseCreator(doc);
      if (job.data.length >= limit) break;
    }
  });

  return res.status(202).json(buildJobResponse(job, {
    campaignId,
    refreshedCount: 0,
    activityLookbackDays: CREATOR_LOOKBACK_DAYS,
    activityLookbackStartDate: getCreatorLookbackStartDate(),
    pagination: {
      page: 1,
      limit,
      total: getVisibleJobData(job).length,
      totalPages: 1,
      hasNextPage: false,
      hasPrevPage: false,
      frontendPagination: true,
    },
  }));
}

async function browseCreators(req, res) {
  try {
    const q = { ...req.query, ...req.body };
    const campaignId = cleanStr(q.campaignId);

    let campaignDetails = campaignId ? await getCampaignDetailsById(campaignId) : buildRequestCampaignDetails(q);
    const tierRange = getSubscriberTierRange(q.subscriberTier);
    const requestedCategory = cleanStr(q.category || q.niche);
    const category = requestedCategory || cleanStr(campaignDetails?.campaignNiche);
    const keyword = cleanStr(q.keyword || q.search) || cleanStr(campaignDetails?.productName) || cleanStr(campaignDetails?.campaignNiche);
    const country = cleanStr(q.country) || cleanStr(campaignDetails?.targetCountry);
    const strictCountry = Boolean(country);
    const minSubscribers = toIntOrNull(q.minSubscribers) ?? tierRange?.min ?? campaignDetails?.minSubscribers ?? null;
    const maxSubscribers = toIntOrNull(q.maxSubscribers) ?? tierRange?.max ?? campaignDetails?.maxSubscribers ?? null;
    const minAvgViews = toIntOrNull(q.minAvgViews) ?? campaignDetails?.minAvgViews ?? null;
    const minEngagement = toIntOrNull(q.minEngagement);
    const includeExcluded = String(q.includeExcluded || '').toLowerCase() === 'true';
    const strictFilters =
      String(q.strictFilters ?? STRICT_FILTERS_DEFAULT).toLowerCase() === 'true';
    const sort = SORT_MAP[cleanStr(q.sort)] ? cleanStr(q.sort) : 'relevance';
    const frontendPagination = String(q.frontendPagination || '').toLowerCase() === 'true';
    const page = frontendPagination ? 1 : Math.max(1, toIntOrNull(q.page) || 1);
    const limitCap = frontendPagination ? 50 : 50;
    const limit = Math.min(limitCap, Math.max(1, toIntOrNull(q.limit) || 25));
    const skip = frontendPagination ? 0 : (page - 1) * limit;
    const mongoLimit = frontendPagination
      ? Math.min(100, Math.max(limit, 50))
      : limit;

    let liveError = null;
    let refreshedCount = 0;
    const fastMode = String(q.fast ?? 'true').toLowerCase() !== 'false' || frontendPagination;
    const minimumResults = Math.min(50, Math.max(25, toIntOrNull(q.minimumResults) || 25));
    let shouldRefresh = Boolean(campaignId) || Boolean(cleanStr(q.keyword || q.search)) || Boolean(requestedCategory);

    const activeSinceDate = getCreatorLookbackStartDate();

    const filter = buildMongoFilter({
      keyword: cleanStr(q.keyword || q.search),
      country,
      minSubscribers,
      maxSubscribers,
      minAvgViews,
      minEngagement,
      category,
      campaignId,
      includeExcluded,
      strictFilters,
      activeSinceDate,
    });

    const context = {
      keyword,
      category,
      country,
      minSubscribers,
      maxSubscribers,
      subscriberTier: q.subscriberTier,
      strictFilters,
    };

    if (shouldUseIncrementalMode(q)) {
      return startBrowseIncrementalJob({
        req,
        res,
        campaignDetails,
        filter,
        context,
        campaignId,
        keyword,
        category,
        country,
        minSubscribers,
        maxSubscribers,
        minAvgViews,
        strictFilters,
        strictCountry,
        limit,
        minimumResults,
        sort,
        shouldRefresh,
      });
    }

    // Browse page should respond quickly. If matching cached creators already exist,
    // return them immediately instead of starting a full YouTube discovery again.
    if (shouldRefresh && fastMode && String(q.forceRefresh || q.force || '').toLowerCase() !== 'true') {
      const cachedCount = await YouTubeData.countDocuments(filter).catch(() => 0);
      if (cachedCount >= Math.min(limit, minimumResults)) {
        shouldRefresh = false;
      }
    }

    if (shouldRefresh) {
      try {
        refreshedCount = await refreshChannelsForCampaign({
          ...campaignDetails,
          campaignNiche: requestedCategory || campaignDetails.campaignNiche || keyword,
          productName: campaignDetails.productName || keyword,
          targetCountry: country,
          minSubscribers: fastMode ? null : minSubscribers,
          maxSubscribers: fastMode ? null : maxSubscribers,
          minAvgViews,
          strictFilters,
          strictCountry,
          // Browse only needs up to 50 relevant creators. Keep discovery bounded
          // so the API returns inside the normal request window.
          targetSaveCount: fastMode ? 50 : TARGET_CHANNELS_PER_SEARCH,
          rawChannelLimit: fastMode ? 120 : undefined,
          recentVideoSample: fastMode ? 6 : undefined,
          maxSearchQueries: fastMode ? 6 : undefined,
          searchResultsPerQuery: fastMode ? 20 : undefined,
          maxDiscoveryMs: fastMode ? 240000 : undefined,
          skipOpenAIAnalysis: fastMode,
          keywords: Array.from(new Set([...(campaignDetails.keywords || []), keyword, requestedCategory].filter(Boolean))),
        });
      } catch (err) {
        liveError = err?.message || 'YouTube live fetch failed. Showing cached data.';
        await saveErrorLog(req, err, err?.status || 429, 'YOUTUBE_LIVE_FETCH');
      }
    }

    const items = await YouTubeData.find(filter)
      .sort(SORT_MAP[sort])
      .skip(skip)
      .limit(mongoLimit)
      .lean();

    const sortedData = sortDiscoveryDataForSelectedFilters(
      items.map((doc) => creatorListDTO(doc, context)),
      context
    );

    const data = frontendPagination ? sortedData.slice(0, limit) : sortedData;
    const total = frontendPagination ? data.length : await YouTubeData.countDocuments(filter);
    const totalPages = frontendPagination ? 1 : Math.max(1, Math.ceil(total / limit));

    return res.status(200).json({
      success: true,
      refreshedCount,
      activityLookbackDays: CREATOR_LOOKBACK_DAYS,
      activityLookbackStartDate: activeSinceDate,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage: frontendPagination ? false : page < totalPages,
        hasPrevPage: frontendPagination ? false : page > 1,
        frontendPagination,
      },
      ...(liveError ? { warning: liveError } : {}),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || 500, 'YOUTUBE_DATA_BROWSE');
    return res.status(err?.status || 500).json({
      success: false,
      error: err?.message || 'Failed to load YouTube creators',
    });
  }
}




const STATIC_TIER_ID_MAP = {
  // CollabGlam default seed ids. Keep this as a safe fallback when campaign details are not populated.
  '69aa85fa66939e6156941f5a': 'Nano',
  '69aa85fa66939e6156941f5b': 'Micro',
  '69aa85fa66939e6156941f5c': 'Mid-tier',
  '69aa85fa66939e6156941f5d': 'Macro',
  '69aa85fa66939e6156941f5e': 'Mega',
};

const STATIC_COUNTRY_ID_MAP = {
  // Known CollabGlam seed ids seen in production examples.
  '69affeed51f02c6df244da0c': 'CN',
  '69affeed51f02c6df244daae': 'US',
};

function toObjectIdOrString(value) {
  const raw = cleanStr(value);
  if (!raw) return null;
  try {
    const mongoose = require('mongoose');
    if (mongoose.Types.ObjectId.isValid(raw)) return new mongoose.Types.ObjectId(raw);
  } catch (_) {}
  return raw;
}

async function findFirstByIds(collectionNames = [], ids = []) {
  const cleanIds = uniqueCleanValues(ids);
  if (!cleanIds.length) return null;

  try {
    const mongoose = require('mongoose');
    const mongoIds = cleanIds.map(toObjectIdOrString).filter(Boolean);

    for (const collectionName of collectionNames) {
      try {
        const doc = await mongoose.connection.collection(collectionName).findOne({
          $or: [
            { _id: { $in: mongoIds } },
            { id: { $in: cleanIds } },
            { value: { $in: cleanIds } },
          ],
        });
        if (doc) return doc;
      } catch (_) {}
    }
  } catch (_) {}

  return null;
}

function normalizeTierLabel(value = '') {
  const raw = cleanStr(value);
  const lower = raw.toLowerCase();
  if (!lower) return '';
  if (lower.includes('nano') || /1k/.test(lower)) return 'Nano';
  if (lower.includes('micro') || /10k/.test(lower)) return 'Micro';
  if (lower.includes('mid')) return 'Mid-tier';
  if (lower.includes('macro') || /500k/.test(lower)) return 'Macro';
  if (lower.includes('mega') || /1m/.test(lower)) return 'Mega';
  return raw;
}

async function resolveCampaignCountryCode(campaign = {}) {
  const direct = cleanStr(
    campaign.targetCountry ||
      campaign.country ||
      campaign.audienceCountry ||
      campaign.targetAudience?.country ||
      campaign?.details?.targetCountries?.[0]?.countryCode ||
      campaign?.details?.targetCountries?.[0]?.code ||
      campaign?.details?.targetCountries?.[0]?.countryName ||
      ''
  );

  if (/^[A-Za-z]{2}$/.test(direct)) return direct.toUpperCase();

  const ids = Array.isArray(campaign.targetCountryIds) ? campaign.targetCountryIds : [];
  for (const id of ids) {
    const mapped = STATIC_COUNTRY_ID_MAP[cleanStr(id)];
    if (mapped) return mapped;
  }

  const countryDoc = await findFirstByIds(
    ['countries', 'country', 'listcountries', 'list_countries', 'Country'],
    ids
  );

  const resolved = cleanStr(countryDoc?.countryCode || countryDoc?.code || countryDoc?.iso2 || countryDoc?.countryName || countryDoc?.name);
  return /^[A-Za-z]{2}$/.test(resolved) ? resolved.toUpperCase() : resolved.toUpperCase();
}

async function resolveCampaignTierLabel(campaign = {}) {
  const direct = normalizeTierLabel(
    campaign?.details?.influencerTiers?.[0]?.category ||
      campaign?.details?.influencerTiers?.[0]?.name ||
      campaign?.details?.influencerTiers?.[0]?.value ||
      campaign?.influencerTier ||
      campaign?.subscriberTier ||
      ''
  );
  if (direct) return direct;

  const ids = Array.isArray(campaign.influencerTierIds) ? campaign.influencerTierIds : [];
  for (const id of ids) {
    const mapped = STATIC_TIER_ID_MAP[cleanStr(id)];
    if (mapped) return mapped;
  }

  const tierDoc = await findFirstByIds(
    ['influencertiers', 'influencerTiers', 'influencer_tiers', 'tiers', 'subscriptiontiers'],
    ids
  );

  return normalizeTierLabel(tierDoc?.category || tierDoc?.name || tierDoc?.label || tierDoc?.value || tierDoc?.tier || '');
}

function pickCampaignSearchKeywords(campaign = {}) {
  const title = cleanStr(campaign.campaignTitle || campaign.title || campaign.name || campaign.campaignName);
  const description = cleanStr(campaign.description);
  const category = cleanStr(campaign.campaignCategory || campaign.category);
  const subcategory = cleanStr(campaign.campaignSubcategory || campaign.subcategory);

  const detailSubcategoryTags = [];
  for (const sub of campaign?.details?.subcategories || []) {
    if (Array.isArray(sub.tags)) detailSubcategoryTags.push(...sub.tags);
    if (sub.name) detailSubcategoryTags.push(sub.name);
  }

  const descriptionSignals = description
    .split(/[^A-Za-z0-9]+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 4)
    .filter(
      (x) =>
        !/with|this|that|your|from|into|have|will|they|them|campaign|solution|solutions|future|advanced|technology|designed|creators|professionals|businesses|exceptional|quality|reliable|performance|discover|experience|marketing|budget|focus|building|brand|awareness|driving|online|sales|include|copy|creative|video|concepts|audience|targeting|strategies|allocation|clear|maximize|market|reach|platforms|facebook|instagram|youtube|google|ads/i.test(
          x
        )
    )
    .slice(0, 12);

  const base = uniqueCleanValues([
    title,
    category,
    subcategory,
    ...detailSubcategoryTags,
    ...descriptionSignals,
  ]);

  const joined = base.join(' ').toLowerCase();
  if (/drone|dji|mavic|fpv|uav|aerial|action\s*cam|gopro|insta360|osmo/.test(joined)) {
    base.push(
      'drone',
      'drones',
      'drone camera',
      'camera drone',
      'dji drone',
      'mavic drone',
      'fpv drone',
      'aerial photography',
      'aerial videography',
      'drone review',
      'drone unboxing',
      'drone tutorial',
      'drone test',
      'action camera',
      'gopro',
      'insta360',
      'osmo action'
    );
  }

  return uniqueCleanValues(base).slice(0, 45);
}

function pickCampaignTierRangeFromLabel(tierLabel = '') {
  const tierRange = getSubscriberTierRange(tierLabel);
  return {
    tierLabel: normalizeTierLabel(tierLabel),
    minSubscribers: tierRange?.min ?? null,
    maxSubscribers: tierRange?.max ?? null,
  };
}

async function buildRecommendationCampaignDetails(campaign = {}) {
  const title = cleanStr(campaign.campaignTitle || campaign.title || campaign.name || campaign.campaignName);
  const description = cleanStr(campaign.description);
  const category = cleanStr(campaign.campaignCategory || campaign.category || campaign?.details?.category?.name);
  const subcategory = cleanStr(
    campaign.campaignSubcategory ||
      campaign.subcategory ||
      campaign?.details?.subcategories?.[0]?.name
  );
  const country = await resolveCampaignCountryCode(campaign);
  const tier = pickCampaignTierRangeFromLabel(await resolveCampaignTierLabel(campaign));
  const detailKeywords = pickCampaignSearchKeywords(campaign);

  const searchBase = cleanStr(title || subcategory || category);
  const recommendationSearchQueries = uniqueCleanValues([
    searchBase,
    subcategory,
    category,
    `${searchBase} review`,
    `${searchBase} unboxing`,
    `${searchBase} product review`,
    `${searchBase} comparison`,
    country ? `${searchBase} ${country}` : '',
    country ? `${searchBase} review ${country}` : '',
    ...detailKeywords,
  ]).slice(0, MAX_SEARCH_QUERIES);

  return {
    campaignId: cleanStr(campaign._id || campaign.id),
    campaignName: title,
    productName: title,
    campaignNiche: subcategory || category || title,
    targetCountry: country,
    minSubscribers:
      toIntOrNull(campaign.minSubscribers) ??
      toIntOrNull(campaign.minFollowers) ??
      tier.minSubscribers,
    maxSubscribers:
      toIntOrNull(campaign.maxSubscribers) ??
      toIntOrNull(campaign.maxFollowers) ??
      tier.maxSubscribers,
    minAvgViews: null,
    keywords: uniqueCleanValues([
      title,
      category,
      subcategory,
      ...detailKeywords,
    ]),
    recommendationSearchQueries,
    rawCampaignTitle: title,
    rawCampaignDescription: description,
    rawCampaignCategory: category,
    rawCampaignSubcategory: subcategory,
    subscriberTier: tier.tierLabel,
  };
}

function textIncludesAny(haystack = '', needles = []) {
  const hay = cleanStr(haystack).toLowerCase();
  return needles.some((needle) => {
    const n = cleanStr(needle).toLowerCase();
    return n && hay.includes(n);
  });
}

function getRecommendationPositiveTerms(campaignDetails = {}) {
  const terms = uniqueCleanValues([
    campaignDetails.rawCampaignTitle,
    campaignDetails.rawCampaignCategory,
    campaignDetails.rawCampaignSubcategory,
    ...(campaignDetails.keywords || []),
  ]).map((x) => x.toLowerCase());

  const joined = terms.join(' ');
  if (/drone|dji|mavic|fpv|uav|aerial|action\s*cam|gopro|insta360|osmo/.test(joined)) {
    return uniqueCleanValues([
      ...terms,
      'drone',
      'drones',
      'drone camera',
      'camera drone',
      'aerial photography',
      'aerial videography',
      'fpv drone',
      'uav',
      'dji',
      'mavic',
      'mini drone',
      'action camera',
      'gopro',
      'insta360',
      'osmo action',
      'camera gear',
      'tech review',
      'product review',
      'unboxing',
    ]);
  }

  return uniqueCleanValues(terms);
}

function getRecommendationNegativeTerms(campaignDetails = {}) {
  const joined = [
    campaignDetails.rawCampaignTitle,
    campaignDetails.rawCampaignCategory,
    campaignDetails.rawCampaignSubcategory,
    ...(campaignDetails.keywords || []),
  ].join(' ').toLowerCase();

  const base = [
    'news',
    'bbc',
    'cnn',
    'breaking news',
    'politics',
    'war',
    'ukraine',
    'russia',
    'official channel',
    'official youtube channel',
    'brand channel',
    'kids',
    'cartoon',
    'cricket',
    'football',
    'food',
    'comedy',
    'funny',
    'ball collection',
  ];

  if (/drone|dji|mavic|fpv|uav|aerial|action\s*cam|gopro|insta360|osmo/.test(joined)) {
    base.push('ball review', 'cricket ball', 'sports ball', 'weather', 'monsoon');
  }

  return base;
}

function getRecommendationCoreTerms(campaignDetails = {}) {
  const baseTerms = getRecommendationPositiveTerms(campaignDetails)
    .map((x) => cleanStr(x).toLowerCase())
    .filter((x) => x && x.length >= 3)
    .filter((x) => !/campaign|marketing|awareness|sales|creator|creators|youtube|google|budget|platform|product review|unboxing|review|comparison|test|demo|top|best/.test(x));

  const joined = [
    campaignDetails.rawCampaignTitle,
    campaignDetails.rawCampaignCategory,
    campaignDetails.rawCampaignSubcategory,
    ...(campaignDetails.keywords || []),
  ].join(' ').toLowerCase();

  if (/drone|dji|mavic|fpv|uav|aerial|action\s*cam|gopro|insta360|osmo/.test(joined)) {
    return uniqueCleanValues([
      'drone',
      'drones',
      'drone camera',
      'camera drone',
      'aerial photography',
      'aerial videography',
      'fpv drone',
      'fpv',
      'uav',
      'dji',
      'mavic',
      'mini drone',
      'action camera',
      'gopro',
      'insta360',
      'osmo',
      'osmo action',
    ]);
  }

  return uniqueCleanValues(baseTerms).slice(0, 16);
}

function countRecommendationTermHits(text = '', terms = []) {
  const hay = cleanStr(text).toLowerCase();
  let count = 0;
  for (const term of terms) {
    const t = cleanStr(term).toLowerCase();
    if (t && hay.includes(t)) count += 1;
  }
  return count;
}

function countRecentVideoMatchesForTerms(videos = [], terms = []) {
  return (Array.isArray(videos) ? videos : [])
    .slice(0, 25)
    .filter((video) => countRecommendationTermHits(`${video.title || ''} ${video.description || ''}`, terms) > 0)
    .length;
}

function isHardRejectedRecommendationCreator(creator = {}, campaignDetails = {}) {
  const negativeTerms = getRecommendationNegativeTerms(campaignDetails);
  const nameText = cleanStr(creator.channelName);
  const descriptionText = cleanStr(creator.description || creator.channelDescription);
  const tagsText = (creator.channelTags || []).join(' ');
  const recentText = (creator.recentVideos || creator.recentVideoTitles || [])
    .slice(0, 10)
    .map((video) => `${video.title || ''} ${video.description || ''}`)
    .join(' ');
  const categoryText = cleanStr(`${creator.category || ''} ${creator.channelCategory || ''}`);
  const allText = `${nameText} ${descriptionText} ${tagsText} ${recentText} ${categoryText}`.toLowerCase();
  const contentFlag = cleanStr(creator.contentFlag).toLowerCase();

  if (contentFlag.includes('brand') || contentFlag.includes('compilation') || contentFlag.includes('ai generated')) return true;
  if (/official youtube channel|official channel|home to everything|welcome to the official/i.test(descriptionText)) return true;
  if (/news|publication|trade|media outlet|official/i.test(categoryText)) return true;

  // Avoid agency recommendations that are clearly not independent creators for the campaign niche.
  if (textIncludesAny(allText, negativeTerms)) return true;

  return false;
}

function scoreCreatorForRecommendation(creator = {}, campaignDetails = {}) {
  if (isHardRejectedRecommendationCreator(creator, campaignDetails)) return 0;

  const coreTerms = getRecommendationCoreTerms(campaignDetails);
  const nameText = cleanStr(creator.channelName);
  const descriptionText = cleanStr(creator.description || creator.channelDescription);
  const tagsText = (creator.channelTags || []).join(' ');
  const recentVideos = creator.recentVideos || creator.recentVideoTitles || [];
  const recentText = recentVideos
    .slice(0, 25)
    .map((video) => `${video.title || ''} ${video.description || ''}`)
    .join(' ');
  const sourceText = cleanStr(`${creator.sourceVideoTitle || ''} ${creator.foundViaQuery || ''}`);

  const channelText = `${nameText} ${descriptionText} ${tagsText}`;
  const channelHits = countRecommendationTermHits(channelText, coreTerms);
  const recentMatches = countRecentVideoMatchesForTerms(recentVideos, coreTerms);
  const sourceHits = countRecommendationTermHits(sourceText, coreTerms);
  const reviewSignals = countRecommendationTermHits(
    `${channelText} ${recentText}`,
    ['review', 'unboxing', 'test', 'tested', 'tutorial', 'demo', 'comparison', 'hands on', 'setup']
  );

  let score = 0;
  score += Math.min(42, channelHits * 14);
  score += Math.min(42, recentMatches * 8);
  score += Math.min(12, reviewSignals * 3);
  score += Math.min(6, sourceHits * 2);

  // Source-video-only matches are weak. A creator should have the niche in their
  // channel profile/tags or multiple recent videos, not just one search result.
  if (sourceHits > 0 && channelHits === 0 && recentMatches < 2) {
    score = Math.min(score, 30);
  }

  const avgViews = Number(creator.avgViews || 0);
  const engagement = Number(creator.engagementRate || 0);
  if (avgViews >= 10000) score += 4;
  if (engagement >= 1) score += 4;
  if (engagement >= 3) score += 4;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function creatorMatchesRecommendationRelevance(creator, campaignDetails = {}) {
  const score = scoreCreatorForRecommendation(creator, campaignDetails);
  creator.recommendationMatchScore = score;
  creator.scores = {
    ...(creator.scores || {}),
    campaignMatchScore: score,
    recommendationMatchScore: score,
  };
  creator.filterMatch = {
    ...(creator.filterMatch || {}),
    recommendationMatchScore: score,
    campaignCategoryMatch: score >= 45,
  };
  return score >= 45;
}

function splitCreatorsByRecommendationFit(creators = [], campaignDetails = {}, context = {}) {
  const targetCountry = cleanStr(context.country || campaignDetails.targetCountry).toUpperCase();
  const hasCountry = Boolean(targetCountry);
  const hasTier = context.minSubscribers != null || context.maxSubscribers != null;

  const enriched = creators.map((creator) => {
    const countryMatch = !hasCountry || cleanStr(creator.country).toUpperCase() === targetCountry;
    const tierMatch = !hasTier || isSubscriberTierMatch(creator.subscribers || creator.subscriberCount, context.minSubscribers, context.maxSubscribers);
    const relevanceMatch = creatorMatchesRecommendationRelevance(creator, campaignDetails);
    const recommendationScore = Number(creator.recommendationMatchScore || creator.scores?.recommendationMatchScore || 0);

    // Same idea as the original Apps Script creator discovery flow: a creator found
    // from the campaign query/source video is still useful even when their channel
    // profile text is not keyword-heavy. Keep these as a second-priority fallback
    // so the invite API can return up to 25 relevant creators instead of only the
    // few creators that pass the very strict campaignCategoryMatch threshold.
    const sourceCampaignMatch = recommendationScore >= 25;

    creator.filterMatch = {
      ...(creator.filterMatch || {}),
      countryMatch,
      subscriberTierMatch: tierMatch,
      campaignCategoryMatch: relevanceMatch,
      sourceCampaignMatch,
      softCampaignMatch: sourceCampaignMatch,
      strictCampaignMatch: countryMatch && tierMatch && relevanceMatch,
    };

    return creator;
  });

  const exact = enriched.filter((x) => x.filterMatch.strictCampaignMatch);
  const sameCountryRelevant = enriched.filter((x) => !x.filterMatch.strictCampaignMatch && x.filterMatch.countryMatch && x.filterMatch.campaignCategoryMatch);
  const sameCountrySoft = enriched.filter((x) => !x.filterMatch.strictCampaignMatch && !x.filterMatch.campaignCategoryMatch && x.filterMatch.countryMatch && x.filterMatch.softCampaignMatch);
  const sameCountryFallback = enriched.filter(
    (x) =>
      !x.filterMatch.strictCampaignMatch &&
      x.filterMatch.countryMatch &&
      !x.filterMatch.campaignCategoryMatch &&
      !x.filterMatch.softCampaignMatch
  );
  const relevantOnly = enriched.filter((x) => !x.filterMatch.countryMatch && x.filterMatch.campaignCategoryMatch);
  const softRelevantOnly = enriched.filter((x) => !x.filterMatch.countryMatch && !x.filterMatch.campaignCategoryMatch && x.filterMatch.softCampaignMatch);
  const rest = enriched.filter((x) => !x.filterMatch.countryMatch && !x.filterMatch.campaignCategoryMatch && !x.filterMatch.softCampaignMatch);

  return { exact, sameCountryRelevant, sameCountrySoft, sameCountryFallback, relevantOnly, softRelevantOnly, rest };
}

function sortRecommendedCreators(items = []) {
  return [...items].sort((a, b) => {
    const aStrict = a.filterMatch?.strictCampaignMatch ? 1 : 0;
    const bStrict = b.filterMatch?.strictCampaignMatch ? 1 : 0;
    if (aStrict !== bStrict) return bStrict - aStrict;

    const aCountry = a.filterMatch?.countryMatch ? 1 : 0;
    const bCountry = b.filterMatch?.countryMatch ? 1 : 0;
    if (aCountry !== bCountry) return bCountry - aCountry;

    const aTier = a.filterMatch?.subscriberTierMatch ? 1 : 0;
    const bTier = b.filterMatch?.subscriberTierMatch ? 1 : 0;
    if (aTier !== bTier) return bTier - aTier;

    const aRec = Number(a.recommendationMatchScore || a.scores?.recommendationMatchScore || 0);
    const bRec = Number(b.recommendationMatchScore || b.scores?.recommendationMatchScore || 0);
    if (aRec !== bRec) return bRec - aRec;

    const aScore = Number(a.shortlist?.score || a.scores?.shortlistScore || a.scores?.relevancyScore || 0);
    const bScore = Number(b.shortlist?.score || b.scores?.shortlistScore || b.scores?.relevancyScore || 0);
    if (aScore !== bScore) return bScore - aScore;

    return Number(b.subscriberCount || b.subscribers || 0) - Number(a.subscriberCount || a.subscribers || 0);
  });
}

function uniqueRecommendedCreatorsByChannel(creators = []) {
  const seen = new Set();
  const out = [];

  for (const creator of creators) {
    const key = cleanStr(creator?.channelId || creator?.channelUrl || creator?.channelName).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(creator);
  }

  return out;
}

function selectCampaignRecommendationCreatorsFromSplit(split = {}, { limit = 50, hardCountry = true } = {}) {
  const finalLimit = Math.min(50, Math.max(1, Number(limit || 50)));
  const exact = sortRecommendedCreators(split.exact || []);

  // Tier remains first priority. After exact tier+country+category matches, fill
  // up to 25 using same-country campaign creators discovered from the campaign
  // search terms. This matches the Apps Script style flow: query -> source video
  // -> channel -> shortlist, instead of returning an empty/9-result page.
  const fallbackPool = hardCountry
    ? sortRecommendedCreators([
        ...(split.sameCountryRelevant || []),
        ...(split.sameCountrySoft || []),
        ...(split.sameCountryFallback || []),
      ])
    : sortRecommendedCreators([
        ...(split.sameCountryRelevant || []),
        ...(split.sameCountrySoft || []),
        ...(split.sameCountryFallback || []),
        ...(split.relevantOnly || []),
        ...(split.softRelevantOnly || []),
        ...(split.rest || []),
      ]);

  // Always cap at 25, but do not stop at 9 just because exact-tier matches are low.
  // The fallback pool is still built from campaign-search/source-video channels,
  // with same-country creators first, so it follows the Apps Script-style logic.
  return uniqueRecommendedCreatorsByChannel([...exact, ...fallbackPool]).slice(0, finalLimit);
}

function getCampaignInfluencerCollection() {
  const mongoose = require('mongoose');
  return mongoose.connection.collection('campaigninfluencers');
}

async function loadSavedCampaignInfluencerRecommendations({ campaignId, limit = 100 }) {
  const campaignKey = cleanStr(campaignId);
  if (!campaignKey) return [];

  const collection = getCampaignInfluencerCollection();
  const rows = await collection
    .find({
      campaignId: campaignKey,
      platform: 'youtube',
      $or: [
        { savedFromRecommendation: true },
        { source: /^youtube_campaign_recommendation/ },
        { status: 'recommended' },
      ],
    })
    .sort({ recommendationMatchScore: -1, shortlistScore: -1, subscribers: -1, savedAt: -1 })
    .limit(Math.max(1, Number(limit || 100)))
    .toArray();

  return rows.map((row) => {
    const raw = row.rawCreator && typeof row.rawCreator === 'object' ? row.rawCreator : {};
    return {
      ...raw,
      channelId: raw.channelId || row.channelId,
      channelName: raw.channelName || row.channelName,
      channelUrl: raw.channelUrl || row.channelUrl,
      thumbnail: raw.thumbnail || row.thumbnail,
      category: raw.category || row.category,
      channelCategory: raw.channelCategory || row.channelCategory || row.category,
      creatorTier: raw.creatorTier || row.creatorTier,
      subscribers: raw.subscribers || row.subscribers,
      subscriberCount: raw.subscriberCount || row.subscribers,
      avgViews: raw.avgViews || row.avgViews,
      engagementRate: raw.engagementRate || row.engagementRate,
      country: raw.country || row.country,
      estimatedAudienceCountry: raw.estimatedAudienceCountry || row.estimatedAudienceCountry,
      recommendationMatchScore: raw.recommendationMatchScore || row.recommendationMatchScore || row.campaignMatchScore || 0,
      scores: {
        ...(raw.scores || {}),
        recommendationMatchScore:
          raw.scores?.recommendationMatchScore || row.recommendationMatchScore || row.campaignMatchScore || 0,
        campaignMatchScore:
          raw.scores?.campaignMatchScore || row.campaignMatchScore || row.recommendationMatchScore || 0,
        shortlistScore: raw.scores?.shortlistScore || row.shortlistScore || 0,
        relevancyScore: raw.scores?.relevancyScore || row.relevancyScore || 0,
        authenticityScore: raw.scores?.authenticityScore || row.authenticityScore || 0,
        brandSafetyScore: raw.scores?.brandSafetyScore || row.brandSafetyScore || 0,
      },
      filterMatch: raw.filterMatch || row.filterMatch || {},
    };
  });
}

async function saveCampaignInfluencerRecommendations({
  campaignId,
  brandId,
  creators = [],
  source = 'youtube_campaign_recommendation',
}) {
  if (!campaignId || !Array.isArray(creators)) return 0;

  const collection = getCampaignInfluencerCollection();
  const campaignKey = cleanStr(campaignId);
  await collection.deleteMany({
    campaignId: campaignKey,
    platform: 'youtube',
    $or: [
      { savedFromRecommendation: true },
      { source: /^youtube_campaign_recommendation/ },
      { status: 'recommended' },
    ],
  });

  if (!creators.length) return 0;

  let saved = 0;

  for (const creator of creators) {
    const channelId = cleanStr(creator.channelId);
    if (!channelId) continue;

    const now = new Date();
    const doc = {
      campaignId: campaignKey,
      brandId: cleanStr(brandId),
      platform: 'youtube',
      source,
      channelId,
      channelName: creator.channelName || '',
      channelUrl: creator.channelUrl || '',
      thumbnail: creator.thumbnail || '',
      category: creator.category || creator.channelCategory || '',
      channelCategory: creator.channelCategory || creator.category || '',
      creatorTier: creator.creatorTier || getTierFromSubscribers(creator.subscribers || creator.subscriberCount || 0),
      subscribers: Number(creator.subscribers || creator.subscriberCount || 0),
      avgViews: Number(creator.avgViews || 0),
      engagementRate: Number(creator.engagementRate || 0),
      country: creator.country || '',
      estimatedAudienceCountry: creator.estimatedAudienceCountry || '',
      recommendationMatchScore: Number(creator.recommendationMatchScore || creator.scores?.recommendationMatchScore || 0),
      campaignMatchScore: Number(creator.scores?.campaignMatchScore || creator.recommendationMatchScore || 0),
      shortlistScore: Number(creator.shortlist?.score || creator.scores?.shortlistScore || 0),
      relevancyScore: Number(creator.scores?.relevancyScore || 0),
      authenticityScore: Number(creator.scores?.authenticityScore || 0),
      brandSafetyScore: Number(creator.scores?.brandSafetyScore || 0),
      filterMatch: creator.filterMatch || {},
      status: 'recommended',
      isSelected: true,
      selected: true,
      savedFromRecommendation: true,
      savedAt: now,
      updatedAt: now,
      rawCreator: creator,
    };

    await collection.updateOne(
      {
        campaignId: campaignKey,
        channelId,
        platform: 'youtube',
      },
      {
        $set: doc,
        $setOnInsert: {
          createdAt: now,
        },
      },
      {
        upsert: true,
      }
    );

    saved += 1;
  }

  return saved;
}

async function startCampaignRecommendationIncrementalJob({
  req,
  res,
  campaign,
  campaignId,
  brandId,
  campaignDetails,
  context,
  country,
  keyword,
  category,
  limit,
  minimumInfluencers,
  hardCountry,
  save,
  forceRefresh,
}) {
  const batchSize = Math.max(1, toIntOrNull(req.body.batchSize) || toIntOrNull(req.query.batchSize) || DISCOVERY_BATCH_SIZE);
  const job = createDiscoveryJob({
    type: 'campaign-recommendation',
    target: minimumInfluencers,
    limit,
    batchSize,
    meta: {
      campaignId,
      brandId: brandId || cleanStr(campaign.brandId),
      title: campaignDetails.rawCampaignTitle,
      category: campaignDetails.rawCampaignCategory,
      subcategory: campaignDetails.rawCampaignSubcategory,
      country,
      subscriberTier: campaignDetails.subscriberTier,
      minSubscribers: campaignDetails.minSubscribers,
      maxSubscribers: campaignDetails.maxSubscribers,
      strictCountry: hardCountry,
      tierIsMain: true,
    },
  });

  const addRecommendationCreator = (creator) => {
    const split = splitCreatorsByRecommendationFit([creator], campaignDetails, context);
    const exact = split.exact[0];
    const sameCountryRelevant = split.sameCountryRelevant[0];
    const relevantOnly = split.relevantOnly[0];

    // Tier is main: exact campaign matches (country + selected tier + relevance) appear first.
    // If there are not enough exact-tier creators, allow same-country relevant creators after them.
    let candidate = exact || sameCountryRelevant;
    if (!candidate && !hardCountry) candidate = relevantOnly;
    if (!candidate) return false;

    if (hardCountry && !candidate.filterMatch?.countryMatch) return false;
    if (!candidate.filterMatch?.campaignCategoryMatch) return false;

    return addCreatorToDiscoveryJob(job, candidate, sortRecommendedCreators);
  };

  startDiscoveryJob(job, async () => {
    if (!forceRefresh) {
      const savedCreators = await loadSavedCampaignInfluencerRecommendations({
        campaignId,
        limit: Math.max(limit * 2, minimumInfluencers * 2),
      });

      for (const creator of savedCreators) {
        addRecommendationCreator(creator);
        if (job.data.length >= limit) break;
      }

      if (job.data.length >= limit || job.data.length >= minimumInfluencers) {
        if (save) {
          await saveCampaignInfluencerRecommendations({
            campaignId,
            brandId: brandId || cleanStr(campaign.brandId),
            creators: job.data.slice(0, limit),
          });
        }
        return;
      }
    }

    await refreshChannelsForCampaign({
      ...campaignDetails,
      productName: keyword,
      campaignNiche: category || keyword,
      targetCountry: country,
      minSubscribers: null,
      maxSubscribers: null,
      minAvgViews: null,
      strictFilters: false,
      strictTier: false,
      strictCountry: hardCountry,
      targetSaveCount: Math.max(limit, minimumInfluencers),
      rawChannelLimit: Math.min(180, Math.max(limit * 4, minimumInfluencers * 4, 120)),
      recentVideoSample: 8,
      maxSearchQueries: 8,
      searchResultsPerQuery: 25,
      maxDiscoveryMs: 285000,
      skipOpenAIAnalysis: true,
      keywords: uniqueCleanValues([
        keyword,
        category,
        campaignDetails.rawCampaignCategory,
        campaignDetails.rawCampaignSubcategory,
        ...campaignDetails.keywords,
      ]),
      recommendationSearchQueries: campaignDetails.recommendationSearchQueries,
      onCreatorSaved: async ({ doc }) => {
        const dto = creatorListDTO(doc, context);
        addRecommendationCreator(dto);
        return job.data.length < limit;
      },
    });

    // Final DB fill pass: pull saved YouTubeData rows that match current campaign context.
    const activeSinceDate = getCreatorLookbackStartDate();
    const loadCreators = async ({ useKeyword = true, useCategory = true, useCountry = true }) => {
      const filter = buildMongoFilter({
        keyword: useKeyword ? keyword : '',
        country: useCountry && hardCountry ? country : '',
        minSubscribers: requestedTierRange.minSubscribers,
        maxSubscribers: requestedTierRange.maxSubscribers,
        minAvgViews: null,
        minEngagement: null,
        category: useCategory ? category : '',
        campaignId,
        includeExcluded: false,
        strictFilters: true,
        activeSinceDate,
      });

      const docs = await YouTubeData.find(filter)
        .sort(SORT_MAP.relevance)
        .limit(Math.min(50, Math.max(limit * 2, minimumInfluencers * 2, 40)))
        .lean();

      return sortDiscoveryDataForSelectedFilters(
        docs.map((doc) => creatorListDTO(doc, context)),
        context
      );
    };

    const pools = [
      await loadCreators({ useKeyword: true, useCategory: true, useCountry: Boolean(country) }),
      await loadCreators({ useKeyword: false, useCategory: true, useCountry: Boolean(country) }),
    ];

    if (!hardCountry) {
      pools.push(await loadCreators({ useKeyword: false, useCategory: true, useCountry: false }));
    }

    for (const pool of pools) {
      for (const creator of pool) {
        addRecommendationCreator(creator);
        if (job.data.length >= limit) break;
      }
      if (job.data.length >= limit) break;
    }

    if (save) {
      await saveCampaignInfluencerRecommendations({
        campaignId,
        brandId: brandId || cleanStr(campaign.brandId),
        creators: job.data.slice(0, limit),
      });
    }
  });

  return res.status(202).json(buildJobResponse(job, {
    campaignId,
    brandId: brandId || cleanStr(campaign.brandId),
    minimumInfluencers,
    requestedLimit: limit,
    strictCountry: hardCountry,
    strictTierFirst: Boolean(campaignDetails.subscriberTier),
    campaignSearchContext: {
      title: campaignDetails.rawCampaignTitle,
      description: campaignDetails.rawCampaignDescription,
      category: campaignDetails.rawCampaignCategory,
      subcategory: campaignDetails.rawCampaignSubcategory,
      country,
      strictCountry: hardCountry,
      subscriberTier: campaignDetails.subscriberTier,
      minSubscribers: campaignDetails.minSubscribers,
      maxSubscribers: campaignDetails.maxSubscribers,
      keywords: campaignDetails.keywords,
      recommendationSearchQueries: campaignDetails.recommendationSearchQueries,
    },
  }));
}

async function recommendInfluencersForCampaign(req, res) {
  try {
    const campaignId = cleanStr(req.params.campaignId || req.body.campaignId || req.query.campaignId);
    const brandId = cleanStr(req.body.brandId || req.query.brandId);

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        error: 'campaignId is required',
      });
    }

    if (!Campaign) {
      return res.status(500).json({
        success: false,
        error: 'Campaign model not found',
      });
    }

    const campaign = await Campaign.findById(campaignId).lean();

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: 'Campaign not found',
      });
    }

    // Campaign recommendation should return up to 50 creators for the invite flow.
    // Exact selected-tier creators are prioritized, then relevant fallback creators fill the list.
    const requestedMinimum =
      toIntOrNull(req.body.minimumInfluencers) ||
      toIntOrNull(req.body.minInfluencers) ||
      toIntOrNull(req.query.minimumInfluencers) ||
      toIntOrNull(req.query.minInfluencers) ||
      50;

    // This API returns up to 50 creators. It may return fewer when the selected
    // campaign tier/country/category does not have enough accurate matches.
    const maximumCampaignRecommendations = 50;
    const minimumInfluencers = Math.min(
      maximumCampaignRecommendations,
      Math.max(1, requestedMinimum)
    );

    const requestedLimit =
      toIntOrNull(req.body.limit) || toIntOrNull(req.query.limit) || maximumCampaignRecommendations;
    const limit = Math.min(
      maximumCampaignRecommendations,
      Math.max(1, requestedLimit)
    );

    const save = String(req.body.save ?? req.query.save ?? 'true').toLowerCase() !== 'false';
    const hardCountry = String(req.body.strictCountry ?? req.query.strictCountry ?? 'true').toLowerCase() !== 'false';
    const forceRefresh =
      String(req.body.forceRefresh ?? req.query.forceRefresh ?? 'false').toLowerCase() === 'true' ||
      String(req.body.force ?? req.query.force ?? 'false').toLowerCase() === 'true';

    const campaignDetails = await buildRecommendationCampaignDetails(campaign);
    const country = cleanStr(campaignDetails.targetCountry).toUpperCase();
    const keyword = cleanStr(campaignDetails.rawCampaignTitle || campaignDetails.productName);
    const category = cleanStr(
      campaignDetails.rawCampaignSubcategory ||
        campaignDetails.rawCampaignCategory ||
        campaignDetails.campaignNiche
    );

    const requestedTierRange = {
      minSubscribers: campaignDetails.minSubscribers,
      maxSubscribers: campaignDetails.maxSubscribers,
    };

    const context = {
      keyword,
      category,
      country,
      minSubscribers: requestedTierRange.minSubscribers,
      maxSubscribers: requestedTierRange.maxSubscribers,
      subscriberTier: campaignDetails.subscriberTier,
      // Tier is the main rule for campaign recommendations.
      strictFilters: true,
      strictTier: Boolean(campaignDetails.subscriberTier),
    };

    const buildResponse = ({ creators, refreshedCount = 0, savedCount = 0, fromCache = false, warning = undefined }) => ({
      success: true,
      campaignId,
      brandId: brandId || cleanStr(campaign.brandId),
      minimumInfluencers,
      requestedLimit: limit,
      refreshedCount,
      savedCount,
      count: creators.length,
      exactMatchCount: creators.filter((x) => x.filterMatch?.strictCampaignMatch).length,
      sameCountryRelevantCount: creators.filter((x) => x.filterMatch?.countryMatch && (x.filterMatch?.campaignCategoryMatch || x.filterMatch?.softCampaignMatch)).length,
      strictCountry: hardCountry,
      strictTierFirst: Boolean(campaignDetails.subscriberTier),
      strictTier: Boolean(campaignDetails.subscriberTier),
      maxRecommendations: limit,
      fromCache,
      data: creators,
      creators,
      recommendations: creators,
      recommendedCreators: creators,
      campaignSearchContext: {
        title: campaignDetails.rawCampaignTitle,
        description: campaignDetails.rawCampaignDescription,
        category: campaignDetails.rawCampaignCategory,
        subcategory: campaignDetails.rawCampaignSubcategory,
        country,
        strictCountry: hardCountry,
        subscriberTier: campaignDetails.subscriberTier,
        minSubscribers: campaignDetails.minSubscribers,
        maxSubscribers: campaignDetails.maxSubscribers,
        keywords: campaignDetails.keywords,
        recommendationSearchQueries: campaignDetails.recommendationSearchQueries,
      },
      warning,
    });

    if (shouldUseIncrementalMode({ ...req.query, ...req.body })) {
      return startCampaignRecommendationIncrementalJob({
        req,
        res,
        campaign,
        campaignId,
        brandId,
        campaignDetails,
        context,
        country,
        keyword,
        category,
        limit,
        minimumInfluencers,
        hardCountry,
        save,
        forceRefresh,
      });
    }

    // Fast path: if this campaign was already generated and saved, return it from DB.
    // This prevents the invite page from starting a full YouTube discovery again on reload/back.
    if (!forceRefresh) {
      const savedCreators = await loadSavedCampaignInfluencerRecommendations({
        campaignId,
        limit: Math.max(limit * 2, minimumInfluencers * 2),
      });

      if (savedCreators.length) {
        const savedSplit = splitCreatorsByRecommendationFit(savedCreators, campaignDetails, context);
        // Return max 50, tier-first. If exact-tier creators are not enough,
        // keep the invite page useful with same-country/category relevant creators.
        let cachedCreators = selectCampaignRecommendationCreatorsFromSplit(savedSplit, {
          limit,
          hardCountry,
        });

        const cacheReadyCount = Math.min(limit, minimumInfluencers);
        if (cachedCreators.length >= cacheReadyCount) {
          return res.status(200).json(
            buildResponse({
              creators: cachedCreators,
              refreshedCount: 0,
              savedCount: 0,
              fromCache: true,
            })
          );
        }
        // Saved campaign rows exist but are not enough for the requested 50.
        // Continue into fresh discovery so the page can be topped up instead of
        // repeatedly showing only 9 cached creators.
      }
    }

    const refreshedCount = await refreshChannelsForCampaign({
      ...campaignDetails,
      productName: keyword,
      campaignNiche: category || keyword,
      targetCountry: country,
      minSubscribers: requestedTierRange.minSubscribers,
      maxSubscribers: requestedTierRange.maxSubscribers,
      minAvgViews: 500,
      // Do not hard-block discovery by tier. Tier is handled in ranking/selection
      // so exact tier is shown first, but the API can still return 25 relevant
      // campaign creators when the selected tier has too few exact matches.
      strictFilters: false,
      strictTier: false,
      strictCountry: hardCountry,
      targetSaveCount: Math.max(limit, minimumInfluencers),
      rawChannelLimit: Math.min(220, Math.max(limit * 6, 180)),
      recentVideoSample: 10,
      maxSearchQueries: 10,
      searchResultsPerQuery: 35,
      maxDiscoveryMs: 270000,
      skipOpenAIAnalysis: true,
      keywords: uniqueCleanValues([
        keyword,
        category,
        campaignDetails.rawCampaignCategory,
        campaignDetails.rawCampaignSubcategory,
        ...campaignDetails.keywords,
      ]),
      recommendationSearchQueries: campaignDetails.recommendationSearchQueries,
    });

    const activeSinceDate = getCreatorLookbackStartDate();

    const loadCreators = async ({ useKeyword = true, useCategory = true, useCountry = true }) => {
      const filter = buildMongoFilter({
        keyword: useKeyword ? keyword : '',
        country: useCountry && hardCountry ? country : '',
        minSubscribers: null,
        maxSubscribers: null,
        minAvgViews: null,
        minEngagement: null,
        category: useCategory ? category : '',
        campaignId,
        includeExcluded: false,
        strictFilters: false,
        activeSinceDate,
      });

      const docs = await YouTubeData.find(filter)
        .sort(SORT_MAP.relevance)
        .limit(Math.max(limit * 2, minimumInfluencers * 2, 80))
        .lean();

      return sortDiscoveryDataForSelectedFilters(
        docs.map((doc) => creatorListDTO(doc, context)),
        context
      );
    };

    const candidatePools = [];
    const addCandidatePool = async (opts) => {
      const rows = await loadCreators(opts);
      if (Array.isArray(rows) && rows.length) candidatePools.push(...rows);
      return uniqueRecommendedCreatorsByChannel(candidatePools).length;
    };

    await addCandidatePool({ useKeyword: true, useCategory: true, useCountry: Boolean(country) });

    if (uniqueRecommendedCreatorsByChannel(candidatePools).length < minimumInfluencers) {
      await addCandidatePool({ useKeyword: false, useCategory: true, useCountry: Boolean(country) });
    }

    if (uniqueRecommendedCreatorsByChannel(candidatePools).length < minimumInfluencers) {
      // Last strict-country fallback: use all creators discovered/saved for this
      // campaign, then let recommendation scoring decide the top 25. The Mongo
      // filter still includes campaignId, so this does not pull random creators.
      await addCandidatePool({ useKeyword: false, useCategory: false, useCountry: Boolean(country) });
    }

    // Never remove the country filter when strictCountry=true. This prevents India/Brazil/etc.
    // creators from being returned for a US campaign.
    if (uniqueRecommendedCreatorsByChannel(candidatePools).length < minimumInfluencers && !hardCountry) {
      await addCandidatePool({ useKeyword: false, useCategory: true, useCountry: false });
    }

    const candidateCreators = uniqueRecommendedCreatorsByChannel(candidatePools);

    const split = splitCreatorsByRecommendationFit(candidateCreators, campaignDetails, context);
    // Return max 50, tier-first. Exact selected-tier creators are prioritized.
    // If exact-tier creators are not available, show same-country/category relevant creators
    // instead of an empty invite page.
    let creators = selectCampaignRecommendationCreatorsFromSplit(split, {
      limit,
      hardCountry,
    });

    const savedCount = save
      ? await saveCampaignInfluencerRecommendations({
          campaignId,
          brandId: brandId || cleanStr(campaign.brandId),
          creators,
        })
      : 0;

    return res.status(200).json(
      buildResponse({
        creators,
        refreshedCount,
        savedCount,
        fromCache: false,
        warning:
          creators.length < minimumInfluencers
            ? `Only ${creators.length} creators were found for this campaign. Exact selected-tier creators are shown first; remaining slots use same-country campaign-relevant creators from the Apps Script-style discovery flow. This endpoint is capped at ${limit}.`
            : undefined,
      })
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.status || 500, 'YOUTUBE_CAMPAIGN_RECOMMEND_INFLUENCERS');
    return res.status(err?.status || 500).json({
      success: false,
      error: err?.message || 'Failed to recommend YouTube influencers',
    });
  }
}



function uniqueCleanValues(values = []) {
  return Array.from(new Set((values || []).map((x) => cleanStr(x)).filter(Boolean)));
}

function maskEmailForBrand(email) {
  const value = cleanStr(email);
  if (!value || value.indexOf('@') === -1) return '';
  const parts = value.split('@');
  const domain = parts[1] || '';
  if (!domain) return '';
  // Brand-facing masking: never expose full mailbox name.
  return `xxxxxxxx@${domain}`;
}

function countVideosSince(videos = [], days = 30) {
  const now = new Date();
  return (videos || []).filter((video) => {
    if (!video?.publishedAt) return false;
    return daysBetween(video.publishedAt, now) <= days;
  }).length;
}

function medianNumber(values = []) {
  const nums = values.map((x) => Number(x || 0)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

function scoreValue(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function percentValue(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 100) / 100;
}

function getCampaignFitLabel(score) {
  const value = Number(score || 0);
  if (value >= 85) return 'Excellent Match';
  if (value >= 70) return 'Strong Match';
  if (value >= 55) return 'Good Match';
  return 'Moderate Match';
}

function getBudgetFitLabel(avgViews) {
  const views = Number(avgViews || 0);
  if (views >= 1000000) return 'High';
  if (views >= 250000) return 'Medium-High';
  if (views >= 50000) return 'Medium';
  return 'Low-Medium';
}

function getCollaborationReadiness(sponsorshipFrequency, sponsoredVideosDetected) {
  const freq = Number(sponsorshipFrequency || 0);
  const count = Number(sponsoredVideosDetected || 0);
  if (freq >= 30 || count >= 8) return 'High';
  if (freq >= 10 || count >= 3) return 'Medium';
  return 'Emerging';
}

function extractContentTopics(doc, fallbackKeyword = '') {
  const tags = doc.channelTags || [];
  const category = cleanStr(doc.category || doc.channelCategory);
  const keyword = cleanStr(fallbackKeyword);
  const titleWords = (doc.recentVideos || [])
    .slice(0, 10)
    .flatMap((video) => cleanStr(video.title).split(/[^A-Za-z0-9]+/))
    .map((x) => x.trim())
    .filter((x) => x.length > 3 && !/review|best|with|this|that|your|from|into|video|shorts/i.test(x));

  return uniqueCleanValues([category, keyword, ...tags.slice(0, 8), ...titleWords.slice(0, 8)]).slice(0, 12);
}

function getShortsLongFormBreakdown(videos = []) {
  const total = Math.max(1, videos.length);
  const shorts = videos.filter((video) => /#shorts|\bshorts\b/i.test(`${video.title || ''} ${video.description || ''}`)).length;
  const shortsPercentage = Math.round((shorts / total) * 100);
  return {
    shortsPercentage,
    longFormPercentage: Math.max(0, 100 - shortsPercentage),
    note: 'Estimated from recent video metadata. Exact duration-based split requires duration collection.',
  };
}

function buildBrandMediaKitData(creator, context = {}) {
  const discovery = buildInfluencerDiscoveryData(creator, context);
  const videos = creator.recentVideos || [];
  const topVideos = [...videos].sort((a, b) => Number(b.views || 0) - Number(a.views || 0)).slice(0, 5);
  const recentVideos = [...videos].slice(0, 8);
  const medianViews = medianNumber(videos.map((v) => v.views));
  const avgViews = Number(creator.avgViews || 0);
  const avgLikes = Number(creator.avgLikes || 0);
  const avgComments = Number(creator.avgComments || 0);
  const subscribers = Number(creator.subscribers || 0);
  const engagementRate = percentValue(creator.engagementRate || 0);
  const viewToSubscriberRatio = subscribers > 0 ? percentValue((avgViews / subscribers) * 100) : 0;
  const uploadsLast30Days = countVideosSince(videos, 30);
  const uploadsLast90Days = countVideosSince(videos, 90) || Number(creator.uploadFrequency90Days || 0);
  const uploadsLast2Years = countVideosWithinLookback(videos);
  const sponsoredRegex = /sponsored|partnered|collaboration|#ad|#sponsored|use code|promo code|thanks to/i;
  const sponsoredVideosDetected = videos.filter((v) => sponsoredRegex.test(`${v.title || ''}\n${v.description || ''}`)).length;
  const sponsorshipFrequency = videos.length ? Math.round((sponsoredVideosDetected / videos.length) * 100) : 0;
  const scores = creator.scores || {};
  const relevancyScore = scoreValue(scores.relevancyScore || discovery.scores?.relevancyScore || discovery.shortlist?.score);
  const brandSafetyScore = scoreValue(scores.brandSafetyScore || discovery.scores?.brandSafetyScore || 95);
  const authenticityScore = scoreValue(scores.authenticityScore || discovery.scores?.authenticityScore || 85);
  const engagementScore = scoreValue(scores.engagementScore || discovery.scores?.engagementScore);
  const consistencyScore = scoreValue(scores.consistencyScore || discovery.scores?.consistencyScore);
  const sponsorshipScore = scoreValue(scores.sponsorshipScore || discovery.scores?.sponsorshipScore);
  const campaignFitScore = scoreValue(scores.shortlistScore || discovery.shortlist?.score || relevancyScore);
  const countryConfidence = scoreValue(scores.audienceCountryConfidence || discovery.audienceCountryConfidence);
  const primaryCountry = cleanStr(creator.country || creator.estimatedAudienceCountry || discovery.country || discovery.estimatedAudienceCountry || 'Unknown');
  const estimatedCountry = cleanStr(creator.estimatedAudienceCountry || creator.country || primaryCountry);
  const topics = extractContentTopics(creator, context.keyword || context.category || creator.category || creator.channelCategory);
  const contentBreakdown = getShortsLongFormBreakdown(videos);
  const emails = uniqueCleanValues([...(creator.contact?.emails || []), ...(creator.contact?.totalEmails || []), creator.contact?.youtubeAboutEmail]);
  const socialLinks = uniqueCleanValues([
    creator.contact?.instagram,
    creator.contact?.twitter,
    creator.contact?.facebook,
    creator.contact?.linkedin,
    ...(creator.contact?.socials || []),
    ...(creator.contact?.otherSocials || []),
  ]);
  const websites = uniqueCleanValues([creator.contact?.website, ...(creator.contact?.websites || [])]);
  const recentSponsors = uniqueCleanValues([...(creator.contact?.sponsors || []), ...(String(discovery.shortlist?.previousSponsors || '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'N/A'))]).slice(0, 8);
  const expectedViewsLow = Math.round((medianViews || avgViews) * 0.75);
  const expectedViewsHigh = Math.round((medianViews || avgViews) * 1.25);
  const expectedEngagementLow = Math.round(expectedViewsLow * (engagementRate / 100));
  const expectedEngagementHigh = Math.round(expectedViewsHigh * (engagementRate / 100));
  const safeRiskFlags = [];
  if (brandSafetyScore < 70) safeRiskFlags.push('Review content manually before approval');
  if (engagementRate < 0.5) safeRiskFlags.push('Low engagement rate');
  if (!creator.country) safeRiskFlags.push('Channel country not publicly set');

  const contact = {
    hasContactInfo: Boolean(emails.length || websites.length || socialLinks.length),
    // Keep original email in API response. Frontend is responsible for masking display.
    rawEmail: emails[0] || '',
    email: emails[0] || '',
    youtubeAboutEmail: emails[0] || '',
    totalEmails: emails,
    emails,
    maskedEmail: emails[0] || '',
    website: websites[0] || '',
    socialLinks: socialLinks.map((url) => {
      let platform = 'Website';
      if (/instagram\.com/i.test(url)) platform = 'Instagram';
      else if (/twitter\.com|x\.com/i.test(url)) platform = 'X / Twitter';
      else if (/facebook\.com/i.test(url)) platform = 'Facebook';
      else if (/tiktok\.com/i.test(url)) platform = 'TikTok';
      else if (/linkedin\.com/i.test(url)) platform = 'LinkedIn';
      return { platform, url };
    }).slice(0, 8),
  };

  return {
    creatorOverview: {
      creatorName: creator.channelName,
      channelName: creator.channelName,
      profilePhoto: creator.thumbnail,
      category: creator.category || creator.channelCategory || 'YouTube Creator',
      creatorTier: getTierFromSubscribers(creator.subscribers),
      primaryLanguage: creator.primaryLanguage || 'Unknown',
      secondaryLanguages: [],
      country: creator.country || '',
      estimatedAudienceCountry: estimatedCountry,
      countryConfidence,
      yearsOnYouTube: creator.yearsOnYouTube || 0,
      channelCreatedDate: creator.createdDate || creator.channelCreatedDate || null,
      activeSinceLabel: creator.createdDate || creator.channelCreatedDate ? `Active since ${new Date(creator.createdDate || creator.channelCreatedDate).getFullYear()}` : '',
    },
    coreMetrics: {
      subscribers,
      totalViews: creator.totalViews || 0,
      totalVideos: creator.totalVideos || 0,
      avgViews,
      medianViews,
      avgLikes,
      avgComments,
      engagementRate,
      viewToSubscriberRatio,
      recentUploadDate: creator.recentUploadDate || null,
      uploadsLast30Days,
      uploadsLast90Days,
      uploadsLast2Years,
    },
    performanceScores: {
      engagementScore,
      consistencyScore,
      authenticityScore,
      brandSafetyScore,
      sponsorshipScore,
      relevancyScore,
      campaignFitScore,
      nicheFitScore: scoreValue((discovery.shortlist?.nicheFit || scores.nicheFit || 0) * 10),
    },
    audienceInsights: {
      estimatedAudienceCountries: [
        { country: estimatedCountry || primaryCountry || 'Unknown', percentage: countryConfidence || 0 },
        ...(primaryCountry && primaryCountry !== estimatedCountry ? [{ country: primaryCountry, percentage: Math.max(0, 100 - (countryConfidence || 0)) }] : []),
      ].filter((x) => x.country && x.country !== 'Unknown' || x.percentage > 0),
      interestCategories: topics,
      contentLanguage: creator.primaryLanguage || 'Unknown',
    },
    brandFit: {
      matchedCampaignKeyword: context.keyword || context.category || creator.category || creator.channelCategory || '',
      matchedTopics: topics.slice(0, 8),
      campaignFit: getCampaignFitLabel(campaignFitScore),
      whyThisCreatorFits: [
        `${relevancyScore}% relevancy score for this niche`,
        `${engagementRate}% engagement rate from recent videos`,
        `${uploadsLast90Days} uploads in the last 90 days`,
        brandSafetyScore >= 85 ? 'Strong brand safety signal' : 'Needs manual brand-safety review',
        sponsorshipFrequency > 0 ? `${sponsorshipFrequency}% sponsorship frequency detected` : 'Limited sponsorship history detected',
      ].filter(Boolean),
    },
    contentAnalysis: {
      contentType: discovery.shortlist?.contentQuality || creator.contentFlag || 'Mixed',
      uploadFrequency: discovery.shortlist?.uploadFrequency || 'Unknown',
      shortsPercentage: contentBreakdown.shortsPercentage,
      longFormPercentage: contentBreakdown.longFormPercentage,
      averageVideoLengthMinutes: null,
      recentVideoThemes: topics.slice(0, 10),
      contentBreakdownNote: contentBreakdown.note,
    },
    sponsorshipAnalysis: {
      sponsoredVideosDetected,
      sponsorshipFrequency,
      recentSponsors,
      promoCodeMentions: videos.filter((v) => /promo code|use code|discount code/i.test(`${v.title || ''}\n${v.description || ''}`)).length,
      affiliateLinksDetected: Boolean((creator.contact?.otherLinks || []).length || (creator.contact?.websites || []).some((x) => /amzn\.to|bit\.ly|linktr|affiliate/i.test(x))),
      collaborationReadiness: getCollaborationReadiness(sponsorshipFrequency, sponsoredVideosDetected),
    },
    brandSafety: {
      score: brandSafetyScore,
      riskLevel: brandSafetyScore >= 85 ? 'Low' : brandSafetyScore >= 70 ? 'Medium' : 'High',
      flags: safeRiskFlags,
      safeCategories: uniqueCleanValues([creator.category, creator.channelCategory, ...topics]).slice(0, 6),
    },
    topPerformingVideos: topVideos.map((video) => ({
      title: video.title || '',
      views: video.views || 0,
      likes: video.likes || 0,
      comments: video.comments || 0,
      publishedAt: video.publishedAt || null,
      thumbnail: video.thumbnail || '',
    })),
    recentVideos: recentVideos.map((video) => ({
      title: video.title || '',
      views: video.views || 0,
      likes: video.likes || 0,
      comments: video.comments || 0,
      publishedAt: video.publishedAt || null,
      thumbnail: video.thumbnail || '',
    })),
    campaignPrediction: {
      expectedViewsLow,
      expectedViewsHigh,
      expectedEngagementLow,
      expectedEngagementHigh,
      recommendedDeliverables: [
        'Dedicated Review',
        'Integrated Mention',
        contentBreakdown.shortsPercentage > 25 ? 'Shorts Placement' : 'Community Post',
      ],
      budgetFit: getBudgetFitLabel(avgViews),
    },
    // Root-level email is kept for database/API convenience.
    // Frontend masks this value before displaying it.
    rawEmail: emails[0] || '',
    email: emails[0] || '',
    emails,
    contact,
    collabGlamRecommendation: {
      recommendation: getCampaignFitLabel(campaignFitScore),
      summary: `${creator.channelName} is a ${getTierFromSubscribers(creator.subscribers)} YouTube creator with ${avgViews.toLocaleString()} average views and a ${campaignFitScore}/100 campaign fit score for this search.`,
    },
  };
}

function getMediaKitEmailPayload(mediaKit = {}, creator = {}) {
  const contact = mediaKit?.contact || {};
  const creatorContact = creator?.contact || {};

  const emails = uniqueCleanValues([
    mediaKit?.rawEmail,
    mediaKit?.email,
    ...(Array.isArray(mediaKit?.emails) ? mediaKit.emails : []),
    contact?.rawEmail,
    contact?.email,
    contact?.youtubeAboutEmail,
    contact?.maskedEmail,
    ...(Array.isArray(contact?.emails) ? contact.emails : []),
    ...(Array.isArray(contact?.totalEmails) ? contact.totalEmails : []),
    creatorContact?.youtubeAboutEmail,
    ...(Array.isArray(creatorContact?.emails) ? creatorContact.emails : []),
    ...(Array.isArray(creatorContact?.totalEmails) ? creatorContact.totalEmails : []),
  ]).filter((email) => String(email || '').includes('@'));

  const email = emails[0] || '';
  const website = cleanStr(contact?.website || creatorContact?.website || creatorContact?.websites?.[0]);
  const socialLinks = Array.isArray(contact?.socialLinks)
    ? contact.socialLinks
    : uniqueCleanValues([
        creatorContact?.instagram,
        creatorContact?.twitter,
        creatorContact?.facebook,
        creatorContact?.linkedin,
        ...(Array.isArray(creatorContact?.socials) ? creatorContact.socials : []),
      ]).map((url) => ({ platform: 'Social', url }));

  return { email, emails, website, socialLinks };
}

function attachTopLevelEmailToMediaKit(mediaKit = {}, cachedRecord = {}) {
  const emailPayload = getMediaKitEmailPayload(mediaKit, {
    contact: {
      youtubeAboutEmail: cachedRecord.email,
      emails: cachedRecord.emails,
      totalEmails: cachedRecord.emails,
      website: cachedRecord.website,
      socials: (cachedRecord.socialLinks || []).map((link) => link?.url || link).filter(Boolean),
    },
  });

  const contact = {
    ...(mediaKit?.contact || {}),
    rawEmail: emailPayload.email,
    email: emailPayload.email,
    youtubeAboutEmail: emailPayload.email,
    totalEmails: emailPayload.emails,
    emails: emailPayload.emails,
    // Keep this as original email too; frontend masks it before display.
    maskedEmail: emailPayload.email,
    website: mediaKit?.contact?.website || cachedRecord.website || '',
    socialLinks: mediaKit?.contact?.socialLinks || cachedRecord.socialLinks || [],
  };

  return {
    ...(mediaKit || {}),
    rawEmail: emailPayload.email,
    email: emailPayload.email,
    emails: emailPayload.emails,
    contact,
  };
}


const MEDIA_KIT_DEFAULT_VIDEO_LIMIT = Math.max(
  1,
  Number(process.env.YOUTUBE_MEDIA_KIT_VIDEO_LIMIT || 12)
);
const MEDIA_KIT_MAX_VIDEO_LIMIT = Math.max(
  MEDIA_KIT_DEFAULT_VIDEO_LIMIT,
  Number(process.env.YOUTUBE_MEDIA_KIT_MAX_VIDEO_LIMIT || 20)
);

function resolveMediaKitVideoLimit(req) {
  const requested = Number(req?.query?.maxVideos || req?.query?.videoLimit || 0);
  const fallback = MEDIA_KIT_DEFAULT_VIDEO_LIMIT;

  if (!Number.isFinite(requested) || requested <= 0) return fallback;

  return Math.max(1, Math.min(MEDIA_KIT_MAX_VIDEO_LIMIT, Math.round(requested)));
}

function getFastMediaKitCreatorSnapshot(creator = {}, videoLimit = MEDIA_KIT_DEFAULT_VIDEO_LIMIT) {
  const recentVideos = Array.isArray(creator.recentVideos)
    ? creator.recentVideos.slice(0, videoLimit)
    : [];

  return {
    ...(creator || {}),
    recentVideos,
    channelTags: Array.isArray(creator.channelTags)
      ? creator.channelTags.slice(0, 20)
      : [],
    contact: {
      ...(creator.contact || {}),
      emails: Array.isArray(creator.contact?.emails)
        ? creator.contact.emails.slice(0, 5)
        : [],
      totalEmails: Array.isArray(creator.contact?.totalEmails)
        ? creator.contact.totalEmails.slice(0, 5)
        : [],
      socials: Array.isArray(creator.contact?.socials)
        ? creator.contact.socials.slice(0, 10)
        : [],
      otherSocials: Array.isArray(creator.contact?.otherSocials)
        ? creator.contact.otherSocials.slice(0, 10)
        : [],
      websites: Array.isArray(creator.contact?.websites)
        ? creator.contact.websites.slice(0, 5)
        : [],
    },
  };
}

function saveInfoMediaKitInBackground(req, channelId, creator, mediaKit) {
  if (!InfoMediaKit || !channelId || !creator || !mediaKit) return;

  const mediaKitEmailPayload = getMediaKitEmailPayload(mediaKit, creator);

  InfoMediaKit.updateOne(
    { channelId },
    {
      $set: {
        platform: 'youtube',
        channelId,
        channelName: creator.channelName || mediaKit?.creatorOverview?.channelName || '',
        channelUrl: creator.channelUrl || '',
        thumbnail: creator.thumbnail || mediaKit?.creatorOverview?.profilePhoto || '',
        country: creator.country || mediaKit?.creatorOverview?.country || '',
        estimatedAudienceCountry:
          creator.estimatedAudienceCountry || mediaKit?.creatorOverview?.estimatedAudienceCountry || '',
        creatorTier: getTierFromSubscribers(creator.subscribers),
        subscribers: Number(creator.subscribers || 0),
        email: mediaKitEmailPayload.email,
        emails: mediaKitEmailPayload.emails,
        website: mediaKitEmailPayload.website,
        socialLinks: mediaKitEmailPayload.socialLinks,
        mediaKitData: mediaKit,
        rawCreatorSnapshot: getFastMediaKitCreatorSnapshot(creator, MEDIA_KIT_DEFAULT_VIDEO_LIMIT),
        lastOpenedAt: new Date(),
      },
      $inc: { openCount: 1 },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  ).catch((saveErr) => {
    saveErrorLog(req, saveErr, saveErr?.status || 500, 'INFOMEDIAKIT_SAVE_FAILED').catch(() => {});
  });
}

async function getCreatorMediaKit(req, res) {
  try {
    const channelId = cleanStr(req.params.channelId);
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'channelId is required' });
    }

    const videoLimit = resolveMediaKitVideoLimit(req);

    // First return saved media kit data from the infomediakit collection.
    // This keeps Media Kit clicks fast and avoids rebuilding the same report.
    if (InfoMediaKit) {
      const cachedMediaKit = await InfoMediaKit.findOne({ channelId }).lean();
      if (cachedMediaKit?.mediaKitData) {
        InfoMediaKit.updateOne(
          { channelId },
          {
            $inc: { openCount: 1 },
            $set: { lastOpenedAt: new Date() },
          }
        ).catch(() => {});

        const cachedData = attachTopLevelEmailToMediaKit(
          cachedMediaKit.mediaKitData,
          cachedMediaKit
        );

        return res.status(200).json({
          success: true,
          data: cachedData,
          fromCache: true,
          fastMode: true,
          videoLimit,
        });
      }
    }

    const creator = await YouTubeData.findOne({ channelId }).lean();
    if (!creator) return res.status(404).json({ success: false, error: 'YouTube creator not found' });

    const context = {
      keyword: cleanStr(req.query.keyword || req.query.search),
      category: cleanStr(req.query.category || req.query.niche),
      country: cleanStr(req.query.country),
    };

    // Build from the already saved creator snapshot only. No fresh YouTube/OpenAI
    // enrichment is done on Media Kit click. This keeps first response fast while
    // still using relevant recent-video, score, contact, tier, country, and topic data.
    const fastCreator = getFastMediaKitCreatorSnapshot(creator, videoLimit);
    const mediaKit = attachTopLevelEmailToMediaKit(
      buildBrandMediaKitData(fastCreator, context),
      {}
    );

    // Save generated media kit in background for the next open.
    // Do not block the UI response on this write.
    saveInfoMediaKitInBackground(req, channelId, fastCreator, mediaKit);

    return res.status(200).json({
      success: true,
      data: mediaKit,
      fromCache: false,
      fastMode: true,
      videoLimit,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || 500, 'YOUTUBE_BRAND_MEDIA_KIT');
    return res.status(err?.status || 500).json({
      success: false,
      error: err?.message || 'Failed to load media kit',
    });
  }
}

async function proxyImage(req, res) {
  try {
    const rawUrl = cleanStr(req.query.url);

    if (!rawUrl) return res.status(400).send('Missing image URL');

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_) {
      return res.status(400).send('Invalid image URL');
    }

    const allowedHosts = [
      'yt3.ggpht.com',
      'yt3.googleusercontent.com',
      'i.ytimg.com',
      'img.youtube.com',
    ];

    if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname)) {
      return res.status(403).send('Image host not allowed');
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('Image proxy timeout')), 10000);

    try {
      const imageRes = await fetch(rawUrl, {
        dispatcher: httpAgent,
        signal: ac.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 CollabGlam Image Proxy',
          accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        },
      });

      if (!imageRes.ok) return res.status(204).end();

      const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
      const arrayBuffer = await imageRes.arrayBuffer();

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      return res.status(200).send(Buffer.from(arrayBuffer));
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return res.status(204).end();
  }
}

module.exports = {
  browseCreators,
  getCreatorMediaKit,
  proxyImage,
  recommendInfluencersForCampaign,
  getYouTubeDiscoveryJob,
};