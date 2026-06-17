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

const CampaignInfluencer =
  tryRequireModel([
    '../models/campaignInfluencer.model',
    '../models/campaignInfluencerModel',
    '../models/CampaignInfluencer',
    '../models/campaignInfluencer',
  ]) || null;

const CountryModel =
  tryRequireModel([
    '../models/country.model',
    '../models/countryModel',
    '../models/Country',
    '../models/country',
  ]) || null;

const CategoryModel =
  tryRequireModel([
    '../models/category.model',
    '../models/categoryModel',
    '../models/Category',
    '../models/category',
  ]) || null;

const SubcategoryModel =
  tryRequireModel([
    '../models/subcategory.model',
    '../models/subCategory.model',
    '../models/subcategoryModel',
    '../models/Subcategory',
    '../models/SubCategory',
    '../models/subcategory',
  ]) || null;

const InfluencerTierModel =
  tryRequireModel([
    '../models/influencerTier.model',
    '../models/influencerTierModel',
    '../models/InfluencerTier',
    '../models/influencerTier',
    '../models/tier.model',
  ]) || null;

const CampaignGoalModel =
  tryRequireModel([
    '../models/campaignGoal.model',
    '../models/campaignGoalModel',
    '../models/CampaignGoal',
    '../models/campaignGoal',
  ]) || null;

const ContentFormatModel =
  tryRequireModel([
    '../models/contentFormat.model',
    '../models/contentFormatModel',
    '../models/ContentFormat',
    '../models/contentFormat',
  ]) || null;


function getMongoose() {
  try {
    return require('mongoose');
  } catch (_) {
    return null;
  }
}

function toObjectIdOrNull(value) {
  const id = cleanStr(value);
  if (!id) return null;

  const mongoose = getMongoose();
  if (!mongoose?.Types?.ObjectId?.isValid(id)) return null;

  return new mongoose.Types.ObjectId(id);
}

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

// Prevent multiple long YouTube recommendation refresh jobs for the same campaign/filter.
// Use a Map instead of a Set so stale jobs can be recovered after a failed/aborted request.
const CAMPAIGN_RECOMMENDATION_JOBS = new Map();
const CAMPAIGN_RECOMMENDATION_JOB_TTL_MS = Number(
  process.env.CAMPAIGN_RECOMMENDATION_JOB_TTL_MS || 10 * 60 * 1000
);

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

  if (/official|company|brand|store|shop|inc\.|llc|private limited|pvt ltd|corporation/.test(title) || /official channel|welcome to the official/.test(desc)) return 'Brand Channel';
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
      authenticityScore: doc.scores?.authenticityScore || discovery.scores?.authenticityScore || mediaKit.performanceScores?.authenticityScore || 85,
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


function getDocLabel(doc = {}) {
  return cleanStr(
    doc.name ||
      doc.label ||
      doc.title ||
      doc.countryName ||
      doc.country ||
      doc.iso2 ||
      doc.isoCode ||
      doc.code ||
      doc.slug
  );
}

async function lookupLabelsByIds(Model, ids = []) {
  if (!Model) return [];

  const cleanIds = Array.from(new Set((ids || []).map(cleanStr).filter(Boolean)));
  if (!cleanIds.length) return [];

  try {
    const rows = await Model.find({ _id: { $in: cleanIds } }).lean();
    return rows.map(getDocLabel).filter(Boolean);
  } catch (_) {
    return [];
  }
}

function normalizeLooseArray(value) {
  if (Array.isArray(value)) return value.map(cleanStr).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map(cleanStr)
      .filter(Boolean);
  }
  return [];
}

function isGenericCampaignPhrase(value = '') {
  const v = cleanStr(value).toLowerCase();
  if (!v) return true;

  const exactGeneric = new Set([
    'campaign',
    'new campaign',
    'marketing campaign',
    'creator marketing campaign',
    'premium creator marketing campaign',
    'premium campaign',
    'product campaign',
  ]);

  if (exactGeneric.has(v)) return true;
  if (/^premium\s+creator\s+marketing\s+campaign$/i.test(v)) return true;
  if (/^the\s+product(\s+is|\s+built|$)/i.test(v)) return true;

  return false;
}

function isLowValueCampaignTerm(value = '') {
  const v = cleanStr(value).toLowerCase();
  if (!v) return true;
  if (isGenericCampaignPhrase(v)) return true;

  const lowValue = new Set([
    'audience', 'built', 'can', 'clearly', 'connect', 'creator-friendly',
    'explain', 'feel', 'lifestyle-led', 'makes', 'message', 'naturally',
    'prioritize', 'show', 'storytelling', 'authentic', 'valuable', 'value',
    'desirable', 'memorable', 'everyday', 'appeal', 'strong', 'clear',
  ]);

  return lowValue.has(v);
}

function countrySearchName(country = '') {
  const code = cleanStr(country).toUpperCase();
  const map = {
    US: 'United States',
    IN: 'India',
    GB: 'United Kingdom',
    AU: 'Australia',
    CA: 'Canada',
    AE: 'UAE',
    DE: 'Germany',
    FR: 'France',
  };
  return map[code] || cleanStr(country);
}

function extractImportantCampaignTerms(text = '', limit = 12) {
  const stop = new Set([
    'the', 'and', 'with', 'for', 'this', 'that', 'from', 'through', 'around',
    'strong', 'clear', 'value', 'campaign', 'creator', 'creators', 'content',
    'product', 'brand', 'brands', 'marketing', 'premium', 'authentic', 'natural',
    'story', 'stories', 'storytelling', 'highlight', 'highlights', 'appeal',
    'designed', 'easy', 'understand', 'everyday', 'credible', 'experience',
    'experiences', 'useful', 'desirable', 'memorable', 'showcases', 'lifestyle',
    'audience', 'built', 'can', 'clearly', 'connect', 'explain', 'feel',
    'makes', 'message', 'naturally', 'prioritize', 'youtube', 'who', 'will',
    'should', 'their', 'your', 'they', 'using', 'around', 'through', 'into',
  ]);

  const counts = new Map();
  cleanStr(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && !stop.has(x) && !/^\d+$/.test(x))
    .forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word)
    .slice(0, limit);
}

function detectSubscriberTierFromLabels(labels = []) {
  const value = labels.join(' ').toLowerCase();
  if (/mega|1m|1 million|1000000/.test(value)) return 'mega';
  if (/macro|500k|500,000/.test(value)) return 'macro';
  if (/mid|mid-tier|100k|500k/.test(value)) return 'mid-tier';
  if (/micro|10k|100k/.test(value)) return 'micro';
  if (/nano|1k|10k/.test(value)) return 'nano';
  return '';
}

function detectSubscriberTierFromBudget(budget) {
  const amount = Number(budget || 0);
  if (!amount) return '';
  if (amount <= 150) return 'nano';
  if (amount <= 500) return 'micro';
  if (amount <= 1500) return 'mid-tier';
  if (amount <= 5000) return 'macro';
  return 'mega';
}

function normalizeCountryLabel(value = '') {
  const raw = cleanStr(value);
  if (!raw) return '';

  const map = {
    usa: 'US',
    'u.s.': 'US',
    'u.s.a.': 'US',
    'united states': 'US',
    'united states of america': 'US',
    india: 'IN',
    bharat: 'IN',
    uk: 'GB',
    'united kingdom': 'GB',
    england: 'GB',
    canada: 'CA',
    australia: 'AU',
    germany: 'DE',
    france: 'FR',
    uae: 'AE',
    'united arab emirates': 'AE',
  };

  const lower = raw.toLowerCase();
  if (map[lower]) return map[lower];
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return raw;
}

async function enrichCampaignReferenceLabels(campaign = {}) {
  const [countryLabels, categoryLabels, subcategoryLabels, tierLabels, goalLabels, formatLabels] =
    await Promise.all([
      lookupLabelsByIds(CountryModel, campaign.targetCountryIds || campaign.countryIds || []),
      lookupLabelsByIds(CategoryModel, [campaign.categoryId].filter(Boolean)),
      lookupLabelsByIds(SubcategoryModel, campaign.subcategoryIds || []),
      lookupLabelsByIds(InfluencerTierModel, campaign.influencerTierIds || []),
      lookupLabelsByIds(CampaignGoalModel, campaign.campaignGoals || []),
      lookupLabelsByIds(ContentFormatModel, campaign.contentFormats || []),
    ]);

  return {
    countryLabels,
    categoryLabels,
    subcategoryLabels,
    tierLabels,
    goalLabels,
    formatLabels,
  };
}

function normalizeCampaignDetailsForRecommendation(campaign = {}, refs = {}, overrides = {}) {
  const base = normalizeCampaignDetails(campaign || {});

  const campaignTitle = cleanStr(campaign.campaignTitle || campaign.title || campaign.name || base.campaignName);
  const description = cleanStr(campaign.description || campaign.campaignDescription || campaign.brief);
  const additionalNotes = cleanStr(campaign.additionalNotes || campaign.notes || campaign.creatorNotes);
  const campaignBudget = toNum(campaign.campaignBudget ?? campaign.budget ?? campaign.totalBudget ?? overrides.campaignBudget);
  const paymentType = cleanStr(campaign.paymentType || overrides.paymentType);

  const categoryLabels = uniqueCleanValues([
    ...(refs.categoryLabels || []),
    ...(refs.subcategoryLabels || []),
    ...normalizeLooseArray(campaign.categoryNames),
    ...normalizeLooseArray(campaign.subcategoryNames),
    cleanStr(campaign.categoryName),
    cleanStr(campaign.subcategoryName),
  ]);

  const countryLabels = uniqueCleanValues([
    ...(refs.countryLabels || []),
    ...normalizeLooseArray(campaign.targetCountries),
    ...normalizeLooseArray(campaign.countries),
    cleanStr(campaign.targetCountry),
    cleanStr(campaign.country),
    cleanStr(overrides.country),
  ]);

  const tierLabels = uniqueCleanValues([
    ...(refs.tierLabels || []),
    ...normalizeLooseArray(campaign.influencerTiers),
    cleanStr(campaign.influencerTier),
    cleanStr(overrides.subscriberTier),
  ]);

  const contentFormats = uniqueCleanValues([
    ...(refs.formatLabels || []),
    ...normalizeLooseArray(campaign.contentFormatNames),
    ...normalizeLooseArray(overrides.contentFormats),
  ]);

  const campaignGoals = uniqueCleanValues([
    ...(refs.goalLabels || []),
    ...normalizeLooseArray(campaign.campaignGoalNames),
    ...normalizeLooseArray(overrides.campaignGoals),
  ]);

  const importantTerms = extractImportantCampaignTerms(`${campaignTitle} ${description} ${additionalNotes}`)
    .filter((term) => !isLowValueCampaignTerm(term));
  const targetCountry = normalizeCountryLabel(cleanStr(overrides.country) || countryLabels[0] || base.targetCountry);
  const subscriberTier = cleanStr(overrides.subscriberTier) || detectSubscriberTierFromLabels(tierLabels) || detectSubscriberTierFromBudget(campaignBudget);

  const titleIsGeneric = isGenericCampaignPhrase(campaignTitle);
  const inferredNiche = importantTerms.slice(0, 2).join(' ');

  const campaignNiche =
    cleanStr(overrides.category || overrides.niche) ||
    base.campaignNiche ||
    categoryLabels[0] ||
    inferredNiche ||
    'product review';

  const productName =
    cleanStr(overrides.keyword || overrides.productName) ||
    base.productName ||
    (!titleIsGeneric ? campaignTitle : '') ||
    campaignNiche ||
    'product review';

  const rawKeywords = uniqueCleanValues([
    ...base.keywords.filter((term) => !isLowValueCampaignTerm(term)),
    !titleIsGeneric ? campaignTitle : '',
    productName,
    campaignNiche,
    ...categoryLabels,
    ...importantTerms,
    ...contentFormats,
    ...campaignGoals,
  ]).filter((term) => !isLowValueCampaignTerm(term)).slice(0, 30);

  const tierRange = getSubscriberTierRange(subscriberTier);

  return {
    ...base,
    campaignId: cleanStr(campaign._id || campaign.id || overrides.campaignId || base.campaignId),
    brandId: cleanStr(campaign.brandId || overrides.brandId),
    campaignName: campaignTitle || base.campaignName,
    campaignTitle,
    description,
    additionalNotes,
    productName,
    campaignNiche,
    targetCountry,
    subscriberTier,
    minSubscribers: toIntOrNull(overrides.minSubscribers) ?? base.minSubscribers ?? tierRange?.min ?? null,
    maxSubscribers: toIntOrNull(overrides.maxSubscribers) ?? base.maxSubscribers ?? tierRange?.max ?? null,
    minAvgViews: toIntOrNull(overrides.minAvgViews) ?? base.minAvgViews ?? MIN_AVG_VIEWS_DEFAULT,
    campaignBudget,
    paymentType,
    productLink: cleanStr(campaign.productLink || overrides.productLink),
    contentFormats,
    campaignGoals,
    targetAgeRanges: uniqueCleanValues([
      ...normalizeLooseArray(campaign.targetAgeRanges),
      ...normalizeLooseArray(overrides.targetAgeRanges),
    ]),
    categoryLabels,
    countryLabels,
    tierLabels,
    keywords: rawKeywords,
  };
}

async function getCampaignRecommendationDetails(campaignId, campaignPayload, overrides = {}) {
  if (campaignPayload && typeof campaignPayload === 'object') {
    const refs = await enrichCampaignReferenceLabels(campaignPayload);
    return {
      rawCampaign: campaignPayload,
      campaignDetails: normalizeCampaignDetailsForRecommendation(campaignPayload, refs, {
        ...overrides,
        campaignId: campaignId || campaignPayload._id || campaignPayload.id,
      }),
    };
  }

  if (!campaignId) {
    const err = new Error('campaignId is required');
    err.status = 400;
    throw err;
  }

  if (!Campaign) {
    const err = new Error('Campaign model not found. Update the Campaign require path in youtubeData.controller.js');
    err.status = 500;
    throw err;
  }

  const rawCampaign = await Campaign.findById(campaignId).lean();
  if (!rawCampaign) {
    const err = new Error('Campaign not found');
    err.status = 404;
    throw err;
  }

  const refs = await enrichCampaignReferenceLabels(rawCampaign);
  return {
    rawCampaign,
    campaignDetails: normalizeCampaignDetailsForRecommendation(rawCampaign, refs, {
      ...overrides,
      campaignId,
    }),
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
  const country = normalizeCountryLabel(cleanStr(campaignDetails.targetCountry));
  const countryName = countrySearchName(country);

  const rawSeeds = uniqueCleanValues([
    ...(campaignDetails.keywords || []),
    campaignDetails.productName,
    campaignDetails.campaignNiche,
    ...(campaignDetails.categoryLabels || []),
    ...(campaignDetails.contentFormats || []),
    ...(campaignDetails.campaignGoals || []),
  ]).filter((seed) => !isLowValueCampaignTerm(seed));

  let baseSeeds = rawSeeds.length ? rawSeeds.slice(0, 8) : [];

  // If campaign title/description are generic (for example "Premium Creator Marketing Campaign"),
  // use broad brand-safe creator discovery terms instead of searching useless words like "audience".
  if (!baseSeeds.length || baseSeeds.every((seed) => isGenericCampaignPhrase(seed))) {
    baseSeeds = [
      'product review',
      'lifestyle product review',
      'unboxing review',
      'best products',
      'consumer product review',
      'gadget review',
      'home product review',
      'shopping guide',
    ];
  }

  const querySeeds = [];

  for (const base of baseSeeds) {
    const cleanBase = cleanStr(base);
    if (!cleanBase) continue;

    querySeeds.push(
      cleanBase,
      `${cleanBase} review`,
      `${cleanBase} reviews`,
      `${cleanBase} unboxing`,
      `${cleanBase} comparison`,
      `best ${cleanBase}`,
      `top ${cleanBase}`,
      `${cleanBase} product review`,
      `${cleanBase} sponsored`,
      `${cleanBase} creator`,
      `${cleanBase} youtube`,
      `${cleanBase} influencer`
    );

    if (country) {
      querySeeds.push(
        `${cleanBase} ${country}`,
        `${cleanBase} ${countryName}`,
        `${cleanBase} review ${countryName}`,
        `${countryName} ${cleanBase} creator`,
        `${countryName} ${cleanBase} youtuber`,
        `best ${cleanBase} ${countryName}`
      );
    }
  }

  if (country) {
    querySeeds.push(
      `${countryName} product review channel`,
      `${countryName} product reviewers`,
      `${countryName} lifestyle creator`,
      `${countryName} tech review channel`,
      `${countryName} unboxing channel`,
      `${countryName} shopping guide youtube`,
      `${countryName} consumer products review`,
      `${countryName} creators product review`
    );
  }

  // Expand niche-adjacent terms for common product categories and low-volume searches.
  const lower = baseSeeds.join(' ').toLowerCase();
  if (/pool|cleaner|vacuum|lawn|garden|home|toilet|bathroom|smart/.test(lower)) {
    querySeeds.push(
      'home improvement product review',
      'smart home product review',
      'outdoor gadget review',
      'home gadget review',
      'bathroom product review',
      'smart bathroom review',
      'home tech review'
    );
  }

  return Array.from(new Set(querySeeds.map(cleanStr).filter(Boolean))).slice(0, MAX_SEARCH_QUERIES);
}

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
  const brandingImage = channel?.brandingSettings?.image || {};
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
    bannerImage: cleanStr(brandingImage.bannerExternalUrl || brandingImage.bannerMobileImageUrl || brandingImage.bannerTabletImageUrl || ''),
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

  // Activity gate: keep creators who uploaded at least once within the configured lookback window.
  // Default is 730 days / last 2 years.
  if (!isCreatorActiveWithinLookback(doc)) return false;

  // Always allow low-volume niches to build a large discovery pool.
  // Min avg views can still be used as a hard quality gate when provided.
  if (minAvgViews != null && doc.avgViews < minAvgViews) return false;

  // Country is a hard filter when selected. Use actual YouTube channel country only.
  // Do not use estimatedAudienceCountry here; the user asked that US should show only US channels.
  if (strictCountry && targetCountry) {
    const channelCountry = cleanStr(doc.country).toUpperCase();
    if (channelCountry !== targetCountry) return false;
  }

  // Subscriber tier remains soft unless strictFilters=true.
  // It affects match flags and frontend ordering without shrinking the pool too much.
  if (!strictFilters) return true;

  if (minSubscribers != null && doc.subscribers < minSubscribers) return false;
  if (maxSubscribers != null && doc.subscribers > maxSubscribers) return false;

  return true;
}

async function refreshChannelsForCampaign(campaignDetails) {
  const searchQueries = buildCampaignSearchQueries(campaignDetails);
  if (!searchQueries.length) return 0;

  const targetSaveCount = Math.min(
    RAW_CHANNELS_PER_SEARCH,
    Math.max(
      TARGET_CHANNELS_PER_SEARCH,
      Number(campaignDetails.targetSaveCount || TARGET_CHANNELS_PER_SEARCH)
    )
  );
  const discoveryMap = new Map();

  // Build a large raw pool first. Filters like Macro can shrink results heavily,
  // so we collect more raw channels before applying subscriber/view rules.
  for (const query of searchQueries) {
    if (discoveryMap.size >= RAW_CHANNELS_PER_SEARCH) break;

    const channels = await searchVideoCreatorChannels(
      query,
      SEARCH_RESULTS_PER_QUERY,
      campaignDetails.campaignNiche,
      RAW_CHANNELS_PER_SEARCH,
      campaignDetails.targetCountry
    );

    for (const item of channels) {
      if (!discoveryMap.has(item.channelId)) {
        discoveryMap.set(item.channelId, {
          ...item,
          requestedCategory: campaignDetails.campaignNiche || item.requestedCategory || query,
        });
      }

      if (discoveryMap.size >= RAW_CHANNELS_PER_SEARCH) break;
    }
  }

  const discoveryRows = Array.from(discoveryMap.values());
  const channelIds = discoveryRows.map((x) => x.channelId);
  if (!channelIds.length) return 0;

  const channels = await fetchChannelsByIds(channelIds);
  let upserts = 0;
  let aiAnalyses = 0;

  for (const channel of channels) {
    const discoveryInfo = discoveryMap.get(channel.id);
    try {
      const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads || null;
      const videos = await fetchRecentVideos(uploadsPlaylistId, RECENT_VIDEO_SAMPLE);
      let doc = buildCreatorDoc(channel, videos, campaignDetails, discoveryInfo, searchQueries);

      if (
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
/*                                Controllers                                 */
/* -------------------------------------------------------------------------- */

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
    const limitCap = frontendPagination ? 250 : 50;
    const limit = Math.min(limitCap, Math.max(1, toIntOrNull(q.limit) || 25));
    const skip = frontendPagination ? 0 : (page - 1) * limit;
    const mongoLimit = frontendPagination
      ? Math.min(500, Math.max(limit, TARGET_CHANNELS_PER_SEARCH, limit * 5))
      : limit;

    let liveError = null;
    let refreshedCount = 0;
    const shouldRefresh = Boolean(campaignId) || Boolean(cleanStr(q.keyword || q.search)) || Boolean(requestedCategory);

    if (shouldRefresh) {
      try {
        refreshedCount = await refreshChannelsForCampaign({
          ...campaignDetails,
          campaignNiche: requestedCategory || campaignDetails.campaignNiche || keyword,
          productName: campaignDetails.productName || keyword,
          targetCountry: country,
          minSubscribers,
          maxSubscribers,
          minAvgViews,
          strictFilters,
          strictCountry,
          targetSaveCount: frontendPagination && country
            ? Math.min(RAW_CHANNELS_PER_SEARCH, Math.max(limit * 3, TARGET_CHANNELS_PER_SEARCH))
            : TARGET_CHANNELS_PER_SEARCH,
          keywords: Array.from(new Set([...(campaignDetails.keywords || []), keyword, requestedCategory].filter(Boolean))),
        });
      } catch (err) {
        liveError = err?.message || 'YouTube live fetch failed. Showing cached data.';
        await saveErrorLog(req, err, err?.status || 429, 'YOUTUBE_LIVE_FETCH');
      }
    }

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
    maskedEmail: emails[0] ? maskEmailForBrand(emails[0]) : '',
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
      bannerImage: creator.bannerImage || creator.channelBannerImage || creator.coverImage || '',
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
    contact,
    collabGlamRecommendation: {
      recommendation: getCampaignFitLabel(campaignFitScore),
      summary: `${creator.channelName} is a ${getTierFromSubscribers(creator.subscribers)} YouTube creator with ${avgViews.toLocaleString()} average views and a ${campaignFitScore}/100 match score for this search.`,
    },
  };
}



const MIN_RECOMMENDED_INFLUENCER_TARGET = 50;

function getMinimumRecommendedInfluencerTarget(limit) {
  const safeLimit = Math.max(1, Number(limit || 0) || MIN_RECOMMENDED_INFLUENCER_TARGET);
  return Math.min(MIN_RECOMMENDED_INFLUENCER_TARGET, safeLimit);
}

function hasCampaignTierRequest(campaignDetails = {}, minSubscribers = null, maxSubscribers = null) {
  return Boolean(
    cleanStr(campaignDetails.subscriberTier) ||
      minSubscribers != null ||
      maxSubscribers != null
  );
}

function getRecommendationRowSubscribers(row = {}) {
  return Number(
    row.creatorSnapshot?.subscribers ??
      row.subscribers ??
      row.followers ??
      row.doc?.subscribers ??
      0
  );
}

function isRecommendationRowTierMatch(row = {}, minSubscribers = null, maxSubscribers = null) {
  if (minSubscribers == null && maxSubscribers == null) return true;
  return isSubscriberTierMatch(getRecommendationRowSubscribers(row), minSubscribers, maxSubscribers);
}

function getRecommendationRowChannelKey(row = {}) {
  return cleanStr(row.channelId || row.doc?.channelId || row.ids?.youtubeChannelId || row._id).toLowerCase();
}

function sortRecommendationRowsForTier(rows = [], { minSubscribers = null, maxSubscribers = null, campaignDetails = {}, strictTier = false, limit = 100 } = {}) {
  const minimumTarget = getMinimumRecommendedInfluencerTarget(limit);
  const hasTierRequest = hasCampaignTierRequest(campaignDetails, minSubscribers, maxSubscribers);
  const safeRows = Array.isArray(rows) ? rows : [];

  if (!hasTierRequest) return safeRows.slice(0, limit);

  const tierRows = safeRows.filter((row) => isRecommendationRowTierMatch(row, minSubscribers, maxSubscribers));
  const extraRows = safeRows.filter((row) => !isRecommendationRowTierMatch(row, minSubscribers, maxSubscribers));

  // Tier must be respected first. Only fill outside the selected tier when we cannot reach
  // the 50-influencer target and strictTier is not explicitly enabled.
  if (strictTier || tierRows.length >= minimumTarget) return tierRows.slice(0, limit);

  return [...tierRows, ...extraRows].slice(0, Math.min(limit, minimumTarget));
}

function mergeRecommendationRows(primary = [], secondary = [], limit = 100) {
  const merged = [];
  const seen = new Set();

  for (const row of [...(primary || []), ...(secondary || [])]) {
    const key = getRecommendationRowChannelKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
    if (merged.length >= limit) break;
  }

  return merged;
}

function getRecommendationCountStatus(rows = [], limit = 100, campaignDetails = {}, minSubscribers = null, maxSubscribers = null) {
  const minimumTarget = getMinimumRecommendedInfluencerTarget(limit);
  const tierRequested = hasCampaignTierRequest(campaignDetails, minSubscribers, maxSubscribers);
  const tierMatchedCount = tierRequested
    ? rows.filter((row) => isRecommendationRowTierMatch(row, minSubscribers, maxSubscribers)).length
    : rows.length;

  return {
    minimumInfluencerTarget: minimumTarget,
    hasMinimumInfluencers: rows.length >= minimumTarget,
    selectedTierMatchedCount: tierMatchedCount,
    selectedTierRequested: tierRequested,
    selectedTierRespected: !tierRequested || tierMatchedCount >= Math.min(rows.length, minimumTarget),
  };
}

function getBudgetTierScore(subscribers, campaignDetails = {}) {
  const requestedRange = getSubscriberTierRange(campaignDetails.subscriberTier);
  if (requestedRange) {
    return isSubscriberTierMatch(subscribers, requestedRange.min, requestedRange.max) ? 100 : 55;
  }

  const budgetTier = detectSubscriberTierFromBudget(campaignDetails.campaignBudget);
  const budgetRange = getSubscriberTierRange(budgetTier);
  if (!budgetRange) return 75;

  return isSubscriberTierMatch(subscribers, budgetRange.min, budgetRange.max) ? 100 : 60;
}

function getCountryScoreForRecommendation(doc, campaignDetails = {}) {
  const target = normalizeCountryLabel(campaignDetails.targetCountry).toUpperCase();
  if (!target) return 80;

  const actual = cleanStr(doc.country).toUpperCase();
  if (actual && actual === target) return 100;

  const estimated = cleanStr(doc.estimatedAudienceCountry).toUpperCase();
  if (estimated && estimated === target) return 60;

  return 0;
}

function calculateRecommendationScore(doc, discovery, campaignDetails = {}) {
  const scores = doc.scores || discovery.scores || {};
  const relevancyScore = scoreValue(scores.relevancyScore || discovery.shortlist?.score || 70, 70);
  const engagementScore = scoreValue(scores.engagementScore || 0, 0);
  const sponsorshipScore = scoreValue(scores.sponsorshipScore || 0, 0);
  const brandSafetyScore = scoreValue(scores.brandSafetyScore || 90, 90);
  const countryScore = getCountryScoreForRecommendation(doc, campaignDetails);
  const tierScore = getBudgetTierScore(doc.subscribers, campaignDetails);

  return Math.round(
    relevancyScore * 0.35 +
      countryScore * 0.2 +
      tierScore * 0.15 +
      engagementScore * 0.15 +
      brandSafetyScore * 0.1 +
      sponsorshipScore * 0.05
  );
}

function buildRecommendationReason(doc, discovery, campaignDetails, recommendationScore) {
  const parts = [];
  const keyword = cleanStr(campaignDetails.productName || campaignDetails.campaignNiche || discovery.category);
  const country = cleanStr(campaignDetails.targetCountry);
  const tier = cleanStr(campaignDetails.subscriberTier || getTierFromSubscribers(doc.subscribers));

  if (keyword) parts.push(`Matched campaign topic: ${keyword}`);
  if (country && cleanStr(doc.country).toUpperCase() === country.toUpperCase()) {
    parts.push(`Creator country matches ${country}`);
  }
  if (tier) parts.push(`Best suited for ${tier} creator targeting`);
  if (doc.avgViews) parts.push(`${Number(doc.avgViews).toLocaleString()} average views`);
  if (doc.engagementRate) parts.push(`${doc.engagementRate}% engagement rate`);
  parts.push(`${recommendationScore}/100 recommendation score`);

  return parts.join(' | ');
}

function buildCampaignInfluencerPayload(doc, discovery, campaignDetails, recommendationScore) {
  const mediaKit = buildBrandMediaKitData(doc, {
    keyword: campaignDetails.productName,
    category: campaignDetails.campaignNiche,
    country: campaignDetails.targetCountry,
  });

  const recommendationReason = buildRecommendationReason(
    doc,
    discovery,
    campaignDetails,
    recommendationScore
  );

  return {
    platform: 'youtube',
    channelId: doc.channelId,
    channelUrl: doc.channelUrl,
    channelName: doc.channelName,
    thumbnail: doc.thumbnail,
    creatorSnapshot: {
      subscribers: doc.subscribers,
      creatorTier: getTierFromSubscribers(doc.subscribers),
      category: doc.category || doc.channelCategory,
      country: doc.country,
      estimatedAudienceCountry: doc.estimatedAudienceCountry,
      primaryLanguage: doc.primaryLanguage,
      totalViews: doc.totalViews,
      totalVideos: doc.totalVideos,
      avgViews: doc.avgViews,
      avgLikes: doc.avgLikes,
      avgComments: doc.avgComments,
      engagementRate: doc.engagementRate,
      recentUploadDate: doc.recentUploadDate,
      description: doc.description,
    },
    scores: {
      recommendationScore,
      campaignFitScore: mediaKit.performanceScores?.campaignFitScore || recommendationScore,
      relevancyScore: doc.scores?.relevancyScore || discovery.scores?.relevancyScore || 0,
      engagementScore: doc.scores?.engagementScore || 0,
      sponsorshipScore: doc.scores?.sponsorshipScore || 0,
      brandSafetyScore: doc.scores?.brandSafetyScore || 0,
      authenticityScore: doc.scores?.authenticityScore || discovery.scores?.authenticityScore || mediaKit.performanceScores?.authenticityScore || 85,
      audienceCountryConfidence: doc.scores?.audienceCountryConfidence || 0,
      nicheFit: doc.scores?.nicheFit || discovery.shortlist?.nicheFit || 0,
    },
    recommendationReason,
    contact: mediaKit.contact,
    rawYouTubeDataId: doc._id,
    campaignContext: {
      campaignId: campaignDetails.campaignId,
      brandId: campaignDetails.brandId,
      campaignTitle: campaignDetails.campaignTitle || campaignDetails.campaignName,
      campaignDescription: cleanStr(campaignDetails.description).slice(0, 500),
      campaignBudget: campaignDetails.campaignBudget || 0,
      paymentType: campaignDetails.paymentType,
      targetCountry: campaignDetails.targetCountry,
      requestedTier: campaignDetails.subscriberTier,
      contentFormats: campaignDetails.contentFormats || [],
      campaignGoals: campaignDetails.campaignGoals || [],
      targetAgeRanges: campaignDetails.targetAgeRanges || [],
      matchedKeyword: campaignDetails.productName || campaignDetails.campaignNiche,
      matchedCategory: campaignDetails.campaignNiche,
      sourceVideoTitle: doc.sourceVideoTitle || discovery.sourceVideoTitle || '',
      sourceVideoUrl: doc.sourceVideoUrl || discovery.sourceVideoUrl || '',
      foundViaQuery: doc.foundViaQuery || discovery.foundViaQuery || '',
      recommendationScore,
      recommendationReason,
      matchedAt: new Date(),
    },
  };
}

async function upsertCampaignInfluencerRecommendation(payload) {
  if (!CampaignInfluencer) {
    return { ...payload, saved: false, saveWarning: 'CampaignInfluencer model not found' };
  }

  const campaignObjectId = toObjectIdOrNull(payload.campaignContext.campaignId);
  const brandObjectId = toObjectIdOrNull(payload.campaignContext.brandId);
  const campaignContext = {
    ...payload.campaignContext,
    campaignId: campaignObjectId || payload.campaignContext.campaignId,
    brandId: brandObjectId || payload.campaignContext.brandId,
  };

  const existing = await CampaignInfluencer.findOne({ channelId: payload.channelId });

  if (!existing) {
    const doc = await CampaignInfluencer.create({
      platform: payload.platform,
      channelId: payload.channelId,
      channelUrl: payload.channelUrl,
      channelName: payload.channelName,
      thumbnail: payload.thumbnail,
      campaignIds: campaignObjectId ? [campaignObjectId] : [],
      brandIds: brandObjectId ? [brandObjectId] : [],
      creatorSnapshot: payload.creatorSnapshot,
      scores: payload.scores,
      recommendationReason: payload.recommendationReason,
      campaignContexts: [campaignContext],
      contact: payload.contact,
      rawYouTubeDataId: payload.rawYouTubeDataId,
      lastRecommendedAt: new Date(),
    });

    return { ...payload, _id: doc._id, saved: true };
  }

  existing.platform = payload.platform;
  existing.channelUrl = payload.channelUrl;
  existing.channelName = payload.channelName;
  existing.thumbnail = payload.thumbnail;
  existing.creatorSnapshot = payload.creatorSnapshot;
  existing.scores = payload.scores;
  existing.recommendationReason = payload.recommendationReason;
  existing.contact = payload.contact;
  existing.rawYouTubeDataId = payload.rawYouTubeDataId;
  existing.lastRecommendedAt = new Date();

  if (campaignObjectId && !existing.campaignIds.some((id) => String(id) === String(campaignObjectId))) {
    existing.campaignIds.push(campaignObjectId);
  }

  if (brandObjectId && !existing.brandIds.some((id) => String(id) === String(brandObjectId))) {
    existing.brandIds.push(brandObjectId);
  }

  existing.campaignContexts = (existing.campaignContexts || []).filter(
    (ctx) => String(ctx.campaignId) !== String(campaignObjectId || payload.campaignContext.campaignId)
  );
  existing.campaignContexts.push(campaignContext);

  await existing.save();

  return { ...payload, _id: existing._id, saved: true };
}

function getRecommendationAudienceAuthenticityScore(saved = {}) {
  const rawScore = Number(
    saved.audienceAuthenticity ||
      saved.audienceAuthenticityScore ||
      saved.authenticityScore ||
      saved.scores?.audienceAuthenticity ||
      saved.scores?.audienceAuthenticityScore ||
      saved.scores?.authenticityScore ||
      saved.creatorSnapshot?.audienceAuthenticity ||
      0
  );

  if (Number.isFinite(rawScore) && rawScore > 0) {
    return Math.max(0, Math.min(100, Math.round(rawScore)));
  }

  // Fallback for older saved CampaignInfluencer rows that were created before
  // audience authenticity was added to the public response.
  const subscribers = Number(saved.creatorSnapshot?.subscribers || 0);
  const avgViews = Number(saved.creatorSnapshot?.avgViews || 0);
  const engagementRate = Number(saved.creatorSnapshot?.engagementRate || 0);
  const recentUploadDate = saved.creatorSnapshot?.recentUploadDate;
  const hasCountry = Boolean(cleanStr(saved.creatorSnapshot?.country || saved.creatorSnapshot?.estimatedAudienceCountry));

  let score = 78;

  if (engagementRate >= 5) score += 8;
  else if (engagementRate >= 2) score += 5;
  else if (engagementRate > 0 && engagementRate < 0.5) score -= 12;

  const viewSubscriberRatio = subscribers > 0 ? (avgViews / subscribers) * 100 : 0;
  if (viewSubscriberRatio >= 10) score += 7;
  else if (viewSubscriberRatio >= 3) score += 4;
  else if (viewSubscriberRatio > 0 && viewSubscriberRatio < 0.3) score -= 8;

  if (recentUploadDate) {
    const daysSinceUpload = daysBetween(recentUploadDate, new Date());
    if (daysSinceUpload <= 180) score += 6;
    else score -= 6;
  }

  if (hasCountry) score += 4;
  else score -= 5;

  return Math.max(35, Math.min(95, Math.round(score)));
}

function campaignRecommendationDTO(saved) {
  const audienceAuthenticity = getRecommendationAudienceAuthenticityScore(saved);

  return {
    _id: saved._id,
    saved: saved.saved,
    platform: 'youtube',
    source: 'youtube_api',
    channelId: saved.channelId,
    channelName: saved.channelName,
    name: saved.channelName,
    handle: '',
    channelUrl: saved.channelUrl,
    thumbnail: saved.thumbnail,
    picture: saved.thumbnail,
    subscribers: saved.creatorSnapshot?.subscribers || 0,
    followers: saved.creatorSnapshot?.subscribers || 0,
    creatorTier: saved.creatorSnapshot?.creatorTier || getTierFromSubscribers(saved.creatorSnapshot?.subscribers),
    tier: {
      key: saved.creatorSnapshot?.creatorTier || getTierFromSubscribers(saved.creatorSnapshot?.subscribers),
      label: saved.creatorSnapshot?.creatorTier || getTierFromSubscribers(saved.creatorSnapshot?.subscribers),
    },
    category: saved.creatorSnapshot?.category || '',
    country: saved.creatorSnapshot?.country || '',
    estimatedAudienceCountry: saved.creatorSnapshot?.estimatedAudienceCountry || '',
    primaryLanguage: saved.creatorSnapshot?.primaryLanguage || '',
    avgViews: saved.creatorSnapshot?.avgViews || 0,
    engagementRate: saved.creatorSnapshot?.engagementRate || 0,
    recentUploadDate: saved.creatorSnapshot?.recentUploadDate || null,
    audienceAuthenticity,
    authenticityScore: audienceAuthenticity,
    stats: {
      averageViews: saved.creatorSnapshot?.avgViews || 0,
      engagementRate: saved.creatorSnapshot?.engagementRate || 0,
      authenticityScore: audienceAuthenticity,
    },
    scores: {
      recommendationScore: saved.scores?.recommendationScore || 0,
      campaignFitScore: saved.scores?.campaignFitScore || saved.scores?.recommendationScore || 0,
      authenticityScore: audienceAuthenticity,
      audienceAuthenticityScore: audienceAuthenticity,
      engagementScore: saved.scores?.engagementScore || 0,
      brandSafetyScore: saved.scores?.brandSafetyScore || 0,
      relevancyScore: saved.scores?.relevancyScore || 0,
    },
    aiScore: saved.scores?.recommendationScore || 0,
    rawAiScore: saved.scores?.recommendationScore || 0,
    recommendationScore: saved.scores?.recommendationScore || 0,
    ids: {
      youtubeChannelId: saved.channelId,
      modashId: saved.channelId,
    },
  };
}


function buildRecommendationChannelNamePayload(rowsOrDtos = [], minimum = 50) {
  const items = [];
  const seen = new Set();

  for (const row of Array.isArray(rowsOrDtos) ? rowsOrDtos : []) {
    const channelName = cleanStr(row.channelName || row.name || row.creatorSnapshot?.channelName);
    if (!channelName) continue;

    const key = channelName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      channelName,
      tier: cleanStr(row.creatorTier || row.tier?.label || row.creatorSnapshot?.creatorTier),
      country: cleanStr(row.country || row.creatorSnapshot?.country),
      subscribers: Number(row.subscribers || row.followers || row.creatorSnapshot?.subscribers || 0),
      recommendationScore: Number(row.recommendationScore || row.aiScore || row.scores?.recommendationScore || 0),
    });

    if (items.length >= minimum) break;
  }

  return {
    channelNames: items.map((item) => item.channelName),
    channelNameItems: items,
    channelNameCount: items.length,
    minimumChannelNameTarget: minimum,
    hasMinimumChannelNames: items.length >= minimum,
  };
}


function campaignRecommendationJobKey({ campaignId, brandId, keyword, category, country, subscriberTier }) {
  return [
    cleanStr(campaignId),
    cleanStr(brandId),
    cleanStr(keyword).toLowerCase(),
    cleanStr(category).toLowerCase(),
    cleanStr(country).toUpperCase(),
    cleanStr(subscriberTier).toLowerCase(),
  ].join('|');
}

async function getSavedCampaignRecommendationRows(campaignId, brandId, limit = 100) {
  if (!CampaignInfluencer) return [];

  const campaignObjectId = toObjectIdOrNull(campaignId);
  const brandObjectId = toObjectIdOrNull(brandId);

  const or = [];
  if (campaignObjectId) or.push({ campaignIds: campaignObjectId });
  if (campaignId) or.push({ 'campaignContexts.campaignId': campaignObjectId || campaignId });

  if (!or.length) return [];

  const filter = {
    platform: 'youtube',
    $or: or,
  };

  if (brandObjectId) {
    filter.$and = [{ $or: [{ brandIds: brandObjectId }, { 'campaignContexts.brandId': brandObjectId }] }];
  }

  const rows = await CampaignInfluencer.find(filter)
    .sort({ 'scores.recommendationScore': -1, lastRecommendedAt: -1, updatedAt: -1 })
    .limit(Math.min(500, Math.max(1, limit)))
    .lean();

  return rows.map((row) => ({ ...row, saved: true }));
}

async function buildCampaignRecommendationRowsFromCache({
  keyword,
  category,
  country,
  minSubscribers,
  maxSubscribers,
  campaignDetails,
  includeExcluded,
  strictTier,
  limit,
  shouldSave,
}) {
  const activeSinceDate = getCreatorLookbackStartDate();
  const minimumTarget = getMinimumRecommendedInfluencerTarget(limit);
  const hasTierRequest = hasCampaignTierRequest(campaignDetails, minSubscribers, maxSubscribers);

  // Always load a wider soft-tier pool first so the API can return at least 50 creators.
  // The selected tier is still respected by ranking tier matches first, and by returning
  // only selected-tier rows when at least 50 are available.
  const filter = buildMongoFilter({
    keyword,
    country,
    minSubscribers: strictTier ? minSubscribers : null,
    maxSubscribers: strictTier ? maxSubscribers : null,
    minAvgViews: campaignDetails.minAvgViews,
    minEngagement: null,
    category,
    campaignId: '',
    includeExcluded,
    strictFilters: strictTier,
    activeSinceDate,
  });

  const context = {
    keyword,
    category,
    country,
    minSubscribers,
    maxSubscribers,
    subscriberTier: campaignDetails.subscriberTier,
    strictFilters: strictTier,
  };

  const docs = await YouTubeData.find(filter)
    .sort(SORT_MAP.relevance)
    .limit(Math.min(1000, Math.max(limit * 10, TARGET_CHANNELS_PER_SEARCH, minimumTarget * 8)))
    .lean();

  const ranked = docs
    .map((doc) => {
      const discovery = creatorListDTO(doc, context);
      const recommendationScore = calculateRecommendationScore(doc, discovery, campaignDetails);
      return {
        doc,
        discovery,
        recommendationScore,
        tierMatch: isSubscriberTierMatch(doc.subscribers, minSubscribers, maxSubscribers) ? 1 : 0,
        countryMatch: isCountryMatchForFilter(doc, country) ? 1 : 0,
      };
    })
    .filter((row) => !country || row.countryMatch)
    .sort((a, b) => {
      if (a.countryMatch !== b.countryMatch) return b.countryMatch - a.countryMatch;
      if (hasTierRequest && a.tierMatch !== b.tierMatch) return b.tierMatch - a.tierMatch;
      if (a.recommendationScore !== b.recommendationScore) return b.recommendationScore - a.recommendationScore;
      return Number(b.doc.subscribers || 0) - Number(a.doc.subscribers || 0);
    });

  let selectedRanked = ranked;

  if (hasTierRequest) {
    const tierRanked = ranked.filter((row) => row.tierMatch);
    const extraRanked = ranked.filter((row) => !row.tierMatch);

    if (strictTier || tierRanked.length >= minimumTarget) {
      selectedRanked = tierRanked;
    } else {
      // Selected tier was too small. Fill only enough extra creators to reach the
      // minimum target, not the full 100, so tier remains the priority.
      selectedRanked = [...tierRanked, ...extraRanked].slice(0, minimumTarget);
    }
  }

  selectedRanked = selectedRanked.slice(0, limit);

  const rows = [];
  for (const row of selectedRanked) {
    const payload = buildCampaignInfluencerPayload(
      row.doc,
      row.discovery,
      campaignDetails,
      row.recommendationScore
    );

    if (shouldSave) {
      rows.push(await upsertCampaignInfluencerRecommendation(payload));
    } else {
      rows.push({ ...payload, saved: false });
    }
  }

  return rows;
}

async function runCampaignRecommendationBackgroundJob(args) {
  const {
    jobKey,
    campaignDetails,
    keyword,
    category,
    country,
    minSubscribers,
    maxSubscribers,
    includeExcluded,
    strictTier,
    limit,
    shouldSave,
  } = args;

  try {
    await refreshChannelsForCampaign({
      ...campaignDetails,
      productName: campaignDetails.productName || keyword,
      campaignNiche: category || keyword,
      targetCountry: country,
      minSubscribers,
      maxSubscribers,
      minAvgViews: campaignDetails.minAvgViews,
      strictFilters: strictTier,
      strictCountry: Boolean(country),
      targetSaveCount: Math.min(RAW_CHANNELS_PER_SEARCH, Math.max(limit * 5, TARGET_CHANNELS_PER_SEARCH)),
      keywords: uniqueCleanValues([
        ...(campaignDetails.keywords || []),
        keyword,
        category,
        campaignDetails.campaignTitle,
        campaignDetails.description,
      ]).slice(0, 30),
    });

    await buildCampaignRecommendationRowsFromCache({
      keyword,
      category,
      country,
      minSubscribers,
      maxSubscribers,
      campaignDetails,
      includeExcluded,
      strictTier,
      limit,
      shouldSave,
    });
  } catch (err) {
    // Background job must never break the API response path.
    // It will be visible in server logs and can be retried from the frontend.
    console.error('[YouTube campaign recommendation background job failed]', err?.message || err);
  } finally {
    CAMPAIGN_RECOMMENDATION_JOBS.delete(jobKey);
  }
}

function getCampaignRecommendationJobStatus(jobKey) {
  if (!jobKey) return null;
  const job = CAMPAIGN_RECOMMENDATION_JOBS.get(jobKey);
  if (!job) return null;

  const ageMs = Date.now() - Number(job.startedAt || 0);
  if (ageMs > CAMPAIGN_RECOMMENDATION_JOB_TTL_MS) {
    CAMPAIGN_RECOMMENDATION_JOBS.delete(jobKey);
    return null;
  }

  return {
    status: 'running',
    startedAt: job.startedAt,
    ageMs,
  };
}

function startCampaignRecommendationBackgroundJob(args) {
  const jobKey = args.jobKey;
  if (!jobKey) {
    return { started: false, alreadyRunning: false, status: null };
  }

  const force = Boolean(args.forceBackground);
  const existing = CAMPAIGN_RECOMMENDATION_JOBS.get(jobKey);
  if (existing) {
    const ageMs = Date.now() - Number(existing.startedAt || 0);

    if (!force && ageMs <= CAMPAIGN_RECOMMENDATION_JOB_TTL_MS) {
      return {
        started: false,
        alreadyRunning: true,
        status: { status: 'running', startedAt: existing.startedAt, ageMs },
      };
    }

    CAMPAIGN_RECOMMENDATION_JOBS.delete(jobKey);
  }

  CAMPAIGN_RECOMMENDATION_JOBS.set(jobKey, { startedAt: Date.now() });
  setImmediate(() => {
    runCampaignRecommendationBackgroundJob(args).catch((err) => {
      CAMPAIGN_RECOMMENDATION_JOBS.delete(jobKey);
      console.error('[YouTube campaign recommendation background job crashed]', err?.message || err);
    });
  });

  return { started: true, alreadyRunning: false, status: getCampaignRecommendationJobStatus(jobKey) };
}

async function recommendCreatorsForCampaign(req, res) {
  try {
    const q = { ...req.query, ...req.body };
    const campaignId = cleanStr(req.params.campaignId || q.campaignId || q.campaign?._id || q.campaign?.id);
    const brandId = cleanStr(q.brandId || q.campaign?.brandId);
    const limit = Math.min(250, Math.max(1, toIntOrNull(q.limit) || 100));
    const includeExcluded = String(q.includeExcluded || '').toLowerCase() === 'true';
    const strictCountry = String(q.strictCountry ?? 'true').toLowerCase() !== 'false';
    const strictTier = String(q.strictTier || q.strictFilters || '').toLowerCase() === 'true';
    const shouldSave = String(q.save ?? 'true').toLowerCase() !== 'false';

    // Fast/non-blocking mode avoids frontend 40s axios timeout.
    // It returns saved/cached recommendations immediately and refreshes YouTube in the background.
    const fastMode = ['true', '1', 'yes'].includes(
      String(q.fast || q.background || q.nonBlocking || q.async || '').toLowerCase()
    );
    const allowBackground = String(q.background ?? 'true').toLowerCase() !== 'false';
    const forceBackground = ['true', '1', 'yes'].includes(
      String(q.forceBackground || q.restartBackground || q.force || '').toLowerCase()
    );
    const refreshLive = !fastMode && String(q.refresh ?? 'true').toLowerCase() !== 'false';

    const { rawCampaign, campaignDetails } = await getCampaignRecommendationDetails(
      campaignId,
      q.campaign,
      {
        ...q,
        campaignId,
        brandId,
      }
    );

    if (brandId && !campaignDetails.brandId) campaignDetails.brandId = brandId;

    const country = normalizeCountryLabel(cleanStr(q.country) || campaignDetails.targetCountry);
    const tierRange = getSubscriberTierRange(campaignDetails.subscriberTier || q.subscriberTier);
    const minSubscribers = tierRange?.min ?? campaignDetails.minSubscribers ?? null;
    const maxSubscribers = tierRange?.max ?? campaignDetails.maxSubscribers ?? null;
    let keyword = cleanStr(q.keyword || q.search) || campaignDetails.productName || campaignDetails.campaignNiche;
    let category = cleanStr(q.category || q.niche) || campaignDetails.campaignNiche;

    if (isLowValueCampaignTerm(keyword)) keyword = category || 'product review';
    if (isLowValueCampaignTerm(category)) category = keyword || 'product review';

    const normalizedCampaignDetails = {
      ...campaignDetails,
      campaignId,
      brandId: campaignDetails.brandId || brandId,
      productName: campaignDetails.productName || keyword,
      campaignNiche: category || keyword,
      targetCountry: strictCountry ? country : country,
      minSubscribers,
      maxSubscribers,
      subscriberTier: campaignDetails.subscriberTier || q.subscriberTier,
      keywords: uniqueCleanValues([
        ...(campaignDetails.keywords || []),
        keyword,
        category,
        campaignDetails.campaignTitle,
        campaignDetails.description,
      ]).slice(0, 30),
    };

    const jobKey = campaignRecommendationJobKey({
      campaignId,
      brandId: normalizedCampaignDetails.brandId,
      keyword,
      category,
      country,
      subscriberTier: normalizedCampaignDetails.subscriberTier,
    });
    const minimumTarget = getMinimumRecommendedInfluencerTarget(limit);

    let refreshedCount = 0;
    let liveError = null;
    let backgroundStarted = false;
    let backgroundAlreadyRunning = false;
    let backgroundJobStatus = null;

    if (fastMode) {
      let rows = [];

      // 1) Prefer already saved recommendations for this campaign.
      const savedRows = await getSavedCampaignRecommendationRows(
        campaignId,
        normalizedCampaignDetails.brandId,
        Math.max(limit * 3, minimumTarget * 3)
      );

      if (savedRows.length) {
        rows = sortRecommendationRowsForTier(savedRows, {
          minSubscribers,
          maxSubscribers,
          campaignDetails: normalizedCampaignDetails,
          strictTier,
          limit,
        });
      }

      // 2) If no campaign-specific saved rows exist, or saved rows are below the
      // 50-influencer target, build from cached YouTubeData only.
      if (rows.length < minimumTarget) {
        const cacheRows = await buildCampaignRecommendationRowsFromCache({
          keyword,
          category,
          country,
          minSubscribers,
          maxSubscribers,
          campaignDetails: normalizedCampaignDetails,
          includeExcluded,
          strictTier,
          limit,
          shouldSave,
        });

        rows = sortRecommendationRowsForTier(
          mergeRecommendationRows(rows, cacheRows, limit),
          {
            minSubscribers,
            maxSubscribers,
            campaignDetails: normalizedCampaignDetails,
            strictTier,
            limit,
          }
        );
      }

      if (allowBackground && rows.length < minimumTarget) {
        const bg = startCampaignRecommendationBackgroundJob({
          jobKey,
          campaignDetails: normalizedCampaignDetails,
          keyword,
          category,
          country,
          minSubscribers,
          maxSubscribers,
          includeExcluded,
          strictTier,
          limit,
          shouldSave,
          forceBackground,
        });
        backgroundStarted = bg.started;
        backgroundAlreadyRunning = bg.alreadyRunning;
        backgroundJobStatus = bg.status;
      }

      const dtoRows = rows.map(campaignRecommendationDTO);
      const channelNamePayload = buildRecommendationChannelNamePayload(dtoRows, minimumTarget);
      const recommendationCountStatus = getRecommendationCountStatus(rows, limit, normalizedCampaignDetails, minSubscribers, maxSubscribers);
      const statusCode = rows.length >= minimumTarget || !allowBackground ? 200 : 202;
      return res.status(statusCode).json({
        success: true,
        source: 'youtube_api',
        mode: 'fast',
        processing: backgroundStarted || backgroundAlreadyRunning || rows.length < minimumTarget,
        backgroundStarted,
        backgroundAlreadyRunning,
        backgroundJobStatus,
        campaignId,
        brandId: normalizedCampaignDetails.brandId,
        refreshedCount: 0,
        savedCount: rows.filter((row) => row.saved).length,
        returnedCount: rows.length,
        recommendationBasis: {
          campaignTitle: normalizedCampaignDetails.campaignTitle,
          descriptionUsed: Boolean(normalizedCampaignDetails.description),
          budget: normalizedCampaignDetails.campaignBudget || 0,
          paymentType: normalizedCampaignDetails.paymentType || '',
          targetCountry: country,
          subscriberTier: normalizedCampaignDetails.subscriberTier || '',
          strictCountry,
          strictTier,
          minimumInfluencerTarget: minimumTarget,
          keywords: normalizedCampaignDetails.keywords || [],
        },
        ...channelNamePayload,
        ...recommendationCountStatus,
        data: dtoRows,
        rawCampaign: {
          _id: rawCampaign?._id || campaignId,
          campaignTitle: normalizedCampaignDetails.campaignTitle,
          brandId: normalizedCampaignDetails.brandId,
        },
      });
    }

    if (refreshLive) {
      try {
        refreshedCount = await refreshChannelsForCampaign({
          ...normalizedCampaignDetails,
          targetCountry: country,
          minSubscribers,
          maxSubscribers,
          minAvgViews: campaignDetails.minAvgViews,
          strictFilters: strictTier,
          strictCountry: Boolean(country) && strictCountry,
          targetSaveCount: Math.min(RAW_CHANNELS_PER_SEARCH, Math.max(limit * 3, TARGET_CHANNELS_PER_SEARCH)),
        });
      } catch (err) {
        liveError = err?.message || 'YouTube live fetch failed. Showing cached recommendations.';
        await saveErrorLog(req, err, err?.status || 429, 'YOUTUBE_CAMPAIGN_RECOMMEND_REFRESH');
      }
    }

    const savedRows = await buildCampaignRecommendationRowsFromCache({
      keyword,
      category,
      country,
      minSubscribers,
      maxSubscribers,
      campaignDetails: normalizedCampaignDetails,
      includeExcluded,
      strictTier,
      limit,
      shouldSave,
    });

    const dtoRows = savedRows.map(campaignRecommendationDTO);
    const channelNamePayload = buildRecommendationChannelNamePayload(dtoRows, minimumTarget);
    const recommendationCountStatus = getRecommendationCountStatus(savedRows, limit, normalizedCampaignDetails, minSubscribers, maxSubscribers);

    return res.status(200).json({
      success: true,
      source: 'youtube_api',
      mode: refreshLive ? 'live' : 'cached',
      processing: false,
      campaignId,
      brandId: normalizedCampaignDetails.brandId,
      refreshedCount,
      savedCount: savedRows.filter((row) => row.saved).length,
      returnedCount: savedRows.length,
      recommendationBasis: {
        campaignTitle: normalizedCampaignDetails.campaignTitle,
        descriptionUsed: Boolean(normalizedCampaignDetails.description),
        budget: normalizedCampaignDetails.campaignBudget || 0,
        paymentType: normalizedCampaignDetails.paymentType || '',
        targetCountry: country,
        subscriberTier: normalizedCampaignDetails.subscriberTier || '',
        strictCountry,
        strictTier,
        minimumInfluencerTarget: minimumTarget,
        keywords: normalizedCampaignDetails.keywords || [],
      },
      ...channelNamePayload,
      ...recommendationCountStatus,
      data: dtoRows,
      rawCampaign: {
        _id: rawCampaign?._id || campaignId,
        campaignTitle: normalizedCampaignDetails.campaignTitle,
        brandId: normalizedCampaignDetails.brandId,
      },
      ...(liveError ? { warning: liveError } : {}),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || 500, 'YOUTUBE_CAMPAIGN_RECOMMENDATIONS');
    return res.status(err?.status || 500).json({
      success: false,
      error: err?.message || 'Failed to recommend YouTube creators for campaign',
    });
  }
}

async function getCreatorMediaKit(req, res) {
  try {
    const channelId = cleanStr(req.params.channelId);
    const creator = await YouTubeData.findOne({ channelId }).lean();
    if (!creator) return res.status(404).json({ success: false, error: 'YouTube creator not found' });

    const context = {
      keyword: cleanStr(req.query.keyword || req.query.search),
      category: cleanStr(req.query.category || req.query.niche),
      country: cleanStr(req.query.country),
    };

    const mediaKit = buildBrandMediaKitData(creator, context);

    return res.status(200).json({
      success: true,
      data: mediaKit,
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
      'lh3.googleusercontent.com',
      'lh4.googleusercontent.com',
      'lh5.googleusercontent.com',
      'lh6.googleusercontent.com',
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
  recommendCreatorsForCampaign,
  getCreatorMediaKit,
  proxyImage,
};