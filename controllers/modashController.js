'use strict';

require('dotenv').config();
const { fetch } = require('undici');
const mongoose = require('mongoose');
const {
  canShowSensitiveFromRequest,
  sanitizeModashReportForViewer,
  sanitizeModashDocForViewer,
} = require('../utils/emailRedactor');
const ModashProfile = require('../models/modash');
const Creator = require('../models/creator'); // kept for future compatibility
const Influencer = require('../models/influencer'); // kept for future compatibility
const BrandProfileView = require('../models/brandProfileView');
const { ensureBrandQuota } = require('../utils/quota');
const Campaign = require('../models/campaign');
const saveErrorLog = require('../services/errorLog.service');
const {
  getYouTubeRecommendationsForCampaign,
} = require('./youtubeController');

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

const MODASH_API_KEY = process.env.MODASH_API_KEY;
const MODASH_BASE_URL =
  process.env.MODASH_BASE_URL ||
  process.env.BASE_URL ||
  'https://api.modash.io/v1';
const MODASH_AUTH_HEADER = cleanStr(process.env.MODASH_AUTH_HEADER || 'authorization').toLowerCase();

if (!MODASH_API_KEY) {
  throw new Error('MODASH_API_KEY is missing. Add it to your environment.');
}

const ALLOWED_PLATFORMS = new Set(['instagram', 'youtube', 'tiktok']);
const DEFAULT_YT_SORT = { field: 'followers', direction: 'desc' };
const YT_ALLOWED_AGE = new Set([18, 25, 35, 45, 65]);
const MAX_LIST_LIMIT = 100;
const MAX_RANDOM_LIMIT = 50;
const MAX_EXPORT_LIMIT = 100000;

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function cleanStr(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function firstNonEmpty() {
  for (const v of arguments) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t) return t;
    }
  }
  return undefined;
}

function deepClone(x) {
  if (!x || typeof x !== 'object') return x;
  return JSON.parse(JSON.stringify(x));
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    const clean = cleanStr(value);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }

  return out;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactCI(value) {
  return new RegExp(`^${escapeRegex(cleanStr(value))}$`, 'i');
}

function containsCI(value) {
  return new RegExp(escapeRegex(cleanStr(value)), 'i');
}

function parseMultiValue(input) {
  if (input === undefined || input === null) return [];
  const raw = Array.isArray(input) ? input : String(input).split(',');
  return uniqStrings(
    raw
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => cleanStr(entry))
      .filter(Boolean)
  );
}

function parseFlexibleNumber(v) {
  if (v === undefined || v === null || v === '') return null;

  const s = String(v).trim().toLowerCase().replace(/,/g, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?k$/.test(s)) return Number(s.replace('k', '')) * 1000;
  if (/^\d+(\.\d+)?m$/.test(s)) return Number(s.replace('m', '')) * 1000000;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parsePagination(pageInput, limitInput, opts = {}) {
  const page = Math.max(0, parseInt(String(pageInput ?? opts.page ?? 0), 10) || 0);
  const rawLimit = parseInt(String(limitInput ?? opts.limit ?? 20), 10);
  const maxLimit = opts.maxLimit || MAX_LIST_LIMIT;
  const limit = Math.min(maxLimit, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
  return { page, limit };
}

function buildLocationLabel(city, state, country) {
  return uniqStrings([city, state, country]).join(', ');
}

function extractYouTubeHandleFromUrl(u) {
  if (!u) return undefined;
  const m = u.match(/youtube\.com\/@([A-Za-z0-9._-]+)/i);
  return m ? m[1] : undefined;
}

function pickPrimarySrc(item) {
  return (item && (item.profile || item.channel || item.creator || item.user)) || item;
}

function pickPicture(src) {
  return firstNonEmpty(
    src && src.picture,
    src && src.avatar,
    src && src.profilePicUrl,
    src && src.thumbnail,
    src && src.channelThumbnailUrl,
    src && src.profilePicture,
    src && src.image,
    src && src.photo
  );
}

function extractCountry(src) {
  return firstNonEmpty(
    src && src.country,
    src && src.location && src.location.country,
    src && src.audience && src.audience.country,
    src && src.audience && src.audience.topCountry,
    src && src.geo && src.geo.country
  );
}

function extractState(src) {
  return firstNonEmpty(
    src && src.state,
    src && src.region,
    src && src.location && src.location.state,
    src && src.location && src.location.region
  );
}

function extractCity(src) {
  return firstNonEmpty(src && src.city, src && src.location && src.location.city);
}

function extractBio(src) {
  return firstNonEmpty(
    src && src.bio,
    src && src.description,
    src && src.about,
    src && src.summary,
    src && src.introduction,
    src && src.profile && src.profile.bio,
    src && src.profile && src.profile.description
  );
}

function extractLanguage(src) {
  const raw = (src && src.language) || (src && src.audience && src.audience.language) || null;
  if (!raw) return undefined;
  if (typeof raw === 'string') return cleanStr(raw);
  if (typeof raw === 'object') return firstNonEmpty(raw.name, raw.code, raw.label);
  return undefined;
}

function normalizeCategoryObjects(input) {
  const list = asArray(input);
  const out = [];

  for (const entry of list) {
    if (!entry) continue;

    if (typeof entry === 'string') {
      const name = cleanStr(entry);
      if (!name) continue;
      out.push({
        categoryId: null,
        categoryName: name,
        subcategoryId: null,
        subcategoryName: null,
      });
      continue;
    }

    const categoryName = firstNonEmpty(
      entry.categoryName,
      entry.name,
      entry.title,
      entry.label,
      entry.vertical,
      entry.topic
    );

    const subcategoryName = firstNonEmpty(
      entry.subcategoryName,
      entry.subName,
      entry.subcategory,
      entry.childName
    );

    if (!categoryName && !subcategoryName) continue;

    out.push({
      categoryId: entry.categoryId || null,
      categoryName: categoryName || null,
      subcategoryId: entry.subcategoryId || null,
      subcategoryName: subcategoryName || null,
    });
  }

  return out;
}

function extractCategories(src) {
  const raw = []
    .concat(asArray(src && src.categories))
    .concat(asArray(src && src.categoryLinks))
    .concat(asArray(src && src.category))
    .concat(asArray(src && src.interests))
    .concat(asArray(src && src.niches))
    .concat(asArray(src && src.topics))
    .concat(asArray(src && src.tags))
    .concat(asArray(src && src.profile && src.profile.categories))
    .concat(asArray(src && src.profile && src.profile.categoryLinks));

  const normalized = normalizeCategoryObjects(raw);
  const deduped = [];
  const seen = new Set();

  for (const item of normalized) {
    const key = `${cleanStr(item.categoryName).toLowerCase()}|${cleanStr(item.subcategoryName).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function categoryNamesFromObjects(categories) {
  const out = [];

  for (const item of asArray(categories)) {
    if (!item) continue;

    if (typeof item === 'string') {
      const value = cleanStr(item);
      if (value) out.push(value);
      continue;
    }

    const categoryName = cleanStr(item.categoryName || item.name || '');
    const subcategoryName = cleanStr(item.subcategoryName || item.subName || item.subcategory || '');

    if (categoryName) out.push(categoryName);
    if (subcategoryName) out.push(subcategoryName);
  }

  return uniqStrings(out);
}

function buildPublicProfileUrl(platform, username, rawUrl, userId) {
  const cleanUsername = cleanStr(username).replace(/^@/, '');
  const cleanUrl = cleanStr(rawUrl);
  const cleanUserId = cleanStr(userId);

  if (platform === 'youtube') {
    if (cleanUsername) return `https://www.youtube.com/@${cleanUsername}`;
    if (cleanUrl) return cleanUrl;
    if (cleanUserId) return `https://www.youtube.com/channel/${cleanUserId}`;
    return undefined;
  }

  if (platform === 'instagram') {
    if (cleanUrl) return cleanUrl;
    if (cleanUsername) return `https://www.instagram.com/${cleanUsername}`;
    return undefined;
  }

  if (platform === 'tiktok') {
    if (cleanUrl) return cleanUrl;
    if (cleanUsername) return `https://www.tiktok.com/@${cleanUsername}`;
    return undefined;
  }

  return cleanUrl || undefined;
}

function mergeSearchItem(base, extra) {
  const next = { ...base };

  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (!Array.isArray(next[key]) || !next[key].length) {
        next[key] = value;
      }
      continue;
    }

    if (next[key] === undefined || next[key] === null || next[key] === '') {
      next[key] = value;
    }
  }

  if ((!next.location || !cleanStr(next.location)) && (next.city || next.state || next.country)) {
    next.location = buildLocationLabel(next.city, next.state, next.country);
  }

  if ((!next.category || !cleanStr(next.category)) && Array.isArray(next.categories) && next.categories.length) {
    next.category = next.categories[0];
  }

  if ((!next.primaryCategory || !cleanStr(next.primaryCategory)) && Array.isArray(next.categories) && next.categories.length) {
    next.primaryCategory = next.categories[0];
  }

  return next;
}

function mapDocToListFields(doc) {
  const categories = categoryNamesFromObjects(doc && doc.categories);

  return {
    bio: cleanStr(doc && doc.bio) || undefined,
    country: cleanStr(doc && doc.country) || undefined,
    state: cleanStr(doc && doc.state) || undefined,
    city: cleanStr(doc && doc.city) || undefined,
    location:
      buildLocationLabel(
        cleanStr(doc && doc.city),
        cleanStr(doc && doc.state),
        cleanStr(doc && doc.country)
      ) || undefined,
    language: extractLanguage(doc),
    categories,
    category: categories[0] || undefined,
    primaryCategory: categories[0] || undefined,
    picture: cleanStr(doc && doc.picture) || undefined,
    url: cleanStr(doc && doc.url) || undefined,
    fullname: cleanStr(doc && doc.fullname) || undefined,
    handle: cleanStr(doc && doc.handle) || undefined,
    username: cleanStr(doc && doc.username) || undefined,
    isVerified: typeof doc?.isVerified === 'boolean' ? doc.isVerified : undefined,
    isPrivate: typeof doc?.isPrivate === 'boolean' ? doc.isPrivate : undefined,
  };
}

function normalizePlatform(platform) {
  const p = cleanStr(platform).toLowerCase();
  return ALLOWED_PLATFORMS.has(p) ? p : '';
}

function normalizePlatforms(inputSingle, inputMulti) {
  const single = normalizePlatform(inputSingle);
  if (single) return [single];

  const multi = parseMultiValue(inputMulti)
    .map((x) => normalizePlatform(x))
    .filter(Boolean);

  return uniqStrings(multi);
}

function buildSafeErrorMessage(err, fallback) {
  const raw = (err && err.message) || '';
  const isSensitive =
    /api token|developer section|modash|authorization|bearer|modash_api_key|marketer\.modash\.io/i.test(
      String(raw)
    );
  return isSensitive ? fallback : raw || fallback;
}


function isAuthError(err) {
  const status = Number(err && err.status);
  return status == 401 || status == 403;
}

/* -------------------------------------------------------------------------- */
/*                             Country aliases                                */
/* -------------------------------------------------------------------------- */

const COUNTRY_ALIASES = {
  US: ['US', 'USA', 'United States', 'United States of America'],
  IN: ['IN', 'India'],
  GB: ['GB', 'UK', 'United Kingdom', 'Great Britain'],
  CA: ['CA', 'Canada'],
  AU: ['AU', 'Australia'],
  NZ: ['NZ', 'New Zealand'],
  IE: ['IE', 'Ireland'],
  DE: ['DE', 'Germany'],
  FR: ['FR', 'France'],
  IT: ['IT', 'Italy'],
  ES: ['ES', 'Spain'],
  NL: ['NL', 'Netherlands'],
  BE: ['BE', 'Belgium'],
  CH: ['CH', 'Switzerland'],
  AT: ['AT', 'Austria'],
  SE: ['SE', 'Sweden'],
  NO: ['NO', 'Norway'],
  DK: ['DK', 'Denmark'],
  FI: ['FI', 'Finland'],
  PL: ['PL', 'Poland'],
  CZ: ['CZ', 'Czechia', 'Czech Republic'],
  PT: ['PT', 'Portugal'],
  RO: ['RO', 'Romania'],
  GR: ['GR', 'Greece'],
  TR: ['TR', 'Turkey'],
  UA: ['UA', 'Ukraine'],
  RU: ['RU', 'Russia'],
  BR: ['BR', 'Brazil'],
  AR: ['AR', 'Argentina'],
  CL: ['CL', 'Chile'],
  CO: ['CO', 'Colombia'],
  MX: ['MX', 'Mexico'],
  PE: ['PE', 'Peru'],
  ZA: ['ZA', 'South Africa'],
  NG: ['NG', 'Nigeria'],
  EG: ['EG', 'Egypt'],
  KE: ['KE', 'Kenya'],
  SA: ['SA', 'Saudi Arabia'],
  AE: ['AE', 'United Arab Emirates', 'UAE'],
  IL: ['IL', 'Israel'],
  SG: ['SG', 'Singapore'],
  MY: ['MY', 'Malaysia'],
  ID: ['ID', 'Indonesia'],
  PH: ['PH', 'Philippines'],
  TH: ['TH', 'Thailand'],
  VN: ['VN', 'Vietnam'],
  JP: ['JP', 'Japan'],
  KR: ['KR', 'South Korea'],
  HK: ['HK', 'Hong Kong'],
  TW: ['TW', 'Taiwan'],
  CN: ['CN', 'China'],
  PK: ['PK', 'Pakistan'],
  BD: ['BD', 'Bangladesh'],
  LK: ['LK', 'Sri Lanka'],
  NP: ['NP', 'Nepal'],
};

const COUNTRY_ALIAS_LOOKUP = (() => {
  const out = Object.create(null);
  for (const aliases of Object.values(COUNTRY_ALIASES)) {
    for (const alias of aliases) {
      out[cleanStr(alias).toLowerCase()] = aliases;
    }
  }
  return out;
})();

function normalizeCountryTokens(values = []) {
  const out = [];
  const seen = new Set();

  for (const raw of values) {
    const clean = cleanStr(raw);
    if (!clean) continue;

    const aliases = COUNTRY_ALIAS_LOOKUP[clean.toLowerCase()] || [clean];
    for (const alias of aliases) {
      const normalized = cleanStr(alias);
      const key = normalized.toLowerCase();
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*                             Auth / Modash HTTP                             */
/* -------------------------------------------------------------------------- */

function headerVariant(kind, rawKey) {
  const key = cleanStr(rawKey);
  const bearerToken = key.replace(/^bearer\s+/i, '');
  const h = { 'content-type': 'application/json' };

  if (kind === 'authorization') {
    h.authorization = `Bearer ${bearerToken}`;
  } else if (kind === 'accesstoken') {
    h.accesstoken = bearerToken;
  } else {
    h['x-api-key'] = key;
  }

  return h;
}

function primaryHeaderKind() {
  if (MODASH_AUTH_HEADER === 'authorization') return 'authorization';
  if (MODASH_AUTH_HEADER === 'accesstoken' || MODASH_AUTH_HEADER === 'accessToken') {
    return 'accesstoken';
  }
  if (/^bearer\s+/i.test(MODASH_API_KEY)) return 'authorization';
  return 'x-api-key';
}

function fallbackKinds(primary) {
  const all = ['x-api-key', 'authorization', 'accesstoken'];
  return [primary, ...all.filter((k) => k !== primary)];
}

function toQuery(params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function modashRequest({ method, path, query, body }) {
  const url = `${MODASH_BASE_URL}${path}${toQuery(query)}`;
  const kinds = fallbackKinds(primaryHeaderKind());

  let lastErr;
  for (const kind of kinds) {
    try {
      const res = await fetch(url, {
        method,
        headers: headerVariant(kind, MODASH_API_KEY),
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!res.ok) {
        const err = new Error(
          (json && (json.message || json.error)) || `Modash ${res.status} ${res.statusText}`
        );
        err.status = res.status;
        err.response = json || undefined;

        if (res.status === 401 || res.status === 403) {
          lastErr = err;
          continue;
        }
        throw err;
      }

      return json;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('Unknown Modash error');
}

async function modashGET(path, query) {
  return modashRequest({ method: 'GET', path, query });
}

async function modashPOST(path, body) {
  return modashRequest({ method: 'POST', path, body });
}

/* -------------------------------------------------------------------------- */
/*                         Search item normalization                          */
/* -------------------------------------------------------------------------- */

function normalizeSearchItem(item, platform) {
  const src = pickPrimarySrc(item);

  const rawUrl = firstNonEmpty(src && src.url, src && src.channelUrl, src && src.profileUrl);
  const derivedHandleFromUrl = extractYouTubeHandleFromUrl(rawUrl);

  const rawUsername = firstNonEmpty(
    src && src.username,
    src && src.handle,
    src && src.channelHandle,
    src && src.slug,
    src && src.customUrl,
    src && src.vanityUrl,
    derivedHandleFromUrl
  );

  const username = rawUsername ? rawUsername.replace(/^@/, '') : undefined;
  const userId =
    cleanStr(
      (item && item.userId) ||
      (src && src.userId) ||
      (src && src.id) ||
      (src && src.channelId) ||
      (src && src.profileId)
    ) || undefined;

  const categories = categoryNamesFromObjects(extractCategories(src));
  const country = extractCountry(src);
  const state = extractState(src);
  const city = extractCity(src);

  return {
    userId,
    username,
    handle: username || undefined,
    fullname:
      (src &&
        (src.fullName || src.fullname || src.display_name || src.title || src.name)) ||
      '',
    followers:
      toNum(src && (src.followers || src.followerCount || (src.stats && src.stats.followers))) || 0,
    engagementRate:
      toNum(src && (src.engagementRate || (src.stats && src.stats.engagementRate))) || 0,
    engagements: toNum(
      src && (src.engagements || (src.stats && (src.stats.avgEngagements || src.stats.avgLikes)))
    ),
    averageViews: toNum(
      src && (src.averageViews || (src.stats && src.stats.avgViews) || src.avgViews)
    ),
    picture: pickPicture(src) || undefined,
    url: buildPublicProfileUrl(platform, username, rawUrl, userId),
    isVerified: Boolean(src && (src.isVerified || src.verified)),
    isPrivate: Boolean(src && src.isPrivate),
    platform,

    bio: extractBio(src) || undefined,
    country: country || undefined,
    state: state || undefined,
    city: city || undefined,
    location: buildLocationLabel(city, state, country) || undefined,
    language: extractLanguage(src) || undefined,
    categories,
    category: categories[0] || undefined,
    primaryCategory: categories[0] || undefined,
  };
}

function betterSearchResult(a, b) {
  if (a.isVerified !== b.isVerified) return a.isVerified ? a : b;
  if (!!a.username !== !!b.username) return a.username ? a : b;
  if (!!a.picture !== !!b.picture) return a.picture ? a : b;
  if (!!a.bio !== !!b.bio) return a.bio ? a : b;
  if (!!a.country !== !!b.country) return a.country ? a : b;
  if ((a.categories?.length || 0) !== (b.categories?.length || 0)) {
    return (a.categories?.length || 0) > (b.categories?.length || 0) ? a : b;
  }
  if ((a.followers || 0) !== (b.followers || 0)) return (a.followers || 0) > (b.followers || 0) ? a : b;
  if ((a.engagementRate || 0) !== (b.engagementRate || 0)) {
    return (a.engagementRate || 0) > (b.engagementRate || 0) ? a : b;
  }
  if ((a.engagements || 0) !== (b.engagements || 0)) return (a.engagements || 0) > (b.engagements || 0) ? a : b;
  if (!!a.url !== !!b.url) return a.url ? a : b;
  return a;
}

function dedupeSearchItems(items) {
  const map = new Map();
  for (const it of items) {
    const keyBase =
      (it.userId && String(it.userId).toLowerCase()) ||
      (it.username && String(it.username).toLowerCase()) ||
      (it.url && String(it.url).toLowerCase());

    if (!keyBase) continue;

    const key = `${it.platform}:${keyBase}`;
    const prev = map.get(key);
    map.set(key, prev ? betterSearchResult(prev, it) : it);
  }
  return Array.from(map.values());
}

function scoreForQuery(u, qLower) {
  const uname = String(u.username || u.handle || '').toLowerCase();
  const full = String(u.fullname || '').toLowerCase();
  const url = String(u.url || '').toLowerCase();

  if (uname === qLower) return 100;
  if (url.indexOf(`/@${qLower}`) !== -1) return 95;
  if (full === qLower) return 90;
  if (uname.startsWith(qLower)) return 70;
  if (full.startsWith(qLower)) return 60;
  if (uname.indexOf(qLower) !== -1) return 45;
  if (full.indexOf(qLower) !== -1) return 35;
  return 10;
}

function dedupeByBest(items) {
  const map = new Map();
  for (const it of items) {
    const uname = String(it.username || it.handle || '').toLowerCase();
    const key = `${it.platform}:${uname}`;
    const prev = map.get(key);
    if (!prev || it.__score > prev.__score) {
      map.set(key, it);
    }
  }
  return Array.from(map.values());
}

async function enrichResultsFromCache(items) {
  if (!Array.isArray(items) || !items.length) return items;

  const providers = uniqStrings(items.map((x) => x.platform));
  const userIds = uniqStrings(items.map((x) => x.userId));
  const usernames = uniqStrings(items.map((x) => x.username));

  const or = [];
  if (userIds.length) or.push({ userId: { $in: userIds } });
  if (usernames.length) or.push({ username: { $in: usernames } });
  if (!or.length) return items;

  const docs = await ModashProfile.find({ provider: { $in: providers }, $or: or })
    .select({
      provider: 1,
      userId: 1,
      username: 1,
      fullname: 1,
      handle: 1,
      url: 1,
      picture: 1,
      bio: 1,
      country: 1,
      state: 1,
      city: 1,
      language: 1,
      categories: 1,
      isVerified: 1,
      isPrivate: 1,
    })
    .lean();

  const byId = new Map();
  const byUsername = new Map();

  for (const doc of docs) {
    const keyById = `${cleanStr(doc.provider).toLowerCase()}:${cleanStr(doc.userId).toLowerCase()}`;
    const keyByUsername = `${cleanStr(doc.provider).toLowerCase()}:${cleanStr(doc.username).toLowerCase()}`;

    if (cleanStr(doc.userId)) byId.set(keyById, doc);
    if (cleanStr(doc.username)) byUsername.set(keyByUsername, doc);
  }

  return items.map((item) => {
    const keyById = `${cleanStr(item.platform).toLowerCase()}:${cleanStr(item.userId).toLowerCase()}`;
    const keyByUsername = `${cleanStr(item.platform).toLowerCase()}:${cleanStr(item.username).toLowerCase()}`;

    const doc = byId.get(keyById) || byUsername.get(keyByUsername);
    if (!doc) return item;
    return mergeSearchItem(item, mapDocToListFields(doc));
  });
}

/* -------------------------------------------------------------------------- */
/*                              Report helpers                                */
/* -------------------------------------------------------------------------- */

function pickArray() {
  for (const value of arguments) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  for (const value of arguments) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeReportData(reportJSON) {
  const rootProfile = (reportJSON && reportJSON.profile) || {};
  const nestedProfile = rootProfile.profile || {};
  const prof =
    nestedProfile && Object.keys(nestedProfile).length ? nestedProfile : rootProfile;

  const rawUserId =
    prof.userId ||
    rootProfile.userId ||
    prof.id ||
    rootProfile.id ||
    prof.channelId ||
    rootProfile.channelId ||
    prof.profileId ||
    rootProfile.profileId ||
    prof.secUid ||
    rootProfile.secUid ||
    null;

  const profileUserId = rawUserId ? cleanStr(rawUserId) : null;

  const rootCategories = extractCategories(rootProfile);
  const nestedCategories = extractCategories(prof);
  const categories = rootCategories.length ? rootCategories : nestedCategories;

  const cleanUsername = cleanStr(prof.username || prof.handle).replace(/^@/, '') || null;
  const cleanHandle =
    cleanStr(prof.handle) ||
    (cleanUsername ? `@${cleanUsername}` : null);

  return {
    profile: {
      userId: profileUserId,
      username: cleanUsername,
      fullname: prof.fullname || prof.fullName || prof.title || rootProfile.fullname || null,
      handle: cleanHandle,
      url: prof.url || rootProfile.url || null,
      picture: pickPicture(prof) || pickPicture(rootProfile) || null,
      followers: toNum(prof.followers ?? rootProfile.followers),
      engagements: toNum(prof.engagements ?? rootProfile.engagements),
      engagementRate: toNum(prof.engagementRate ?? rootProfile.engagementRate),
      averageViews: toNum(
        prof.averageViews ??
        prof.avgViews ??
        rootProfile.averageViews ??
        rootProfile.avgViews
      ),
    },

    isPrivate:
      typeof rootProfile.isPrivate === 'boolean'
        ? rootProfile.isPrivate
        : typeof prof.isPrivate === 'boolean'
          ? prof.isPrivate
          : null,

    isVerified:
      typeof rootProfile.isVerified === 'boolean'
        ? rootProfile.isVerified
        : typeof prof.isVerified === 'boolean'
          ? prof.isVerified
          : null,

    accountType: rootProfile.accountType || prof.accountType || null,
    secUid: rootProfile.secUid || prof.secUid || null,

    city: extractCity(rootProfile) || extractCity(prof) || null,
    state: extractState(rootProfile) || extractState(prof) || null,
    subdivision:
      firstNonEmpty(rootProfile.subdivision, prof.subdivision) || null,
    country: extractCountry(rootProfile) || extractCountry(prof) || null,
    ageGroup: rootProfile.ageGroup || prof.ageGroup || null,
    gender: rootProfile.gender || prof.gender || null,
    language: rootProfile.language ?? prof.language ?? null,

    contacts: pickArray(rootProfile.contacts, prof.contacts),

    statsByContentType:
      rootProfile.statsByContentType || prof.statsByContentType || null,
    stats: rootProfile.stats || prof.stats || null,

    recentPosts: pickArray(rootProfile.recentPosts, prof.recentPosts),
    popularPosts: pickArray(rootProfile.popularPosts, prof.popularPosts),

    postsCount: toNum(
      rootProfile.postsCount ??
      prof.postsCount ??
      rootProfile.postsCounts ??
      prof.postsCounts
    ),
    postsCounts: toNum(
      rootProfile.postsCounts ??
      prof.postsCounts ??
      rootProfile.postsCount ??
      prof.postsCount
    ),

    avgLikes: toNum(rootProfile.avgLikes ?? prof.avgLikes),
    avgComments: toNum(rootProfile.avgComments ?? prof.avgComments),
    avgViews: toNum(rootProfile.avgViews ?? prof.avgViews),
    avgReelsPlays: toNum(rootProfile.avgReelsPlays ?? prof.avgReelsPlays),
    totalLikes: toNum(rootProfile.totalLikes ?? prof.totalLikes),
    totalViews: toNum(rootProfile.totalViews ?? prof.totalViews),

    bio: extractBio(rootProfile) || extractBio(prof) || '',

    categories,
    hashtags: pickArray(rootProfile.hashtags, prof.hashtags),
    mentions: pickArray(rootProfile.mentions, prof.mentions),
    brandAffinity: pickArray(rootProfile.brandAffinity, prof.brandAffinity),
    interests: pickArray(rootProfile.interests, prof.interests),

    audience: rootProfile.audience || prof.audience || null,
    audienceCommenters:
      rootProfile.audienceCommenters ||
      rootProfile.audienceLikers ||
      prof.audienceCommenters ||
      prof.audienceLikers ||
      null,

    lookalikes: pickArray(
      rootProfile.lookalikes,
      rootProfile.audienceLookalikes,
      prof.lookalikes,
      prof.audienceLookalikes
    ),

    sponsoredPosts: pickArray(rootProfile.sponsoredPosts, prof.sponsoredPosts),
    paidPostPerformance: toNum(
      rootProfile.paidPostPerformance ?? prof.paidPostPerformance
    ),
    paidPostPerformanceViews: toNum(
      rootProfile.paidPostPerformanceViews ?? prof.paidPostPerformanceViews
    ),
    sponsoredPostsMedianViews: toNum(
      rootProfile.sponsoredPostsMedianViews ?? prof.sponsoredPostsMedianViews
    ),
    sponsoredPostsMedianLikes: toNum(
      rootProfile.sponsoredPostsMedianLikes ?? prof.sponsoredPostsMedianLikes
    ),
    nonSponsoredPostsMedianViews: toNum(
      rootProfile.nonSponsoredPostsMedianViews ??
      prof.nonSponsoredPostsMedianViews
    ),
    nonSponsoredPostsMedianLikes: toNum(
      rootProfile.nonSponsoredPostsMedianLikes ??
      prof.nonSponsoredPostsMedianLikes
    ),

    statHistory: pickArray(rootProfile.statHistory, prof.statHistory),
    audienceExtra: rootProfile.audienceExtra || prof.audienceExtra || null,

    providerRaw: reportJSON,
  };
}

function trimProviderRaw(providerRaw) {
  if (!providerRaw || typeof providerRaw !== 'object') return providerRaw;

  const clone = deepClone(providerRaw);
  if (clone && clone.profile) {
    const base = clone.profile.profile || clone.profile;
    const limitPosts = (arr, max = 50) => (Array.isArray(arr) ? arr.slice(0, max) : arr);
    base.recentPosts = limitPosts(base.recentPosts);
    base.popularPosts = limitPosts(base.popularPosts);
  }

  return clone;
}

function mapReportToModashDoc(normalized, platform, opts = {}) {
  const prof = normalized.profile || {};
  const rawRoot = (normalized.providerRaw && normalized.providerRaw.profile) || {};
  const rawNested = rawRoot.profile || {};
  const { influencerId, userId } = opts;

  const canonicalUserId =
    userId ||
    cleanStr(prof.userId) ||
    cleanStr(rawRoot.userId) ||
    cleanStr(rawNested.userId) ||
    null;

  const doc = {
    provider: platform,
    userId: canonicalUserId,

    username:
      prof.username ||
      cleanStr(rawNested.username || rawRoot.username).replace(/^@/, '') ||
      null,

    fullname:
      prof.fullname ||
      rawNested.fullname ||
      rawNested.fullName ||
      rawRoot.fullname ||
      rawRoot.fullName ||
      null,

    handle:
      prof.handle ||
      rawNested.handle ||
      rawRoot.handle ||
      (prof.username ? `@${cleanStr(prof.username).replace(/^@/, '')}` : null),

    url: prof.url || rawNested.url || rawRoot.url || null,
    picture: prof.picture || pickPicture(rawNested) || pickPicture(rawRoot) || null,

    followers: prof.followers ?? toNum(rawNested.followers ?? rawRoot.followers),
    engagements: prof.engagements ?? toNum(rawNested.engagements ?? rawRoot.engagements),
    engagementRate:
      prof.engagementRate ?? toNum(rawNested.engagementRate ?? rawRoot.engagementRate),
    averageViews:
      prof.averageViews ??
      toNum(
        rawNested.averageViews ??
        rawNested.avgViews ??
        rawRoot.averageViews ??
        rawRoot.avgViews
      ),

    isPrivate:
      normalized.isPrivate ??
      rawRoot.isPrivate ??
      rawNested.isPrivate ??
      null,

    isVerified:
      normalized.isVerified ??
      rawRoot.isVerified ??
      rawNested.isVerified ??
      null,

    accountType: normalized.accountType ?? rawRoot.accountType ?? rawNested.accountType,
    secUid: normalized.secUid ?? rawRoot.secUid ?? rawNested.secUid,

    city: normalized.city ?? extractCity(rawRoot) ?? extractCity(rawNested),
    state: normalized.state ?? extractState(rawRoot) ?? extractState(rawNested),
    subdivision:
      normalized.subdivision ??
      firstNonEmpty(rawRoot.subdivision, rawNested.subdivision) ??
      null,
    country:
      normalized.country ?? extractCountry(rawRoot) ?? extractCountry(rawNested),
    ageGroup: normalized.ageGroup ?? rawRoot.ageGroup ?? rawNested.ageGroup,
    gender: normalized.gender ?? rawRoot.gender ?? rawNested.gender,
    language: normalized.language ?? rawRoot.language ?? rawNested.language,

    contacts: pickArray(normalized.contacts, rawRoot.contacts, rawNested.contacts),

    statsByContentType:
      normalized.statsByContentType ??
      rawRoot.statsByContentType ??
      rawNested.statsByContentType,

    stats: normalized.stats ?? rawRoot.stats ?? rawNested.stats,

    recentPosts: pickArray(
      normalized.recentPosts,
      rawRoot.recentPosts,
      rawNested.recentPosts
    ),
    popularPosts: pickArray(
      normalized.popularPosts,
      rawRoot.popularPosts,
      rawNested.popularPosts
    ),

    postsCount:
      normalized.postsCount ??
      toNum(
        rawRoot.postsCount ??
        rawNested.postsCount ??
        rawRoot.postsCounts ??
        rawNested.postsCounts
      ),

    postsCounts:
      normalized.postsCounts ??
      toNum(
        rawRoot.postsCounts ??
        rawNested.postsCounts ??
        rawRoot.postsCount ??
        rawNested.postsCount
      ),

    avgLikes:
      normalized.avgLikes ?? toNum(rawRoot.avgLikes ?? rawNested.avgLikes),
    avgComments:
      normalized.avgComments ??
      toNum(rawRoot.avgComments ?? rawNested.avgComments),
    avgViews:
      normalized.avgViews ?? toNum(rawRoot.avgViews ?? rawNested.avgViews),
    avgReelsPlays:
      normalized.avgReelsPlays ??
      toNum(rawRoot.avgReelsPlays ?? rawNested.avgReelsPlays),
    totalLikes:
      normalized.totalLikes ?? toNum(rawRoot.totalLikes ?? rawNested.totalLikes),
    totalViews:
      normalized.totalViews ?? toNum(rawRoot.totalViews ?? rawNested.totalViews),

    bio: normalized.bio || extractBio(rawRoot) || extractBio(rawNested) || '',

    categories:
      Array.isArray(normalized.categories) && normalized.categories.length
        ? normalized.categories
        : extractCategories(rawRoot).length
          ? extractCategories(rawRoot)
          : extractCategories(rawNested),

    hashtags: pickArray(normalized.hashtags, rawRoot.hashtags, rawNested.hashtags),
    mentions: pickArray(normalized.mentions, rawRoot.mentions, rawNested.mentions),
    brandAffinity: pickArray(
      normalized.brandAffinity,
      rawRoot.brandAffinity,
      rawNested.brandAffinity
    ),
    interests: pickArray(
      normalized.interests,
      rawRoot.interests,
      rawNested.interests
    ),

    audience: normalized.audience ?? rawRoot.audience ?? rawNested.audience,
    audienceCommenters:
      normalized.audienceCommenters ??
      rawRoot.audienceCommenters ??
      rawRoot.audienceLikers ??
      rawNested.audienceCommenters ??
      rawNested.audienceLikers ??
      null,

    lookalikes: pickArray(
      normalized.lookalikes,
      rawRoot.lookalikes,
      rawRoot.audienceLookalikes,
      rawNested.lookalikes,
      rawNested.audienceLookalikes
    ),

    sponsoredPosts: pickArray(
      normalized.sponsoredPosts,
      rawRoot.sponsoredPosts,
      rawNested.sponsoredPosts
    ),

    paidPostPerformance:
      normalized.paidPostPerformance ??
      toNum(rawRoot.paidPostPerformance ?? rawNested.paidPostPerformance),

    paidPostPerformanceViews:
      normalized.paidPostPerformanceViews ??
      toNum(
        rawRoot.paidPostPerformanceViews ??
        rawNested.paidPostPerformanceViews
      ),

    sponsoredPostsMedianViews:
      normalized.sponsoredPostsMedianViews ??
      toNum(
        rawRoot.sponsoredPostsMedianViews ??
        rawNested.sponsoredPostsMedianViews
      ),

    sponsoredPostsMedianLikes:
      normalized.sponsoredPostsMedianLikes ??
      toNum(
        rawRoot.sponsoredPostsMedianLikes ??
        rawNested.sponsoredPostsMedianLikes
      ),

    nonSponsoredPostsMedianViews:
      normalized.nonSponsoredPostsMedianViews ??
      toNum(
        rawRoot.nonSponsoredPostsMedianViews ??
        rawNested.nonSponsoredPostsMedianViews
      ),

    nonSponsoredPostsMedianLikes:
      normalized.nonSponsoredPostsMedianLikes ??
      toNum(
        rawRoot.nonSponsoredPostsMedianLikes ??
        rawNested.nonSponsoredPostsMedianLikes
      ),

    statHistory: pickArray(
      normalized.statHistory,
      rawRoot.statHistory,
      rawNested.statHistory
    ),

    audienceExtra:
      normalized.audienceExtra ??
      rawRoot.audienceExtra ??
      rawNested.audienceExtra,

    providerRaw: trimProviderRaw(normalized.providerRaw),
  };

  if (influencerId) doc.influencerId = influencerId;
  return doc;
}

async function upsertModashProfileFromReport(normalized, platform, opts = {}) {
  const prof = normalized.profile || {};
  const rawRoot = (normalized.providerRaw && normalized.providerRaw.profile) || {};
  const rawNested = rawRoot.profile || {};
  const influencerId = opts.influencerId || null;
  const userIdFromRequest = cleanStr(opts.userIdFromRequest || '');

  const rawCanonicalId =
    cleanStr(prof.userId) ||
    cleanStr(rawRoot.userId) ||
    cleanStr(rawNested.userId) ||
    userIdFromRequest ||
    cleanStr(normalized.secUid) ||
    cleanStr(rawRoot.secUid) ||
    cleanStr(rawNested.secUid) ||
    cleanStr(prof.username) ||
    cleanStr(rawNested.username) ||
    cleanStr(rawRoot.username) ||
    null;

  if (!rawCanonicalId) {
    console.warn('[upsertModashProfile] No usable userId; skipping save', {
      platform,
      profUserId: prof.userId || rawRoot.userId || rawNested.userId,
      userIdFromRequest,
      username: prof.username || rawNested.username || rawRoot.username,
    });
    return null;
  }

  const canonicalUserId = rawCanonicalId;
  normalized.profile = normalized.profile || {};
  normalized.profile.userId = canonicalUserId;

  const doc = mapReportToModashDoc(normalized, platform, {
    influencerId,
    userId: canonicalUserId,
  });

  const filter = { provider: platform, userId: canonicalUserId };
  const update = { $set: doc };
  const options = { upsert: true, new: true, setDefaultsOnInsert: true };

  try {
    const saved = await ModashProfile.findOneAndUpdate(filter, update, options);
    console.log(
      `[upsertModashProfile] Upserted ${platform} profile for userId: ${canonicalUserId}`
    );
    return saved;
  } catch (err) {
    if (err && err.code === 11000) {
      console.error(
        '[upsertModashProfile] Duplicate key on { userId, provider }. Check conflicting legacy unique indexes.',
        err.keyPattern,
        err.keyValue
      );
    } else {
      console.error('[upsertModashProfile] Error saving to database:', err);
    }
    throw err;
  }
}
async function upsertModashProfileFromReport2(normalized, platform, opts = {}) {
  const prof = normalized.profile || {};
  const rawRoot = (normalized.providerRaw && normalized.providerRaw.profile) || {};
  const rawNested = rawRoot.profile || {};
  const influencerId = opts.influencerId || null;
  const userIdFromRequest = cleanStr(opts.userIdFromRequest || '');
  const requestedHandle = cleanStr(opts.handle || prof.handle || prof.username || '');

  const rawCanonicalId =
    cleanStr(prof.userId) ||
    cleanStr(rawRoot.userId) ||
    cleanStr(rawNested.userId) ||
    userIdFromRequest ||
    cleanStr(normalized.secUid) ||
    cleanStr(rawRoot.secUid) ||
    cleanStr(rawNested.secUid) ||
    cleanStr(prof.username) ||
    cleanStr(rawNested.username) ||
    cleanStr(rawRoot.username) ||
    null;

  if (!rawCanonicalId) {
    console.warn('[upsertModashProfile] No usable userId; skipping save', {
      platform,
      profUserId: prof.userId || rawRoot.userId || rawNested.userId,
      userIdFromRequest,
      username: prof.username || rawNested.username || rawRoot.username,
    });
    return null;
  }

  const canonicalUserId = rawCanonicalId;
  normalized.profile = normalized.profile || {};
  normalized.profile.userId = canonicalUserId;

  if (requestedHandle) {
    normalized.profile.handle = requestedHandle;
    normalized.profile.username = normalized.profile.username || requestedHandle;
  }

  const doc = mapReportToModashDoc(normalized, platform, {
    influencerId,
    userId: canonicalUserId,
  });

  const finalHandle =
    cleanStr(doc.handle) ||
    cleanStr(requestedHandle) ||
    cleanStr(prof.handle) ||
    cleanStr(prof.username) ||
    cleanStr(rawNested.username) ||
    cleanStr(rawRoot.username) ||
    null;

  if (finalHandle) {
    doc.handle = finalHandle;
  }

  // BLOCK if another record already has same provider + handle
  if (finalHandle) {
    const duplicateProfile = await ModashProfile.findOne({
      provider: platform,
      $or: [{ handle: finalHandle }, { username: finalHandle }, { 'profile.username': finalHandle }],
      userId: { $ne: canonicalUserId },
    }).select('_id provider userId handle username');

    if (duplicateProfile) {
      const err = new Error(
        `Profile already exists. We cannot update an existing profile with the same handle and provider.`
      );
      err.status = 409;
      err.details = {
        provider: platform,
        handle: finalHandle,
        existingUserId: duplicateProfile.userId || null,
      };
      throw err;
    }
  }

  const filter = { provider: platform, userId: canonicalUserId };
  const update = { $set: doc };
  const options = { upsert: true, new: true, setDefaultsOnInsert: true };

  try {
    const saved = await ModashProfile.findOneAndUpdate(filter, update, options);
    console.log(
      `[upsertModashProfile] Upserted ${platform} profile for userId: ${canonicalUserId}`
    );
    return saved;
  } catch (err) {
    if (err && err.code === 11000) {
      console.error(
        '[upsertModashProfile] Duplicate key on { userId, provider }. Check conflicting legacy unique indexes.',
        err.keyPattern,
        err.keyValue
      );

      const duplicateErr = new Error(
        'Profile already exists. We cannot update an existing profile with the same handle and provider.'
      );
      duplicateErr.status = 409;
      duplicateErr.details = {
        provider: platform,
        handle: finalHandle,
        userId: canonicalUserId,
      };
      throw duplicateErr;
    } else {
      console.error('[upsertModashProfile] Error saving to database:', err);
    }
    throw err;
  }
}
async function findCachedReport({ platform, userId, influencerId }) {
  let doc = null;

  if (influencerId && mongoose.Types.ObjectId.isValid(influencerId)) {
    doc = await ModashProfile.findOne({
      _id: new mongoose.Types.ObjectId(influencerId),
      provider: platform,
    }).lean();
  }

  if (!doc && userId) {
    doc = await ModashProfile.findOne({ provider: platform, userId }).lean();
  }

  if (!doc || !doc.providerRaw) return null;

  return {
    _id: doc._id,
    providerRaw: doc.providerRaw,
    lastFetchedAt: doc.lastFetchedAt || doc.updatedAt || doc.createdAt || null,
  };
}

function toCalcMethod(input) {
  if (!input) return 'median';
  return String(input).toLowerCase() === 'average' ? 'average' : 'median';
}

/* -------------------------------------------------------------------------- */
/*                           Quota / view helpers                             */
/* -------------------------------------------------------------------------- */

async function recordBrandProfileView({ brandId, platform, userId, influencerId, periodKey, at }) {
  if (!brandId || !platform || !userId || !periodKey) return;

  const now = at || new Date();
  const filter = { brandId, platform, userId, periodKey };

  const setOnInsert = {
    brandId,
    platform,
    userId,
    periodKey,
    firstViewedAt: now,
  };

  const update = {
    $setOnInsert: setOnInsert,
    $set: { lastViewedAt: now },
  };

  if (influencerId) update.$set.influencerId = influencerId;

  try {
    await BrandProfileView.findOneAndUpdate(filter, update, { upsert: true, new: true });
  } catch (err) {
    console.error('[recordBrandProfileView] Failed to record profile view:', err);
  }
}

async function ensureSearchQuota(brandId) {
  await ensureBrandQuota(brandId, 'influencer_search_per_month', 1);
}

async function ensureProfileQuota(brandId) {
  await ensureBrandQuota(brandId, 'influencer_profile_views_per_month', 1);
}

async function chargeProfileViewAfterSuccess({
  shouldChargeProfileView,
  alreadyViewedThisPeriod,
  brandId,
  platform,
  userId,
  influencerId,
  periodKey,
  at,
}) {
  if (!shouldChargeProfileView) return;

  if (!alreadyViewedThisPeriod) {
    try {
      await ensureProfileQuota(brandId);
    } catch (e) {
      if (e.code === 'QUOTA_EXCEEDED') {
        e.status = 403;
      }
      throw e;
    }
  }

  await recordBrandProfileView({
    brandId,
    platform,
    userId,
    influencerId,
    periodKey,
    at,
  });
}

/* -------------------------------------------------------------------------- */
/*                           Search body helpers                              */
/* -------------------------------------------------------------------------- */

function sanitizeYouTubeBody(original, opts) {
  const b = deepClone(original || {});
  b.page = b.page != null ? b.page : 0;

  if (!b.sort || !b.sort.field) {
    b.sort = Object.assign({}, b.sort || {}, DEFAULT_YT_SORT);
  }

  if (!b.filter) b.filter = {};
  if (!b.filter.influencer) b.filter.influencer = {};
  if (!b.filter.audience) b.filter.audience = {};

  const infl = b.filter.influencer;
  const aud = b.filter.audience;

  if (typeof infl.lastposted === 'number' && infl.lastposted < 30) {
    infl.lastposted = 30;
  }

  if (infl.age) {
    const min = infl.age.min;
    const max = infl.age.max;
    if ((min && !YT_ALLOWED_AGE.has(min)) || (max && !YT_ALLOWED_AGE.has(max))) {
      delete infl.age;
    }
  }

  if (aud.age && aud.ageRange) delete aud.ageRange;
  if (Array.isArray(infl.filterOperations)) delete infl.filterOperations;

  if (opts && opts.relax) {
    delete b.filter.audience;
    delete infl.followersGrowthRate;
    delete infl.views;
    delete infl.engagements;
    if (typeof infl.lastposted === 'number') delete infl.lastposted;
    b.sort = { field: 'followers', direction: 'desc' };
  }

  return b;
}

function buildPlatformBody(platform, body, opts) {
  if (platform !== 'youtube') {
    const copy = deepClone(body || {});
    copy.page = copy.page != null ? copy.page : 0;
    return copy;
  }
  return sanitizeYouTubeBody(body, { relax: opts && opts.relax });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function pickPostStatNumber(post, keys = []) {
  const stats = (post && post.stats) || {};
  for (const key of keys) {
    const value = stats[key];
    const num = toNum(value);
    if (num !== undefined && num >= 0) return num;
  }
  return undefined;
}

function normalizeAiSearchItem(item, platform) {
  const username = cleanStr(item && item.username).replace(/^@/, '') || undefined;
  const userId = cleanStr(item && item.userId) || undefined;
  const matchedPosts = Array.isArray(item && item.matchedPosts) ? item.matchedPosts : [];
  const recentPosts = Array.isArray(item && item.recentPosts) ? item.recentPosts : [];

  const viewsFromMatched = matchedPosts
    .map((post) =>
      pickPostStatNumber(post, ['viewsCount', 'playsCount', 'videoViewsCount', 'views', 'plays'])
    )
    .filter((num) => num !== undefined);

  const averageViews = viewsFromMatched.length
    ? Math.round(viewsFromMatched.reduce((sum, num) => sum + num, 0) / viewsFromMatched.length)
    : undefined;

  const category = cleanStr(item && item.accountCategory) || undefined;
  const itemCountry = cleanStr(item && (item.country || item.locationCountry || item.countryCode || item.location)) || undefined;
  const itemLanguage = cleanStr(item && (item.language || item.primaryLanguage)) || undefined;

  return {
    userId,
    username,
    handle: username || undefined,
    fullname: cleanStr(item && item.fullName) || '',
    followers: toNum(item && (item.followersCount || item.followers)) || 0,
    engagementRate: toNum(item && item.engagementRate) || 0,
    engagements: toNum(item && (item.engagements || item.avgEngagements)),
    averageViews,
    picture: cleanStr(item && item.profilePicture) || undefined,
    url: buildPublicProfileUrl(platform, username, '', userId),
    isVerified:
      typeof (item && item.isVerified) === 'boolean'
        ? item.isVerified
        : typeof (item && item.verified) === 'boolean'
          ? item.verified
          : undefined,
    isPrivate:
      typeof (item && item.isPrivate) === 'boolean'
        ? item.isPrivate
        : typeof (item && item.private) === 'boolean'
          ? item.private
          : undefined,
    platform,
    bio: cleanStr(item && item.bio) || undefined,
    country: itemCountry,
    state: cleanStr(item && item.state) || undefined,
    city: cleanStr(item && item.city) || undefined,
    location: itemCountry || undefined,
    language: itemLanguage,
    categories: category ? [category] : [],
    category,
    primaryCategory: category,
    matchedPosts,
    recentPosts,
    accountCategory: category,
    searchType: 'ai',
    source: 'ai',
    aiMatchedPostsCount: matchedPosts.length,
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNumericRange(range) {
  if (!isPlainObject(range)) return null;

  const min = toNum(range.min);
  const max = toNum(range.max);
  if (min === undefined && max === undefined) return null;

  if (min !== undefined && max !== undefined && min > max) {
    return { min: max, max: min };
  }

  const next = {};
  if (min !== undefined) next.min = min;
  if (max !== undefined) next.max = max;
  return next;
}

function cloneFilterValue(value) {
  if (Array.isArray(value)) return deepClone(value);
  if (isPlainObject(value)) return deepClone(value);
  return value;
}

function mergeFilterObjects(base = {}, override = {}) {
  const next = deepClone(base || {});

  for (const [key, value] of Object.entries(override || {})) {
    if (value === undefined) continue;

    if (isPlainObject(value) && isPlainObject(next[key])) {
      next[key] = mergeFilterObjects(next[key], value);
      continue;
    }

    next[key] = cloneFilterValue(value);
  }

  return next;
}

function deriveAiFiltersFromPayload(payload = {}) {
  const standardInfluencer = deepClone(
    (((payload.body || {}).filter || {}).influencer) || {}
  );
  const topLevelFilters = isPlainObject(payload.filters) ? deepClone(payload.filters) : {};
  const explicitAiFilters = isPlainObject(payload.ai && payload.ai.filters)
    ? deepClone(payload.ai.filters)
    : {};

  const derived = mergeFilterObjects(standardInfluencer, topLevelFilters);
  const merged = mergeFilterObjects(derived, explicitAiFilters);

  if (Array.isArray(standardInfluencer.categories) && standardInfluencer.categories.length && !Array.isArray(merged.categories)) {
    merged.categories = deepClone(standardInfluencer.categories);
  }

  if (isPlainObject(standardInfluencer.locations)) {
    const locations = standardInfluencer.locations;

    if (Array.isArray(locations.countries) && locations.countries.length && !Array.isArray(merged.countries)) {
      merged.countries = deepClone(locations.countries);
    }
    if (Array.isArray(locations.states) && locations.states.length && !Array.isArray(merged.states)) {
      merged.states = deepClone(locations.states);
    }
    if (Array.isArray(locations.cities) && locations.cities.length && !Array.isArray(merged.cities)) {
      merged.cities = deepClone(locations.cities);
    }
  }

  for (const key of ['followers', 'engagementRate', 'engagements', 'views', 'reelsPlays', 'followersGrowthRate', 'age']) {
    const normalized = normalizeNumericRange(merged[key]);
    if (normalized) merged[key] = normalized;
  }

  return merged;
}

function normalizeTextFilterList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => cleanStr(entry).toLowerCase())
      .filter(Boolean);
  }

  const single = cleanStr(value).toLowerCase();
  return single ? [single] : [];
}

function numberMatchesRange(value, range) {
  if (!range) return true;
  const num = toNum(value);
  if (num === undefined) return false;
  if (range.min !== undefined && num < range.min) return false;
  if (range.max !== undefined && num > range.max) return false;
  return true;
}

function itemMatchesTextList(itemValue, allowedValues) {
  if (!allowedValues.length) return true;
  const value = cleanStr(itemValue).toLowerCase();
  return !!value && allowedValues.includes(value);
}

function itemMatchesLocationFilters(item, filters = {}) {
  if (!isPlainObject(filters) || !Object.keys(filters).length) return true;

  const countries = normalizeTextFilterList(filters.countries);
  const states = normalizeTextFilterList(filters.states);
  const cities = normalizeTextFilterList(filters.cities);

  if (countries.length && !itemMatchesTextList(item.country, countries)) return false;
  if (states.length && !itemMatchesTextList(item.state, states)) return false;
  if (cities.length && !itemMatchesTextList(item.city, cities)) return false;

  return true;
}

function itemMatchesCategoryFilters(item, categories) {
  const allowed = normalizeTextFilterList(categories);
  if (!allowed.length) return true;

  const itemCategories = normalizeTextFilterList(
    []
      .concat(item.category || [])
      .concat(item.primaryCategory || [])
      .concat(Array.isArray(item.categories) ? item.categories : [])
  );

  return itemCategories.some((entry) => allowed.includes(entry));
}

function itemMatchesUnifiedAutoFilters(item, filters = {}) {
  if (!item || !isPlainObject(filters) || !Object.keys(filters).length) return true;

  if (!numberMatchesRange(item.followers, normalizeNumericRange(filters.followers))) return false;
  if (!numberMatchesRange(item.engagementRate, normalizeNumericRange(filters.engagementRate))) return false;
  if (!numberMatchesRange(item.engagements, normalizeNumericRange(filters.engagements))) return false;
  if (!numberMatchesRange(item.averageViews, normalizeNumericRange(filters.views))) return false;

  if (typeof filters.isVerified === 'boolean' && Boolean(item.isVerified) !== filters.isVerified) {
    return false;
  }

  if (typeof filters.isPrivate === 'boolean' && Boolean(item.isPrivate) !== filters.isPrivate) {
    return false;
  }

  const languageFilters = normalizeTextFilterList(filters.language || filters.languages);
  if (languageFilters.length && !itemMatchesTextList(item.language, languageFilters)) {
    return false;
  }

  const genderFilters = normalizeTextFilterList(filters.gender);
  if (genderFilters.length && !itemMatchesTextList(item.gender, genderFilters)) {
    return false;
  }

  if (!itemMatchesLocationFilters(item, filters.locations || filters)) return false;
  if (!itemMatchesCategoryFilters(item, filters.categories)) return false;

  return true;
}

function buildAiSearchBody(platform, payload = {}) {
  const ai = payload.ai || {};
  const filters = deriveAiFiltersFromPayload(payload);

  if (Array.isArray(ai.brands) && ai.brands.length) {
    filters.brands = ai.brands;
  }

  return {
    page: ai.page != null ? ai.page : payload.page != null ? payload.page : 0,
    query: cleanStr(ai.query || payload.query || ''),
    filters,
  };
}

function collectStandardSearchItems(platform, data) {
  const bag = []
    .concat(Array.isArray(data && data.results) ? data.results : [])
    .concat(Array.isArray(data && data.items) ? data.items : [])
    .concat(Array.isArray(data && data.influencers) ? data.influencers : [])
    .concat(Array.isArray(data && data.directs) ? data.directs : [])
    .concat(Array.isArray(data && data.lookalikes) ? data.lookalikes : [])
    .concat(Array.isArray(data && data.users) ? data.users : [])
    .concat(Array.isArray(data && data.channels) ? data.channels : []);

  return bag.map((item) => {
    const normalized = normalizeSearchItem(item, platform);
    normalized.searchType = 'standard';
    normalized.source = 'standard';
    return normalized;
  });
}

const MODASH_DISCOVERY_PAGE_SIZE = 15;
const DEFAULT_FRONTEND_UNIFIED_LIMIT = 15;
const MAX_FRONTEND_UNIFIED_LIMIT = 15;
const DEFAULT_FRONTEND_SUGGESTION_LIMIT = 8;
const MAX_FRONTEND_SUGGESTION_LIMIT = 10;
const MIN_FRONTEND_QUERY_LENGTH = 2;
const FRONTEND_SEARCH_POOL_BUFFER = 30;

function normalizeFreeTextSearch(value) {
  return cleanStr(value)
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

function normalizeSearchToken(value) {
  return normalizeFreeTextSearch(value)
    .toLowerCase()
    .replace(/^[@#]+/, '')
    .replace(/[^a-z0-9._\-\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeSearchQuery(query) {
  const tokens = normalizeSearchToken(query)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length >= 2);

  return uniqStrings(tokens);
}

function extractTextTagValue(textTags = []) {
  for (const tag of asArray(textTags)) {
    if (!tag) continue;
    if (typeof tag === 'string') {
      const clean = normalizeFreeTextSearch(tag);
      if (clean) return clean;
      continue;
    }

    const value = normalizeFreeTextSearch(tag.value || tag.tag || tag.name);
    if (!value) continue;

    if (tag.type === 'mention') return `@${value.replace(/^@/, '')}`;
    if (tag.type === 'hashtag') return `#${value.replace(/^#/, '')}`;
    return value;
  }
  return '';
}

function extractUnifiedQuery(payload = {}) {
  const body = payload.body || {};
  const influencer = (body.filter && body.filter.influencer) || {};

  return normalizeFreeTextSearch(
    payload.query ||
    payload.q ||
    (payload.ai && payload.ai.query) ||
    body.query ||
    influencer.keywords ||
    influencer.bio ||
    extractTextTagValue(influencer.textTags) ||
    (Array.isArray(influencer.relevance) && influencer.relevance[0]) ||
    ''
  );
}

function isExplicitCreatorQuery(query) {
  const raw = normalizeFreeTextSearch(query);
  if (!raw) return false;
  if (raw.startsWith('@')) return true;
  if (/https?:\/\//i.test(raw)) return true;
  if (/^[a-z0-9._-]{3,40}$/i.test(raw) && /[._\d-]/.test(raw)) return true;
  return false;
}

function isPlainSingleTopicWord(query) {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length !== 1) return false;
  const raw = normalizeFreeTextSearch(query);
  return /^[a-z]+$/i.test(tokens[0]) && !/[._\d-]/.test(raw) && !raw.startsWith('@') && !raw.startsWith('#');
}

function classifyQuery(query) {
  const raw = normalizeFreeTextSearch(query);
  const lower = raw.toLowerCase();
  const tokens = tokenizeSearchQuery(raw);

  if (!lower) {
    return {
      intent: 'topic',
      allowLookupInSuggestions: false,
      allowLookupInSearch: false,
      preferTopicDiscovery: true,
    };
  }

  if (lower.startsWith('#')) {
    return {
      intent: 'hashtag',
      allowLookupInSuggestions: false,
      allowLookupInSearch: false,
      preferTopicDiscovery: true,
    };
  }

  if (isExplicitCreatorQuery(raw)) {
    return {
      intent: 'creator',
      allowLookupInSuggestions: true,
      allowLookupInSearch: true,
      preferTopicDiscovery: false,
    };
  }

  if (isPlainSingleTopicWord(raw)) {
    return {
      intent: 'topic',
      allowLookupInSuggestions: false,
      allowLookupInSearch: false,
      preferTopicDiscovery: true,
    };
  }

  if (tokens.length >= 2) {
    return {
      intent: 'ambiguous',
      allowLookupInSuggestions: true,
      allowLookupInSearch: false,
      preferTopicDiscovery: true,
    };
  }

  return {
    intent: 'topic',
    allowLookupInSuggestions: false,
    allowLookupInSearch: false,
    preferTopicDiscovery: true,
  };
}

function detectSearchIntent(query) {
  return classifyQuery(query).intent;
}

function buildUnifiedPagination(pageInput, limitInput) {
  const rawPage = parseInt(String(pageInput ?? 1), 10);
  const rawLimit = parseInt(String(limitInput ?? DEFAULT_FRONTEND_UNIFIED_LIMIT), 10);

  const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
  const limit = Math.min(
    MAX_FRONTEND_UNIFIED_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_FRONTEND_UNIFIED_LIMIT)
  );

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function sourcePriority(item, queryInfo = classifyQuery('')) {
  if (item.searchType === 'lookup') return queryInfo.intent === 'creator' ? 4 : 0;
  if (item.searchType === 'combined') return 3;
  if (item.searchType === 'ai') return 2;
  return 1;
}

function hasExplicitStandardTextFilter(body = {}) {
  const influencer = (body.filter && body.filter.influencer) || {};
  return Boolean(
    cleanStr(body.query) ||
    cleanStr(influencer.keywords) ||
    cleanStr(influencer.bio) ||
    (Array.isArray(influencer.relevance) && influencer.relevance.length) ||
    (Array.isArray(influencer.audienceRelevance) && influencer.audienceRelevance.length) ||
    (Array.isArray(influencer.textTags) && influencer.textTags.length)
  );
}

function buildStandardBodyForQuery(platform, originalBody, query, pageIndex) {
  const body = buildPlatformBody(platform, originalBody || {});
  body.page = pageIndex;
  body.sort = body.sort || { field: 'followers', direction: 'desc' };
  body.filter = body.filter || {};
  body.filter.influencer = body.filter.influencer || {};

  if (hasExplicitStandardTextFilter(body)) {
    return body;
  }

  const queryInfo = classifyQuery(query);
  const normalized = normalizeFreeTextSearch(query);
  const influencer = body.filter.influencer;

  if (queryInfo.intent === 'creator') {
    influencer.bio = normalized.replace(/^@/, '');
  } else if (queryInfo.intent === 'hashtag') {
    influencer.textTags = [{ type: 'hashtag', value: normalized.replace(/^#/, '') }];
  } else {
    influencer.keywords = normalized;
  }

  return body;
}

function collectLookupSearchItems(platform, data) {
  const bag = []
    .concat(Array.isArray(data && data.directs) ? data.directs : [])
    .concat(Array.isArray(data && data.results) ? data.results : [])
    .concat(Array.isArray(data && data.users) ? data.users : [])
    .concat(Array.isArray(data && data.channels) ? data.channels : []);

  return bag.map((item) => {
    const normalized = normalizeSearchItem(item, platform);
    normalized.searchType = 'lookup';
    normalized.source = 'lookup';
    return normalized;
  });
}

function clampSuggestionLimit(limitInput) {
  const rawLimit = parseInt(String(limitInput ?? DEFAULT_FRONTEND_SUGGESTION_LIMIT), 10);
  return Math.min(
    MAX_FRONTEND_SUGGESTION_LIMIT,
    Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_FRONTEND_SUGGESTION_LIMIT)
  );
}

function toSuggestionItem(item, query) {
  return {
    type: 'creator',
    platform: item.platform,
    userId: item.userId,
    username: item.username,
    handle: item.handle,
    fullname: item.fullname,
    picture: item.picture,
    url: item.url,
    isVerified: Boolean(item.isVerified),
    followers: Number(item.followers || 0),
    score: Number(item.__relevanceScore || 0),
    label: item.fullname || item.username || item.handle || query,
    sublabel: item.username ? `@${String(item.username).replace(/^@/, '')}` : '',
    category: item.primaryCategory || item.category || item.accountCategory || undefined,
  };
}

function toSearchQuerySuggestion(query, queryInfo) {
  const clean = normalizeFreeTextSearch(query);
  if (!clean) return null;

  const label =
    queryInfo.intent === 'hashtag'
      ? `Search creators posting ${clean}`
      : `Search creators for "${clean}"`;

  return {
    type: 'query',
    intent: queryInfo.intent,
    value: clean,
    label,
    sublabel:
      queryInfo.intent === 'creator'
        ? 'Exact creator search'
        : 'Discover influencers by niche, content and bio',
  };
}

function toTaxonomySuggestionItem(kind, platform, raw) {
  if (!raw) return null;

  const label = cleanStr(raw.name || raw.label || raw.title || raw.value || raw.topic || raw.interest);
  if (!label) return null;

  return {
    type: kind,
    intent: 'topic',
    platform,
    id: raw.id || raw.topicId || raw.interestId || raw.brandId || null,
    value: label,
    label,
    sublabel: `${platform} ${kind}`,
  };
}

function pickTopicSuggestionRows(data) {
  if (!data) return [];
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.topics)) return data.topics;
  if (Array.isArray(data.interests)) return data.interests;
  if (Array.isArray(data.brands)) return data.brands;
  return [];
}

async function fetchTopicSuggestions(query, platforms, limit) {
  const suggestions = [];
  const seen = new Set();

  async function addFromEndpoint(platform, kind, path) {
    try {
      const data = await modashGET(path, {
        query: normalizeFreeTextSearch(query).replace(/^[@#]/, ''),
        limit,
      });
      for (const row of pickTopicSuggestionRows(data)) {
        const item = toTaxonomySuggestionItem(kind, platform, row);
        if (!item) continue;
        const key = `${kind}:${String(item.value).toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push(item);
        if (suggestions.length >= limit) return;
      }
    } catch {
      // ignore unsupported taxonomy endpoints per platform
    }
  }

  for (const platform of platforms) {
    if (suggestions.length >= limit) break;
    await addFromEndpoint(platform, 'topic', `/${platform}/topics`);
    if (suggestions.length >= limit) break;
    if (platform === 'instagram') {
      await addFromEndpoint(platform, 'interest', '/instagram/interests');
    }
  }

  return suggestions.slice(0, limit);
}

function buildSearchableText(item) {
  return [
    item.username,
    item.handle,
    item.fullname,
    item.bio,
    item.category,
    item.primaryCategory,
    item.accountCategory,
    Array.isArray(item.categories) ? item.categories.join(' ') : '',
    item.country,
    item.location,
    item.url,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function buildTopicText(item) {
  const postText = []
    .concat(asArray(item && item.matchedPosts))
    .concat(asArray(item && item.recentPosts))
    .map((post) =>
      firstNonEmpty(
        post && post.title,
        post && post.caption,
        post && post.description,
        post && post.text,
        post && post.alt,
        post && post.name
      )
    )
    .filter(Boolean)
    .join(' ');

  return [
    item.bio,
    item.category,
    item.primaryCategory,
    item.accountCategory,
    Array.isArray(item.categories) ? item.categories.join(' ') : '',
    postText,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function computeRelevanceScore(item, query) {
  const rawQuery = normalizeFreeTextSearch(query);
  const normalizedQuery = normalizeSearchToken(rawQuery);
  const tokens = tokenizeSearchQuery(rawQuery);
  const queryInfo = classifyQuery(rawQuery);

  const username = normalizeSearchToken(item.username || item.handle || '');
  const fullname = normalizeSearchToken(item.fullname || '');
  const searchable = buildSearchableText(item);
  const topicText = buildTopicText(item);

  let score = 0;
  let matched = false;
  let personHits = 0;
  let topicHits = 0;

  if (!normalizedQuery) {
    return { score: 0, matched: true, intent: queryInfo.intent };
  }

  const usernameExact = Boolean(username && username === normalizedQuery);
  const fullnameExact = Boolean(fullname && fullname === normalizedQuery);
  const usernameStarts = Boolean(username && username.startsWith(normalizedQuery));
  const fullnameStarts = Boolean(fullname && fullname.startsWith(normalizedQuery));
  const usernameContains = Boolean(username && username.includes(normalizedQuery));
  const fullnameContains = Boolean(fullname && fullname.includes(normalizedQuery));

  if (queryInfo.intent === 'creator') {
    if (usernameExact) {
      score += 220;
      matched = true;
    }
    if (fullnameExact) {
      score += 180;
      matched = true;
    }
    if (usernameStarts) {
      score += 150;
      matched = true;
    }
    if (fullnameStarts) {
      score += 120;
      matched = true;
    }
    if (usernameContains) {
      score += 90;
      matched = true;
    }
    if (fullnameContains) {
      score += 70;
      matched = true;
    }
  } else if (queryInfo.intent === 'ambiguous') {
    if (usernameExact) {
      score += 160;
      matched = true;
    }
    if (fullnameExact) {
      score += 145;
      matched = true;
    }
    if (usernameStarts) {
      score += 90;
      matched = true;
    }
    if (fullnameStarts) {
      score += 75;
      matched = true;
    }
    if (usernameContains) {
      score += 36;
      matched = true;
    }
    if (fullnameContains) {
      score += 30;
      matched = true;
    }
  }

  for (const token of tokens) {
    if (!token) continue;

    const inUsername = username.includes(token);
    const inFullname = fullname.includes(token);
    const inTopicText = topicText.includes(token);
    const inSearchable = searchable.includes(token);

    if (queryInfo.intent === 'creator') {
      if (inUsername) {
        score += 30;
        personHits += 1;
        matched = true;
      } else if (inFullname) {
        score += 24;
        personHits += 1;
        matched = true;
      } else if (inSearchable) {
        score += 10;
        matched = true;
      }
      continue;
    }

    if (queryInfo.intent === 'ambiguous') {
      if (inTopicText) {
        score += 24;
        topicHits += 1;
        matched = true;
      } else if (inFullname) {
        score += 16;
        personHits += 1;
        matched = true;
      } else if (inUsername) {
        score += 12;
        personHits += 1;
        matched = true;
      } else if (inSearchable) {
        score += 8;
        matched = true;
      }
      continue;
    }

    if (inTopicText) {
      score += 30;
      topicHits += 1;
      matched = true;
    } else if (inFullname) {
      score += 4;
      personHits += 1;
      matched = true;
    } else if (inUsername) {
      score += 2;
      personHits += 1;
      matched = true;
    }
  }

  if (queryInfo.intent === 'topic' || queryInfo.intent === 'hashtag') {
    if (item.searchType === 'combined') {
      score += 60;
      matched = true;
    } else if (item.searchType === 'ai') {
      score += 55;
      matched = true;
    } else if (item.searchType === 'standard') {
      score += 40;
      matched = true;
    } else if (item.searchType === 'lookup') {
      score -= 25;
    }

    if (tokens.length && topicHits === tokens.length) {
      score += 42;
      matched = true;
    }

    if (item.searchType === 'lookup' && topicHits === 0) {
      matched = false;
    }
  } else if (queryInfo.intent === 'ambiguous') {
    if (item.searchType === 'combined') {
      score += 34;
      matched = true;
    } else if (item.searchType === 'ai') {
      score += 28;
      matched = true;
    } else if (item.searchType === 'standard') {
      score += 20;
      matched = true;
    } else if (item.searchType === 'lookup') {
      score += 6;
    }

    if (tokens.length && (topicHits + personHits) === tokens.length) {
      score += 30;
      matched = true;
    }
  } else {
    if (tokens.length && personHits === tokens.length) {
      score += 45;
      matched = true;
    }
    if (item.searchType === 'lookup') score += 25;
    if (item.searchType === 'combined') score += 18;
    if (item.searchType === 'ai') score += 12;
  }

  if (item.aiMatchedPostsCount) {
    score += Math.min(14, Number(item.aiMatchedPostsCount) * 2);
  }

  if (item.isVerified) {
    score += queryInfo.intent === 'topic' || queryInfo.intent === 'hashtag' ? 2 : 6;
  }

  const followersBoost = Math.min(10, Math.log10(Number(item.followers || 0) + 1) * 2);
  score += followersBoost;

  return { score, matched, intent: queryInfo.intent };
}

function minimumScoreForQuery(query, mode) {
  const normalized = normalizeSearchToken(query);
  const tokenCount = tokenizeSearchQuery(query).length;
  const queryInfo = classifyQuery(query);

  if (mode === 'suggestion') {
    if (queryInfo.intent === 'topic' || queryInfo.intent === 'hashtag') return 0;
    if (normalized.length <= 3) return 60;
    if (normalized.length <= 5) return 48;
    return 40;
  }

  if (queryInfo.intent === 'topic' || queryInfo.intent === 'hashtag') {
    if (normalized.length <= 3) return 34;
    return 26;
  }

  if (queryInfo.intent === 'ambiguous') {
    if (tokenCount >= 3) return 24;
    return 20;
  }

  if (tokenCount >= 3) return 28;
  if (normalized.length <= 3) return 55;
  if (normalized.length <= 5) return 40;
  return 30;
}

function compareUnifiedRankedItems(a, b, queryInfo = classifyQuery('')) {
  if ((b.__relevanceScore || 0) !== (a.__relevanceScore || 0)) {
    return (b.__relevanceScore || 0) - (a.__relevanceScore || 0);
  }

  if (sourcePriority(b, queryInfo) !== sourcePriority(a, queryInfo)) {
    return sourcePriority(b, queryInfo) - sourcePriority(a, queryInfo);
  }

  if (!!b.isVerified !== !!a.isVerified) return b.isVerified ? 1 : -1;

  if ((b.aiMatchedPostsCount || 0) !== (a.aiMatchedPostsCount || 0)) {
    return (b.aiMatchedPostsCount || 0) - (a.aiMatchedPostsCount || 0);
  }

  if ((b.followers || 0) !== (a.followers || 0)) {
    return (b.followers || 0) - (a.followers || 0);
  }

  if ((b.engagementRate || 0) !== (a.engagementRate || 0)) {
    return (b.engagementRate || 0) - (a.engagementRate || 0);
  }

  return String(a.username || '').localeCompare(String(b.username || ''));
}

function buildBalancedPlatformQuota(platforms = [], limit = DEFAULT_FRONTEND_UNIFIED_LIMIT) {
  const orderedPlatforms = [];

  for (const rawPlatform of asArray(platforms)) {
    const platform = normalizePlatform(rawPlatform);
    if (platform && !orderedPlatforms.includes(platform)) {
      orderedPlatforms.push(platform);
    }
  }

  if (!orderedPlatforms.length) return {};

  const safeLimit = Math.max(
    1,
    parseInt(String(limit ?? DEFAULT_FRONTEND_UNIFIED_LIMIT), 10) || DEFAULT_FRONTEND_UNIFIED_LIMIT
  );

  const base = Math.floor(safeLimit / orderedPlatforms.length);
  let remainder = safeLimit % orderedPlatforms.length;

  const quota = {};
  for (const platform of orderedPlatforms) {
    quota[platform] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }

  return quota;
}

function buildBalancedPlatformFetchPlan(platforms = [], limit = DEFAULT_FRONTEND_UNIFIED_LIMIT) {
  const orderedPlatforms = [];

  for (const rawPlatform of asArray(platforms)) {
    const platform = normalizePlatform(rawPlatform);
    if (platform && !orderedPlatforms.includes(platform)) {
      orderedPlatforms.push(platform);
    }
  }

  const safeLimit = Math.max(
    1,
    parseInt(String(limit ?? DEFAULT_FRONTEND_UNIFIED_LIMIT), 10) || DEFAULT_FRONTEND_UNIFIED_LIMIT
  );

  // Fetch a full page from each selected platform, then balance while rendering.
  // The old quota-based fetch (for example IG=8, TikTok=7 for limit=15) could
  // make recommendations look uneven or empty when one platform returned fewer rows.
  return orderedPlatforms.map((platform) => ({
    platform,
    limit: safeLimit,
  }));
}

function applySearchFetchLimit(target, fetchLimit) {
  const safeLimit = Math.max(0, parseInt(String(fetchLimit || 0), 10) || 0);
  if (!target || !safeLimit) return target;

  target.limit = safeLimit;
  target.size = safeLimit;
  target.pageSize = safeLimit;
  return target;
}

function shiftBestBalancedItem(platformQueues, overflowQueue, platforms, queryInfo) {
  let bestSource = null;
  let bestItem = null;

  for (const platform of platforms) {
    const queue = platformQueues.get(platform) || [];
    const item = queue[0];
    if (!item) continue;

    if (!bestItem || compareUnifiedRankedItems(item, bestItem, queryInfo) < 0) {
      bestItem = item;
      bestSource = platform;
    }
  }

  const overflowItem = overflowQueue[0];
  if (overflowItem && (!bestItem || compareUnifiedRankedItems(overflowItem, bestItem, queryInfo) < 0)) {
    bestItem = overflowItem;
    bestSource = '__overflow__';
  }

  if (!bestSource) return null;

  if (bestSource === '__overflow__') {
    return overflowQueue.shift() || null;
  }

  const sourceQueue = platformQueues.get(bestSource) || [];
  return sourceQueue.shift() || null;
}

function balanceRankedResultsAcrossPlatforms(
  items = [],
  platforms = [],
  limit = DEFAULT_FRONTEND_UNIFIED_LIMIT,
  query = ''
) {
  if (!Array.isArray(items) || !items.length) return items;

  const orderedPlatforms = [];
  for (const rawPlatform of asArray(platforms)) {
    const platform = normalizePlatform(rawPlatform);
    if (platform && !orderedPlatforms.includes(platform)) {
      orderedPlatforms.push(platform);
    }
  }

  if (orderedPlatforms.length <= 1) return items;

  const safeLimit = Math.max(
    1,
    parseInt(String(limit ?? DEFAULT_FRONTEND_UNIFIED_LIMIT), 10) || DEFAULT_FRONTEND_UNIFIED_LIMIT
  );

  const quota = buildBalancedPlatformQuota(orderedPlatforms, safeLimit);
  const queryInfo = classifyQuery(query);

  const platformQueues = new Map();
  for (const platform of orderedPlatforms) {
    platformQueues.set(platform, []);
  }

  const overflowQueue = [];

  for (const item of items) {
    const platform = normalizePlatform(item && item.platform);
    if (platform && platformQueues.has(platform)) {
      platformQueues.get(platform).push(item);
    } else {
      overflowQueue.push(item);
    }
  }

  const balanced = [];

  while (true) {
    const pageItems = [];
    let addedOnThisRound = false;

    for (const platform of orderedPlatforms) {
      const queue = platformQueues.get(platform) || [];
      const takeCount = quota[platform] || 0;

      let taken = 0;
      while (taken < takeCount && queue.length) {
        pageItems.push(queue.shift());
        taken += 1;
        addedOnThisRound = true;
      }
    }

    if (!addedOnThisRound) {
      const fallbackItem = shiftBestBalancedItem(
        platformQueues,
        overflowQueue,
        orderedPlatforms,
        queryInfo
      );

      if (!fallbackItem) break;

      pageItems.push(fallbackItem);
      addedOnThisRound = true;
    }

    while (pageItems.length < safeLimit) {
      const nextItem = shiftBestBalancedItem(
        platformQueues,
        overflowQueue,
        orderedPlatforms,
        queryInfo
      );

      if (!nextItem) break;
      pageItems.push(nextItem);
    }

    pageItems.sort((a, b) => compareUnifiedRankedItems(a, b, queryInfo));
    balanced.push(...pageItems);
  }

  return balanced;
}

function sortUnifiedResults(items = [], query, mode = 'search') {
  const threshold = minimumScoreForQuery(query, mode);
  const queryInfo = classifyQuery(query);

  return items
    .map((item) => {
      const relevance = computeRelevanceScore(item, query);
      return {
        ...item,
        __relevanceScore: relevance.score,
        __matched: relevance.matched,
      };
    })
    .filter((item) => item.__matched && item.__relevanceScore >= threshold)
    .sort((a, b) => compareUnifiedRankedItems(a, b, queryInfo));
}

function decorateUnifiedResults(items = [], query) {
  const queryInfo = classifyQuery(query);

  return items
    .map((item) => {
      const relevance = computeRelevanceScore(item, query);
      return {
        ...item,
        __relevanceScore: relevance.score,
        __matched: relevance.matched,
      };
    })
    .sort((a, b) => compareUnifiedRankedItems(a, b, queryInfo));
}

function mergeUnifiedSearchItems(items = []) {
  const map = new Map();

  for (const item of items) {
    const keyBase =
      (item.userId && String(item.userId).toLowerCase()) ||
      (item.username && String(item.username).toLowerCase()) ||
      (item.url && String(item.url).toLowerCase());

    if (!keyBase) continue;

    const key = `${item.platform}:${keyBase}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, item);
      continue;
    }

    const primary = betterSearchResult(prev, item);
    const secondary = primary === prev ? item : prev;
    const merged = mergeSearchItem(primary, secondary);

    if ((!merged.searchType || merged.searchType === 'standard') && (primary.searchType || secondary.searchType)) {
      if (primary.searchType === 'lookup' || secondary.searchType === 'lookup') {
        merged.searchType = 'lookup';
      } else if (primary.searchType === 'ai' || secondary.searchType === 'ai') {
        merged.searchType =
          primary.searchType === 'standard' || secondary.searchType === 'standard' ? 'combined' : 'ai';
      } else {
        merged.searchType = primary.searchType || secondary.searchType || 'standard';
      }
    }

    if (!Array.isArray(merged.matchedPosts) || !merged.matchedPosts.length) {
      merged.matchedPosts = Array.isArray(primary.matchedPosts) && primary.matchedPosts.length
        ? primary.matchedPosts
        : secondary.matchedPosts;
    }

    if (!Array.isArray(merged.recentPosts) || !merged.recentPosts.length) {
      merged.recentPosts = Array.isArray(primary.recentPosts) && primary.recentPosts.length
        ? primary.recentPosts
        : secondary.recentPosts;
    }

    if (!merged.accountCategory) {
      merged.accountCategory = primary.accountCategory || secondary.accountCategory;
    }

    merged.aiMatchedPostsCount = Math.max(
      Number(primary.aiMatchedPostsCount || 0),
      Number(secondary.aiMatchedPostsCount || 0)
    );

    merged.source = merged.searchType || 'standard';
    map.set(key, merged);
  }

  return Array.from(map.values());
}

async function runLookupPlatformSearch(platform, query, limit) {
  const normalizedQuery = normalizeFreeTextSearch(query).replace(/^[@#]/, '');
  if (!normalizedQuery) {
    return { platform, kind: 'lookup', data: null, total: 0, results: [] };
  }

  const data = await modashGET(`/${platform}/users`, {
    query: normalizedQuery,
    limit,
  });

  const results = collectLookupSearchItems(platform, data);

  return {
    platform,
    kind: 'lookup',
    data,
    total: results.length,
    results,
  };
}

async function runStandardPlatformSearch(platform, body, query, pageIndex, fetchLimit) {
  const requestBody = buildStandardBodyForQuery(platform, body, query, pageIndex);
  requestBody.page = pageIndex;
  applySearchFetchLimit(requestBody, fetchLimit);

  let data = await modashPOST(`/${platform}/search`, requestBody);

  const enableFallback = (process.env.MODASH_YT_FALLBACK || '1') !== '0';
  if (platform === 'youtube' && enableFallback && Number((data && data.total) || 0) === 0) {
    const retryBody = buildPlatformBody(platform, requestBody, { relax: true });
    retryBody.page = pageIndex;
    applySearchFetchLimit(retryBody, fetchLimit);
    try {
      const retryData = await modashPOST(`/${platform}/search`, retryBody);
      if (retryData && Number((retryData && retryData.total) || 0) > 0) {
        data = retryData;
      }
    } catch {
      // ignore youtube fallback retry errors
    }
  }

  let results = collectStandardSearchItems(platform, data);
  if (fetchLimit) {
    results = results.slice(0, fetchLimit);
  }

  return {
    platform,
    kind: 'standard',
    data,
    total: Number((data && data.total) || 0),
    results,
    requestedLimit: fetchLimit || null,
  };
}

async function runAiPlatformSearch(platform, payload, pageIndex, fetchLimit) {
  const body = buildAiSearchBody(platform, payload);
  body.page = pageIndex;
  applySearchFetchLimit(body, fetchLimit);

  const data = await modashPOST(`/ai/${platform}/text-search`, body);
  const profiles = Array.isArray(data && data.profiles) ? data.profiles : [];

  let results = profiles.map((item) => normalizeAiSearchItem(item, platform));
  if (fetchLimit) {
    results = results.slice(0, fetchLimit);
  }

  return {
    platform,
    kind: 'ai',
    data,
    total: Number((data && data.total) || 0),
    results,
    requestedLimit: fetchLimit || null,
  };
}

function buildRequestedPlatforms(input) {
  const requestedPlatforms = Array.isArray(input) && input.length
    ? input
    : ['instagram', 'youtube', 'tiktok'];

  const platforms = [];
  for (const rawPlatform of requestedPlatforms) {
    const platform = normalizePlatform(rawPlatform);
    if (!platform) {
      throw Object.assign(new Error(`Unsupported platform: ${rawPlatform}`), { status: 400 });
    }
    if (!platforms.includes(platform)) platforms.push(platform);
  }

  return platforms;
}

async function frontendUnifiedSuggestions(req, res) {
  try {
    const input = { ...(req.query || {}), ...(req.body || {}) };
    const query = normalizeFreeTextSearch(input.query || input.q);
    const limit = clampSuggestionLimit(input.limit);
    const platforms = buildRequestedPlatforms(input.platforms);
    const queryInfo = classifyQuery(query);

    if (query.length < MIN_FRONTEND_QUERY_LENGTH) {
      return res.json({
        query,
        suggestions: [],
        meta: { platforms, limit, intent: queryInfo.intent },
      });
    }

    const suggestions = [];
    const seen = new Set();

    function pushSuggestion(item) {
      if (!item) return;
      const key = `${item.type}:${cleanStr(item.value || item.username || item.userId || item.label).toLowerCase()}`;
      if (!key || seen.has(key)) return;
      seen.add(key);
      suggestions.push(item);
    }

    if (queryInfo.intent !== 'creator') {
      pushSuggestion(toSearchQuerySuggestion(query, queryInfo));
    }

    if (queryInfo.allowLookupInSuggestions && suggestions.length < limit) {
      const lookupResponses = [];
      for (const platform of platforms) {
        lookupResponses.push(await runLookupPlatformSearch(platform, query, limit));
      }

      const merged = mergeUnifiedSearchItems(
        lookupResponses.flatMap((entry) => (Array.isArray(entry.results) ? entry.results : []))
      );

      const enriched = await enrichResultsFromCache(merged);
      const ranked = sortUnifiedResults(enriched, query, 'suggestion')
        .slice(0, limit)
        .map((item) => toSuggestionItem(item, query));

      for (const item of ranked) {
        pushSuggestion(item);
        if (suggestions.length >= limit) break;
      }
    }

    if ((queryInfo.intent === 'topic' || queryInfo.intent === 'hashtag') && suggestions.length < limit) {
      const taxonomySuggestions = await fetchTopicSuggestions(query, platforms, limit - suggestions.length);
      for (const item of taxonomySuggestions) {
        pushSuggestion(item);
        if (suggestions.length >= limit) break;
      }
    }

    return res.json({
      query,
      suggestions: suggestions.slice(0, limit),
      total: Math.min(suggestions.length, limit),
      meta: {
        platforms,
        limit,
        intent: queryInfo.intent,
      },
    });
  } catch (err) {
    const safe = buildSafeErrorMessage(err, 'Suggestion search failed');
    const status = (err && err.status) || 400;
    return res.status(status).json({ error: safe });
  }
}

async function frontendUnifiedSearch(req, res) {
  try {
    const payload = req.body || {};
    const brandId = cleanStr(payload.brandId || payload.brand_id || '');
    const query = extractUnifiedQuery(payload);
    const queryInfo = classifyQuery(query);

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required for search' });
    }

    if (!query) {
      return res.status(400).json({
        error: 'query is required. Pass query in payload.query, payload.ai.query, or payload.body.filter.influencer.*',
      });
    }

    if (query.length < MIN_FRONTEND_QUERY_LENGTH) {
      return res.status(400).json({ error: `query must be at least ${MIN_FRONTEND_QUERY_LENGTH} characters.` });
    }

    try {
      await ensureSearchQuota(brandId);
    } catch (e) {
      if (e.code === 'QUOTA_EXCEEDED') {
        await saveErrorLog(req, e, 403, "FRONTEND_UNIFIED_SEARCH_ERROR");
        return res.status(403).json({
          error: 'You have reached your monthly search limit.',
          meta: e.meta,
        });
      }
      throw e;
    }

    const platforms = buildRequestedPlatforms(payload.platforms);
    const pagination = buildUnifiedPagination(payload.page, payload.limit);

    const searchMode = cleanStr(payload.searchMode || payload.mode || '').toLowerCase();
    const hasStandardBody = !!payload.body;
    const hasAiConfig = !!payload.ai;

    const doStandard =
      searchMode === 'combined' ||
      searchMode === 'all' ||
      searchMode === 'standard' ||
      (!searchMode && (hasStandardBody || true));

    const doAi =
      query.length >= 3 &&
      (
        searchMode === 'combined' ||
        searchMode === 'all' ||
        searchMode === 'ai' ||
        (!searchMode && (hasAiConfig || queryInfo.preferTopicDiscovery))
      );

    const aiDelayMs = Math.max(
      0,
      parseInt(String(payload.aiDelayMs ?? process.env.MODASH_AI_DELAY_MS ?? 1100), 10) || 0
    );

    const desiredPoolSize = pagination.limit;
    const fetchPlan = buildBalancedPlatformFetchPlan(platforms, pagination.limit);
    const fetchLimitByPlatform = new Map(fetchPlan.map((entry) => [entry.platform, entry.limit]));
    const requestedPageIndex = Math.max(0, pagination.page - 1);
    const pagesPerPlatform = 1;

    const responses = [];
    const warnings = [];

    if (queryInfo.allowLookupInSearch) {
      for (const platform of platforms) {
        const lookupLimit = Math.min(25, fetchLimitByPlatform.get(platform) || desiredPoolSize);
        try {
          responses.push(await runLookupPlatformSearch(platform, query, lookupLimit));
        } catch (err) {
          if (isAuthError(err)) {
            warnings.push({
              platform,
              kind: 'lookup',
              status: err.status,
              message: 'Lookup search skipped because the current Modash auth settings do not allow this endpoint.',
            });
            continue;
          }
          throw err;
        }
      }
    }

    if (doStandard) {
      for (const platform of platforms) {
        const fetchLimit = fetchLimitByPlatform.get(platform) || pagination.limit;
        const result = await runStandardPlatformSearch(
          platform,
          payload.body || {},
          query,
          requestedPageIndex,
          fetchLimit
        );
        responses.push(result);
      }
    }

    if (doAi) {
      let aiCallIndex = 0;
      for (const platform of platforms) {
        const fetchLimit = fetchLimitByPlatform.get(platform) || pagination.limit;
        if (aiCallIndex > 0 && aiDelayMs > 0) {
          await sleep(aiDelayMs);
        }

        try {
          const result = await runAiPlatformSearch(
            platform,
            payload,
            requestedPageIndex,
            fetchLimit
          );
          responses.push(result);
        } catch (err) {
          if (isAuthError(err)) {
            warnings.push({
              platform,
              kind: 'ai',
              status: err.status,
              message: 'AI search skipped because the current Modash key/header does not allow the AI endpoint.',
            });
            aiCallIndex += 1;
            continue;
          }
          throw err;
        }

        aiCallIndex += 1;
      }
    }

    if (!responses.length) {
      return res.json({
        searchMode: doStandard && doAi ? 'combined' : doAi ? 'ai' : 'standard',
        query,
        results: [],
        total: 0,
        unique: 0,
        pagination: {
          page: pagination.page,
          limit: pagination.limit,
          total: 0,
          totalPages: 1,
          hasNextPage: false,
          hasPrevPage: pagination.page > 1,
        },
        meta: {
          queryIntent: queryInfo.intent,
          lookupTotal: 0,
          standardTotal: 0,
          aiTotal: 0,
          platforms,
          aiDelayMs: doAi ? aiDelayMs : 0,
          pagesPerPlatform,
          requestedPageIndex,
          fetchPlan,
          warnings,
          perPlatform: [],
        },
      });
    }

    const merged = mergeUnifiedSearchItems(
      responses.flatMap((entry) => (Array.isArray(entry.results) ? entry.results : []))
    );

    const cachedEnriched = await enrichResultsFromCache(merged);

    // Do not remove provider results again in the backend. Modash already applies the requested filters.
    // We only decorate and sort for display so the API can still return the full fetched set.
    const orderedResults = decorateUnifiedResults(cachedEnriched, query);

    const balancedResults =
      platforms.length > 1
        ? balanceRankedResultsAcrossPlatforms(
          orderedResults,
          platforms,
          pagination.limit,
          query
        )
        : orderedResults;

    const pagedResults = balancedResults.slice(
      pagination.offset,
      pagination.offset + pagination.limit
    );

    const totalsByKind = responses.reduce(
      (acc, entry) => {
        acc[entry.kind] = (acc[entry.kind] || 0) + Number(entry.total || 0);
        return acc;
      },
      { lookup: 0, standard: 0, ai: 0 }
    );

    return res.json({
      searchMode: doStandard && doAi ? 'combined' : doAi ? 'ai' : 'standard',
      query,
      results: pagedResults,
      total: balancedResults.length,
      unique: balancedResults.length,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total: balancedResults.length,
        totalPages: Math.max(1, Math.ceil(balancedResults.length / pagination.limit)),
        hasNextPage: pagination.offset + pagination.limit < balancedResults.length,
        hasPrevPage: pagination.page > 1,
      },
      meta: {
        queryIntent: queryInfo.intent,
        lookupTotal: totalsByKind.lookup,
        standardTotal: totalsByKind.standard,
        aiTotal: totalsByKind.ai,
        platforms,
        aiDelayMs: doAi ? aiDelayMs : 0,
        pagesPerPlatform,
        requestedPageIndex,
        fetchPlan,
        warnings,
        perPlatform: responses.map((entry) => ({
          platform: entry.platform,
          kind: entry.kind,
          total: entry.total,
          resultCount: Array.isArray(entry.results) ? entry.results.length : 0,
          requestedLimit: entry.requestedLimit || null,
        })),
      },
    });
  } catch (err) {
    console.error('Unified search error:', err.message);
    const safe = buildSafeErrorMessage(err, 'Unified search failed');
    const status = (err && err.status) || 400;
    await saveErrorLog(req, err, status, "FRONTEND_UNIFIED_SEARCH_ERROR");
    return res.status(status).json({ error: safe });
  }
}

/* -------------------------------------------------------------------------- */
/*                              Saved filters                                 */
/* -------------------------------------------------------------------------- */

function buildSavedInfluencerMongoFilter(input = {}) {
  const ands = [];

  const provider = cleanStr(input.provider || input.platform || '').toLowerCase();
  const platforms = parseMultiValue(input.platforms)
    .map((x) => cleanStr(x).toLowerCase())
    .filter((x) => ALLOWED_PLATFORMS.has(x));

  if (provider && provider !== 'all' && ALLOWED_PLATFORMS.has(provider)) {
    ands.push({ provider });
  } else if (platforms.length === 1) {
    ands.push({ provider: platforms[0] });
  } else if (platforms.length > 1) {
    ands.push({ provider: { $in: platforms } });
  }

  const influencerId = cleanStr(input.influencerId || input.influencer_id || '');
  if (influencerId) ands.push({ influencerId });

  const followersMin =
    input.followersMin ?? input.followers_min ?? input.minFollowers ?? input.min_followers;
  const followersMax =
    input.followersMax ?? input.followers_max ?? input.maxFollowers ?? input.max_followers;

  let min = parseFlexibleNumber(followersMin);
  let max = parseFlexibleNumber(followersMax);
  if (min !== null || max !== null) {
    if (min !== null && max !== null && min > max) [min, max] = [max, min];

    const range = {};
    if (min !== null) range.$gte = min;
    if (max !== null) range.$lte = max;
    ands.push({ followers: range });
  }

  const countryTokens = normalizeCountryTokens(parseMultiValue(input.countries || input.country));
  if (countryTokens.length) {
    ands.push({ country: { $in: countryTokens.map(exactCI) } });
  }

  const categories = parseMultiValue(
    input.categories ||
    input.category ||
    input.niche ||
    input.niches ||
    input.category_name ||
    input.categoryName
  );
  if (categories.length) {
    const categoryRegexes = categories.map((x) => containsCI(x));
    ands.push({
      $or: [
        { categories: { $elemMatch: { categoryName: { $in: categoryRegexes } } } },
        { categories: { $elemMatch: { subcategoryName: { $in: categoryRegexes } } } },
      ],
    });
  }

  const requireLinked = cleanStr(input.requireLinked || '0') === '1';
  if (requireLinked) {
    ands.push({
      $or: [
        { influencer: { $exists: true, $ne: null } },
        { influencerId: { $exists: true, $ne: '' } },
      ],
    });
  }

  const requireCategories = cleanStr(input.requireCategories || '0') === '1';
  if (requireCategories) {
    ands.push({ 'categories.0': { $exists: true } });
  }

  const q = cleanStr(input.q || input.search || '');
  if (q) {
    const qNoAt = q.replace(/^@/, '').trim();
    const qRx = containsCI(q);
    const qNoAtRx = qNoAt && qNoAt.toLowerCase() !== q.toLowerCase() ? containsCI(qNoAt) : null;

    const ors = [
      { username: qRx },
      { fullname: qRx },
      { handle: qRx },
      { url: qRx },
      { userId: qRx },
      { influencerId: qRx },
      { bio: qRx },
      { country: qRx },
      { state: qRx },
      { city: qRx },
      { categories: { $elemMatch: { categoryName: qRx } } },
      { categories: { $elemMatch: { subcategoryName: qRx } } },
    ];

    if (qNoAtRx) {
      ors.push({ username: qNoAtRx }, { handle: qNoAtRx });
    }

    ands.push({ $or: ors });
  }

  return ands.length ? { $and: ands } : {};
}

function buildSavedSort(sortKey, dirParam) {
  const dir = cleanStr(dirParam).toLowerCase() === 'asc' ? 1 : -1;
  const sort = cleanStr(sortKey || 'updatedAt').toLowerCase();

  if (sort === 'followers') return { followers: dir, updatedAt: -1 };
  if (sort === 'createdat') return { createdAt: dir };
  return { updatedAt: dir };
}

function mapSavedDoc(doc, canShowSensitive = false) {
  const safe = sanitizeModashDocForViewer(doc, canShowSensitive);
  const categoryNames = categoryNamesFromObjects(safe.categories);

  return {
    ...safe,
    platform: safe.provider,
    category: categoryNames,
    categories: safe.categories || [],
    location: buildLocationLabel(safe.city, safe.state, safe.country) || undefined,
  };
}

function getCategoryStringsFromSearchItem(item) {
  return uniqStrings(
    []
      .concat(asArray(item.categories))
      .concat(asArray(item.category))
      .concat(asArray(item.primaryCategory))
  );
}

function applyLocalSearchFilters(items = [], input = {}) {
  let out = Array.isArray(items) ? items.slice() : [];

  const provider = cleanStr(input.provider || input.platform || '').toLowerCase();
  const platforms = parseMultiValue(input.platforms)
    .map((x) => cleanStr(x).toLowerCase())
    .filter((x) => ALLOWED_PLATFORMS.has(x));

  if (provider && provider !== 'all' && ALLOWED_PLATFORMS.has(provider)) {
    out = out.filter((item) => cleanStr(item.platform).toLowerCase() === provider);
  } else if (platforms.length) {
    out = out.filter((item) => platforms.includes(cleanStr(item.platform).toLowerCase()));
  }

  const followersMin =
    input.followersMin ?? input.followers_min ?? input.minFollowers ?? input.min_followers;
  const followersMax =
    input.followersMax ?? input.followers_max ?? input.maxFollowers ?? input.max_followers;

  let min = parseFlexibleNumber(followersMin);
  let max = parseFlexibleNumber(followersMax);
  if (min !== null || max !== null) {
    if (min !== null && max !== null && min > max) [min, max] = [max, min];

    out = out.filter((item) => {
      const f = Number(item.followers || 0);
      if (min !== null && f < min) return false;
      if (max !== null && f > max) return false;
      return true;
    });
  }

  const countries = normalizeCountryTokens(parseMultiValue(input.countries || input.country)).map((x) => x.toLowerCase());
  if (countries.length) {
    out = out.filter((item) => countries.includes(cleanStr(item.country).toLowerCase()));
  }

  const categories = parseMultiValue(
    input.categories || input.category || input.niche || input.niches || input.category_name || input.categoryName
  ).map((x) => x.toLowerCase());
  if (categories.length) {
    out = out.filter((item) => {
      const hay = getCategoryStringsFromSearchItem(item).map((x) => cleanStr(x).toLowerCase());
      return categories.some((cat) => hay.some((value) => value.includes(cat)));
    });
  }

  const q = cleanStr(input.q || input.search || '').replace(/^@/, '').toLowerCase();
  if (q) {
    out = out.filter((item) => {
      const hay = [
        item.username,
        item.handle,
        item.fullname,
        item.url,
        item.userId,
        item.bio,
        item.country,
        item.state,
        item.city,
        ...getCategoryStringsFromSearchItem(item),
      ]
        .map((x) => cleanStr(x).toLowerCase())
        .filter(Boolean);

      return hay.some((value) => value.includes(q));
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*                               Controllers                                  */
/* -------------------------------------------------------------------------- */

async function frontendUsers(req, res) {
  try {
    const { page, limit } = parsePagination(req.query.page, req.query.limit, {
      page: 0,
      limit: 20,
      maxLimit: MAX_LIST_LIMIT,
    });

    const qParam = cleanStr(req.query.q || '');
    const queries = qParam
      .split(',')
      .map((s) => s.replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean);

    const platforms = normalizePlatforms(req.query.platform, req.query.platforms);
    const effectivePlatforms = platforms.length ? platforms : ['instagram', 'youtube', 'tiktok'];

    const strict = req.query.strict === '1' || req.query.strict === 'true';
    const matchMode = cleanStr(req.query.match || 'exact-first').toLowerCase();

    if (!queries.length) {
      return res.status(400).json({
        error: 'Provide ?q=<handle>[,handle...]',
      });
    }

    const collected = [];

    for (const platform of effectivePlatforms) {
      for (const q of queries) {
        const data = await modashGET(`/${platform}/users`, {
          limit: Math.max(25, limit * 3),
          query: q,
        });

        const users = Array.isArray(data && data.users) ? data.users : [];
        for (const raw of users) {
          const u = normalizeSearchItem(raw, platform);
          if (!u.username && !u.url) continue;
          collected.push({ ...u, __score: scoreForQuery(u, q) });
        }
      }
    }

    let results = dedupeByBest(collected);

    if (strict || matchMode === 'exact') {
      const qset = new Set(queries);
      results = results.filter((u) => {
        const uname = String(u.username || u.handle || '').toLowerCase();
        const url = String(u.url || '').toLowerCase();
        if (qset.has(uname)) return true;
        for (const q of qset) {
          if (url.indexOf(`/@${q}`) !== -1) return true;
        }
        return false;
      });
    }

    results.sort((a, b) => {
      const scoreDiff = (b.__score || 0) - (a.__score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      if (!!b.isVerified !== !!a.isVerified) return b.isVerified ? 1 : -1;
      if ((b.followers || 0) !== (a.followers || 0)) return (b.followers || 0) - (a.followers || 0);
      return String(a.username || '').localeCompare(String(b.username || ''));
    });

    const safeResults = results.map(({ __score, ...rest }) => rest);
    const cachedEnriched = await enrichResultsFromCache(safeResults);
    const filtered = applyLocalSearchFilters(cachedEnriched, req.query);

    const total = filtered.length;
    const paged = filtered.slice(page * limit, page * limit + limit);

    return res.json({ page, limit, total, results: paged });
  } catch (err) {
    const safe = buildSafeErrorMessage(err, 'Lookup failed');
    const status = (err && err.status) || 400;
    await saveErrorLog(req, err, status, "FRONTEND_USERS_ERROR");
    return res.status(status).json({ error: safe });
  }
}

async function frontendSearch(req, res) {
  try {
    const payload = req.body || {};
    const brandId = cleanStr(payload.brandId || payload.brand_id || '');

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required for search' });
    }

    try {
      await ensureSearchQuota(brandId);
    } catch (e) {
      if (e.code === 'QUOTA_EXCEEDED') {
        await saveErrorLog(req, e, 403, "FRONTEND_SEARCH_ERROR");
        return res.status(403).json({
          error: 'You have reached your monthly search limit.',
          meta: e.meta,
        });
      }
      throw e;
    }

    const platforms = Array.isArray(payload.platforms) ? payload.platforms : [];
    const body = payload.body || {};

    if (!platforms.length || !body) {
      return res.status(400).json({ error: 'Provide { brandId, platforms, body }' });
    }

    const responses = [];

    for (const rawPlatform of platforms) {
      const platform = normalizePlatform(rawPlatform);
      if (!platform) {
        return res.status(400).json({ error: `Unsupported platform: ${rawPlatform}` });
      }

      const firstBody = buildPlatformBody(platform, body);
      let data = await modashPOST(`/${platform}/search`, firstBody);

      const enableFallback = (process.env.MODASH_YT_FALLBACK || '1') !== '0';
      if (platform === 'youtube' && enableFallback && Number((data && data.total) || 0) === 0) {
        const retryBody = buildPlatformBody(platform, body, { relax: true });
        try {
          const retryData = await modashPOST(`/${platform}/search`, retryBody);
          if (retryData && Number((retryData && retryData.total) || 0) > 0) {
            data = retryData;
          }
        } catch {
          // ignore youtube fallback retry errors
        }
      }

      responses.push({ platform, data });
    }

    const collected = [];
    for (const { platform, data } of responses) {
      const bag = []
        .concat(Array.isArray(data && data.results) ? data.results : [])
        .concat(Array.isArray(data && data.items) ? data.items : [])
        .concat(Array.isArray(data && data.influencers) ? data.influencers : [])
        .concat(Array.isArray(data && data.directs) ? data.directs : [])
        .concat(Array.isArray(data && data.lookalikes) ? data.lookalikes : [])
        .concat(Array.isArray(data && data.users) ? data.users : [])
        .concat(Array.isArray(data && data.channels) ? data.channels : []);

      for (const item of bag) {
        collected.push(normalizeSearchItem(item, platform));
      }
    }

    const merged = dedupeSearchItems(collected);
    const cachedEnriched = await enrichResultsFromCache(merged);

    const total = responses.reduce((sum, r) => sum + Number((r.data && r.data.total) || 0), 0);

    return res.json({
      results: cachedEnriched,
      total,
      unique: cachedEnriched.length,
    });
  } catch (err) {
    const safe = buildSafeErrorMessage(err, 'Search failed');
    const status = (err && err.status) || 400;
    await saveErrorLog(req, err, status, "FRONTEND_SEARCH_ERROR");
    return res.status(status).json({ error: safe });
  }
}

async function frontendReportPreview(req, res) {
  try {
    const adminId = cleanStr(req.query.adminId || req.query.admin_id || "");
    const canShowSensitive = !!adminId;

    const platform = normalizePlatform(req.query.platform || "");
    const requestedUserId = cleanStr(req.query.userId || "");
    const requestedHandle = cleanStr(
      req.query.handle || req.query.username || req.query.userName || ""
    ).replace(/^@/, "");
    const rawHandle = cleanStr(req.query.handle || req.query.username || "");
    const username = rawHandle.replace(/^@/, "");

    if (!platform) {
      return res
        .status(400)
        .json({ error: "platform must be instagram|tiktok|youtube" });
    }

    if (!requestedUserId && !username) {
      return res.status(400).json({
        error: "userId, handle, or username is required",
      });
    }

    const or = [];

    if (requestedUserId) {
      if (mongoose.Types.ObjectId.isValid(requestedUserId)) {
        or.push({ _id: new mongoose.Types.ObjectId(requestedUserId) });
      }

      or.push({ userId: requestedUserId });
    }

    if (username) {
      or.push({ username: exactCI(username) });
      or.push({ handle: exactCI(username) });
      or.push({ handle: exactCI(`@${username}`) });
    }

    const doc = await ModashProfile.findOne({
      provider: platform,
      $or: or,
    }).lean();

    if (!doc) {
      return res.status(404).json({
        error: "Cached report not available",
        cacheOnly: true,
      });
    }

    const lastFetchedAt = doc.lastFetchedAt || doc.updatedAt || doc.createdAt || null;

    if (doc.providerRaw) {
      const out = sanitizeModashReportForViewer(
        Object.assign({}, doc.providerRaw),
        canShowSensitive
      );

      out._cacheOnly = true;
      out._source = "cache";
      out._modashProfileId = String(doc._id);

      if (lastFetchedAt) {
        const d = new Date(lastFetchedAt);
        if (!isNaN(d.getTime())) {
          out._lastFetchedAt = d.toISOString();
        }
      }

      return res.json(out);
    }

    return res.json({
      _cacheOnly: true,
      _source: "modash-profile-cache",
      _modashProfileId: String(doc._id),
      _lastFetchedAt: lastFetchedAt ? new Date(lastFetchedAt).toISOString() : null,
      profile: {
        userId: doc.userId || null,
        username: cleanStr(doc.username).replace(/^@/, "") || null,
        handle:
          cleanStr(doc.handle) ||
          (doc.username ? `@${cleanStr(doc.username).replace(/^@/, "")}` : null),
        fullname: doc.fullname || null,
        url: doc.url || null,
        picture: doc.picture || null,
        followers: doc.followers || null,
        engagements: doc.engagements || null,
        engagementRate: doc.engagementRate || null,
        averageViews: doc.averageViews || null,
        bio: doc.bio || "",
        country: doc.country || null,
        state: doc.state || null,
        city: doc.city || null,
        isVerified: doc.isVerified,
        isPrivate: doc.isPrivate,
        audience: doc.audience || null,
        recentPosts: Array.isArray(doc.recentPosts) ? doc.recentPosts : [],
        popularPosts: Array.isArray(doc.popularPosts) ? doc.popularPosts : [],
      },
      bio: doc.bio || "",
      country: doc.country || null,
      state: doc.state || null,
      city: doc.city || null,
      audience: doc.audience || null,
      recentPosts: Array.isArray(doc.recentPosts) ? doc.recentPosts : [],
      popularPosts: Array.isArray(doc.popularPosts) ? doc.popularPosts : [],
    });
  } catch (err) {
    console.error("[frontendReportPreview] Error:", err);
    await saveErrorLog(req, err, 500, "FRONTEND_REPORT_PREVIEW_ERROR");
    return res.status(500).json({
      error: (err && err.message) || "Failed to load cached report",
    });
  }
}

async function frontendReport(req, res) {
  try {
    const brandId = cleanStr(req.query.brandId || req.query.brand_id || '');
    const adminId = cleanStr(req.query.adminId || req.query.admin_id || '');
    const isAdmin = !!adminId;
    const canShowSensitive = !!cleanStr(adminId);

    const isProfile =
      req.query.isProfile === '1' ||
      req.query.isProfile === 'true' ||
      req.query.isProfile === true;

    const skipProfileCredit =
      isProfile ||
      req.query.np === '1' ||
      req.query.np === 'true' ||
      req.query.noProfileCredit === '1' ||
      req.query.noProfileCredit === 'true';

    if (!skipProfileCredit && !brandId && !adminId) {
      return res
        .status(400)
        .json({ error: 'brandId or adminId is required for profile views' });
    }

    const platform = normalizePlatform(req.query.platform || '');
    const requestedUserId = cleanStr(req.query.userId || '');

    const requestedHandle = cleanStr(
      req.query.handle ||
      req.query.username ||
      req.query.userName ||
      ''
    ).replace(/^@/, '');

    const calculationMethod = toCalcMethod(req.query.calculationMethod);
    let influencerId =
      cleanStr(req.query.influencerId || req.query.influencer_id || '') || null;

    const forceFresh =
      req.query.force === '1' ||
      req.query.force === 'true' ||
      req.query.refresh === '1' ||
      req.query.refresh === 'true';

    if (!platform) {
      return res
        .status(400)
        .json({ error: 'platform must be instagram|tiktok|youtube' });
    }

    if (!requestedUserId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    let resolvedUserId = requestedUserId;

    if (mongoose.Types.ObjectId.isValid(requestedUserId)) {
      try {
        const localDoc = await ModashProfile.findOne({
          _id: requestedUserId,
          provider: platform,
        })
          .select({
            userId: 1,
            influencerId: 1,
          })
          .lean();

        if (localDoc?.userId) {
          resolvedUserId = cleanStr(localDoc.userId);
          if (!influencerId && localDoc.influencerId) {
            influencerId = cleanStr(localDoc.influencerId);
          }
        }
      } catch (resolveErr) {
        console.error(
          '[frontendReport] Failed to resolve local Modash _id:',
          resolveErr
        );
      }
    }

    const now = new Date();
    const periodKey = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1
    ).padStart(2, '0')}`;

    const shouldChargeProfileView =
      !skipProfileCredit && !isAdmin && !!brandId;

    let alreadyViewedThisPeriod = false;

    if (shouldChargeProfileView) {
      try {
        const existingView = await BrandProfileView.findOne({
          brandId,
          platform,
          userId: resolvedUserId,
          periodKey,
        }).lean();

        alreadyViewedThisPeriod = !!existingView;
      } catch (e) {
        console.error(
          '[frontendReport] Failed to check BrandProfileView:',
          e.message
        );
      }
    }

    if (!forceFresh) {
      try {
        const cached = await findCachedReport({
          platform,
          userId: resolvedUserId,
          influencerId,
        });

        if (cached && cached.providerRaw) {
          const out = sanitizeModashReportForViewer(
            Object.assign({}, cached.providerRaw),
            canShowSensitive
          );

          if (cached.lastFetchedAt) {
            const d = new Date(cached.lastFetchedAt);
            if (!isNaN(d.getTime())) {
              out._lastFetchedAt = d.toISOString();
            }
          }

          if (cached._id) {
            out._modashProfileId = String(cached._id);
          }

          // try {
          //   await chargeProfileViewAfterSuccess({
          //     shouldChargeProfileView,
          //     alreadyViewedThisPeriod,
          //     brandId,
          //     platform,
          //     userId: resolvedUserId,
          //     influencerId,
          //     periodKey,
          //     at: now,
          //   });
          // } catch (e) {
          //   if (e.status === 403 || e.code === 'QUOTA_EXCEEDED') {
          //     await saveErrorLog(req, e, 403, "FRONTEND_REPORT_ERROR");
          //     return res.status(403).json({
          //       error: 'You have reached your monthly profile view limit.',
          //       meta: e.meta,
          //     });
          //   }

          //   throw e;
          // }

          return res.json(out);
        }
      } catch (cacheErr) {
        console.error(
          '[frontendReport] Cache lookup failed:',
          cacheErr.message
        );
      }
    }

    let reportJSON;

    try {
      reportJSON = await modashGET(
        `/${platform}/profile/${encodeURIComponent(resolvedUserId)}/report`,
        { calculationMethod }
      );
    } catch (firstErr) {
      let fallbackErr = firstErr;

      if (requestedHandle) {
        try {
          const resolved = await searchForUsername(platform, requestedHandle);

          if (resolved?.userId && cleanStr(resolved.userId) !== cleanStr(resolvedUserId)) {
            resolvedUserId = cleanStr(resolved.userId);

            reportJSON = await modashGET(
              `/${platform}/profile/${encodeURIComponent(resolvedUserId)}/report`,
              { calculationMethod }
            );
          }
        } catch (retryErr) {
          fallbackErr = retryErr;
        }
      }

      if (!reportJSON) {
        const raw = (fallbackErr && fallbackErr.message) || "";
        let safeMsg = "Report unavailable";

        try {
          const errResp = fallbackErr && fallbackErr.response;
          const rawMsg = (errResp && (errResp.message || errResp.error)) || raw;

          const isSensitive =
            /api token|developer section|modash|authorization|bearer|modash_api_key|marketer\.modash\.io/i.test(
              String(rawMsg)
            );

          safeMsg = isSensitive ? "Report unavailable" : rawMsg || safeMsg;

          console.error("[frontendReport] Modash report failed", {
            platform,
            requestedUserId,
            requestedHandle,
            resolvedUserId,
            status: fallbackErr?.status,
            message: rawMsg,
          });
        } catch {
          console.error("[frontendReport] Modash report failed", fallbackErr);
        }

        const status = fallbackErr && fallbackErr.status ? fallbackErr.status : 502;

        if (status === 401 || status === 403) {
          await saveErrorLog(req, firstErr, 502, "FRONTEND_REPORT_ERROR");
          return res.status(502).json({
            error:
              "Modash API authentication failed. Please verify MODASH_API_KEY and MODASH_AUTH_HEADER in backend .env.",
          });
        }

        await saveErrorLog(req, firstErr, status, "FRONTEND_REPORT_ERROR");

        return res.status(status).json({ error: safeMsg });
      }
    }

    const fetchedAt = new Date();

    let savedModashProfile = null;

    try {
      const normalized = normalizeReportData(reportJSON);

      savedModashProfile = await upsertModashProfileFromReport2(normalized, platform, {
        userIdFromRequest: resolvedUserId,
        influencerId,
        handle: requestedHandle,
      });
    } catch (saveErr) {
      console.error(
        '[frontendReport] Failed to save Modash profile to database:',
        saveErr
      );
    }

    const out = sanitizeModashReportForViewer(
      Object.assign({}, reportJSON, {
        _lastFetchedAt: fetchedAt.toISOString(),
        _modashProfileId: savedModashProfile?._id
          ? String(savedModashProfile._id)
          : undefined,
      }),
      canShowSensitive
    );

    // try {
    //   await chargeProfileViewAfterSuccess({
    //     shouldChargeProfileView,
    //     alreadyViewedThisPeriod,
    //     brandId,
    //     platform,
    //     userId: resolvedUserId,
    //     influencerId,
    //     periodKey,
    //     at: fetchedAt,
    //   });
    // } catch (e) {
    //   if (e.status === 403 || e.code === 'QUOTA_EXCEEDED') {
    //     await saveErrorLog(req, e, 403, "FRONTEND_REPORT_ERROR");
    //     return res.status(403).json({
    //       error: 'You have reached your monthly profile view limit.',
    //       meta: e.meta,
    //     });
    //   }

    //   throw e;
    // }

    return res.json(out);
  } catch (err) {
    console.error('[frontendReport] Unexpected error:', err);
    return res
      .status(500)
      .json({ error: (err && err.message) || 'Internal error' });
  }
}

/* -------------------------------------------------------------------------- */
/*                           Legacy resolve/search                            */
/* -------------------------------------------------------------------------- */

async function searchForUsername(platform, username) {
  const clean = cleanStr(username).replace(/^@/, '');
  if (!clean) return null;

  const body = {
    page: 1,
    calculationMethod: 'median',
    sort: { field: 'relevance', direction: 'desc' },
    filter: { influencer: { relevance: [`@${clean}`] } },
  };

  const result = await modashPOST(`/${platform}/search`, body);
  const candidates = []
    .concat(Array.isArray(result && result.directs) ? result.directs : [])
    .concat(Array.isArray(result && result.lookalikes) ? result.lookalikes : []);

  if (!candidates.length) return null;

  const target =
    candidates.find((it) => {
      const prof = (it && it.profile) || {};
      const u = cleanStr(prof.username).toLowerCase();
      const h = cleanStr(prof.handle).toLowerCase().replace(/^@/, '');
      const c = clean.toLowerCase();
      return u === c || h === c;
    }) || candidates[0];

  if (!target) return null;

  const prof = (target && target.profile) || {};
  const id = target.userId || prof.userId;
  if (!id) return null;

  return {
    userId: String(id),
    username: cleanStr(prof.username),
    handle: cleanStr(prof.handle),
    picture: prof.picture,
    url: prof.url,
    followers: prof.followers,
  };
}

async function getReportLegacy(platform, userIdOrHandle) {
  const id = cleanStr(userIdOrHandle);
  return modashGET(`/${platform}/profile/${encodeURIComponent(id)}/report`, {
    calculationMethod: 'median',
  });
}

function buildPreviewFromReport(reportJSON) {
  const p = (reportJSON && reportJSON.profile) || {};
  const prof = p.profile || p;
  return {
    fullname: prof.fullname || null,
    username: prof.username || null,
    followers: typeof prof.followers === 'number' ? prof.followers : null,
    picture: prof.picture || null,
    url: prof.url || null,
  };
}

async function resolveProfile(req, res) {
  try {
    const platform = normalizePlatform((req.body && req.body.platform) || '');
    let username = cleanStr((req.body && req.body.username) || '');
    let handle = cleanStr((req.body && req.body.handle) || username || '');

    if (username.startsWith('@')) username = username.slice(1);
    if (handle.startsWith('@')) handle = handle.slice(1);

    if (!username && handle) username = handle;
    if (!handle && username) handle = username;

    if (!platform) {
      return res.status(400).json({ message: 'platform must be instagram | youtube | tiktok' });
    }

    if (!username) {
      return res.status(400).json({ message: 'username (handle) is required' });
    }

    // BLOCK if same provider + handle already exists
    const existingProfile = await ModashProfile.findOne({
      provider: platform,
      $or: [{ handle }, { username: handle }, { 'profile.username': handle }],
    }).select('_id provider userId handle username');

    if (existingProfile) {
      return res.status(409).json({
        message: 'Profile already exists. We cannot update an existing profile with the same handle and provider.',
        provider: platform,
        handle,
        userId: existingProfile.userId || null,
      });
    }

    let reportJSON = null;
    let userIdResolved = null;

    try {
      reportJSON = await getReportLegacy(platform, username);
      userIdResolved =
        (reportJSON &&
          reportJSON.profile &&
          (reportJSON.profile.userId ||
            (reportJSON.profile.profile && reportJSON.profile.profile.userId))) ||
        null;
    } catch (e) {
      if (e && e.status === 403) {
        await saveErrorLog(req, e, 403, "RESOLVE_PROFILE_ERROR");
        return res.status(403).json({
          message: 'Forbidden from Modash. Verify your API key / header type and plan.',
          details: e.response || undefined,
        });
      }
      if (!e || (e.status !== 404 && e.status !== 400)) throw e;
    }

    if (!reportJSON) {
      const hit = await searchForUsername(platform, username);
      if (!hit || !hit.userId) {
        return res.status(404).json({ message: 'No profile found for that username' });
      }

      userIdResolved = hit.userId;

      try {
        reportJSON = await getReportLegacy(platform, userIdResolved);
      } catch (e) {
        if (e && e.status === 403) {
          await saveErrorLog(req, e, 403, "RESOLVE_PROFILE_ERROR");
          return res.status(403).json({
            message: 'Forbidden from Modash when fetching report.',
            details: e.response || undefined,
          });
        }
        throw e;
      }
    }

    const normalized = normalizeReportData(reportJSON);
    normalized.profile = normalized.profile || {};
    normalized.profile.handle = handle;
    normalized.profile.username = normalized.profile.username || username;

    const preview = buildPreviewFromReport(reportJSON);

    // SAVE directly so duplicate error can be returned properly
    await upsertModashProfileFromReport2(normalized, platform, {
      userIdFromRequest: userIdResolved || username,
      handle,
    });

    return res.json({
      message: 'ok',
      provider: platform,
      handle,
      userId: userIdResolved || (normalized.profile && normalized.profile.userId) || null,
      preview,
      providerRaw: reportJSON,
      data: normalized,
    });
  } catch (e) {
    if (e && e.status === 409) {
      await saveErrorLog(req, e, 409, "RESOLVE_PROFILE_ERROR");
      return res.status(409).json({
        message: e.message || 'Profile already exists',
        ...(e.details || {}),
      });
    }

    if (e && e.status === 403) {
      await saveErrorLog(req, e, 403, "RESOLVE_PROFILE_ERROR");
      return res.status(403).json({
        message: 'Forbidden from Modash.',
        details: e.response || undefined,
      });
    }

    if (e && e.status === 404) {
      await saveErrorLog(req, e, 404, "RESOLVE_PROFILE_ERROR");
      return res.status(404).json({ message: 'No profile found' });
    }

    console.error('resolveProfile error:', e);
    await saveErrorLog(req, e, 500, "RESOLVE_PROFILE_ERROR");
    return res.status(500).json({ message: (e && e.message) || 'Modash error' });
  }
}

async function legacySearch(req, res) {
  try {
    const platform = normalizePlatform(cleanStr((req.body && req.body.platform) || ''));
    if (!platform) {
      return res.status(400).json({ message: 'platform must be instagram | youtube | tiktok' });
    }

    const body = Object.assign({}, req.body);
    delete body.platform;

    const data = await modashPOST(`/${platform}/search`, body || {});
    return res.json(data);
  } catch (e) {
    if (e && e.status === 403) {
      await saveErrorLog(req, e, 403, "LEGACY_SEARCH_ERROR");
      return res.status(403).json({ message: 'Forbidden from Modash', details: e.response || undefined });
    }

    await saveErrorLog(req, e, 500, "LEGACY_SEARCH_ERROR");

    return res.status(500).json({ message: (e && e.message) || 'Modash error' });
  }
}

/* -------------------------------------------------------------------------- */
/*                         Saved / random / export                            */
/* -------------------------------------------------------------------------- */

function influencerTierFromFollowers(followers) {
  const f = Number(followers || 0);
  if (f < 10000) return { key: 'nano', label: 'Nano (0-10K)' };
  if (f < 100000) return { key: 'micro', label: 'Micro (10K-100K)' };
  if (f < 500000) return { key: 'mid', label: 'Mid (100K-500K)' };
  if (f < 1000000) return { key: 'macro', label: 'Macro (500K-1M)' };
  return { key: 'mega', label: 'Mega (1M+)' };
}

function groupCategories(categoryLinks) {
  const links = Array.isArray(categoryLinks) ? categoryLinks : [];
  const catMap = new Map();

  for (const c of links) {
    if (!c) continue;

    const categoryId = c.categoryId;
    const categoryName = cleanStr(c.categoryName);
    const subcategoryId = cleanStr(c.subcategoryId);
    const subcategoryName = cleanStr(c.subcategoryName);
    const key = String(categoryId ?? categoryName ?? '');
    if (!key) continue;

    if (!catMap.has(key)) {
      catMap.set(key, {
        categoryId: categoryId ?? null,
        categoryName: categoryName || null,
        subcategories: [],
      });
    }

    if (subcategoryId || subcategoryName) {
      const obj = catMap.get(key);
      const exists = obj.subcategories.some((s) => String(s.subcategoryId) === String(subcategoryId));
      if (!exists) {
        obj.subcategories.push({
          subcategoryId: subcategoryId || null,
          subcategoryName: subcategoryName || null,
        });
      }
    }
  }

  return Array.from(catMap.values());
}

async function getSavedInfluencers(req, res) {
  try {
    const { page, limit } = parsePagination(req.query.page, req.query.limit, {
      page: 0,
      limit: 20,
      maxLimit: MAX_LIST_LIMIT,
    });

    const adminId = cleanStr(req.query.adminId || req.query.admin_id || '');
    const canShowSensitive = canShowSensitiveFromRequest(req, { adminId });

    const filter = buildSavedInfluencerMongoFilter(req.query);
    const sort = buildSavedSort(req.query.sort, req.query.dir);

    const projection = {
      provider: 1,
      userId: 1,
      username: 1,
      fullname: 1,
      handle: 1,
      url: 1,
      picture: 1,
      followers: 1,
      engagements: 1,
      engagementRate: 1,
      averageViews: 1,
      isVerified: 1,
      isPrivate: 1,
      accountType: 1,
      secUid: 1,

      city: 1,
      state: 1,
      subdivision: 1,
      country: 1,
      gender: 1,
      ageGroup: 1,
      language: 1,
      bio: 1,
      description: 1,

      postsCount: 1,
      postsCounts: 1,
      avgLikes: 1,
      avgComments: 1,
      avgViews: 1,
      avgReelsPlays: 1,
      totalLikes: 1,
      totalViews: 1,

      stats: 1,
      statsByContentType: 1,

      categories: 1,
      hashtags: 1,
      mentions: 1,
      brandAffinity: 1,
      interests: 1,
      contacts: 1,

      audience: 1,
      audienceCommenters: 1,
      audienceExtra: 1,
      lookalikes: 1,

      recentPosts: 1,
      popularPosts: 1,
      sponsoredPosts: 1,
      statHistory: 1,

      paidPostPerformance: 1,
      paidPostPerformanceViews: 1,
      sponsoredPostsMedianViews: 1,
      sponsoredPostsMedianLikes: 1,
      nonSponsoredPostsMedianViews: 1,
      nonSponsoredPostsMedianLikes: 1,

      providerRaw: 1,
      influencerId: 1,
      influencer: 1,
      createdAt: 1,
      updatedAt: 1,
    };

    const [docs, total] = await Promise.all([
      ModashProfile.find(filter)
        .select(projection)
        .sort(sort)
        .skip(page * limit)
        .limit(limit)
        .lean(),
      ModashProfile.countDocuments(filter),
    ]);

    return res.json({
      page,
      limit,
      total,
      results: docs.map((doc) => mapSavedDoc(doc, canShowSensitive)),
    });
  } catch (err) {
    console.error('[getSavedInfluencers] Error:', err);
    await saveErrorLog(req, err, 500, "GET_SAVED_INFLUENCERS_ERROR");
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function getRandomInfluencers(req, res) {
  try {
    const limitRaw = parseInt(req.query.limit, 10);
    const limit = Math.min(MAX_RANDOM_LIMIT, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 10));

    const provider = normalizePlatform(req.query.provider || req.query.platform || '');
    if ((req.query.provider || req.query.platform) && !provider) {
      return res.status(400).json({ error: 'provider must be instagram|tiktok|youtube' });
    }

    const minFollowers = Number.isFinite(Number(req.query.minFollowers)) ? Number(req.query.minFollowers) : undefined;
    const maxFollowers = Number.isFinite(Number(req.query.maxFollowers)) ? Number(req.query.maxFollowers) : undefined;
    const requireLinked = cleanStr(req.query.requireLinked || '0') === '1';
    const requireCategories = cleanStr(req.query.requireCategories || '0') === '1';

    const match = {};
    if (provider) match.provider = provider;

    if (minFollowers !== undefined || maxFollowers !== undefined) {
      match.followers = {};
      if (minFollowers !== undefined) match.followers.$gte = minFollowers;
      if (maxFollowers !== undefined) match.followers.$lte = maxFollowers;
    }

    if (requireLinked) {
      match.$or = [
        { influencer: { $exists: true, $ne: null } },
        { influencerId: { $exists: true, $ne: '' } },
      ];
    }

    if (requireCategories) {
      match['categories.0'] = { $exists: true };
    }

    const pipeline = [
      { $match: match },
      { $sample: { size: limit } },
      {
        $project: {
          _id: 1,
          influencer: 1,
          influencerId: 1,
          provider: 1,
          userId: 1,
          fullname: 1,
          username: 1,
          handle: 1,
          url: 1,
          picture: 1,
          followers: 1,
          engagementRate: 1,
          engagements: 1,
          averageViews: 1,
          isVerified: 1,
          isPrivate: 1,
          country: 1,
          state: 1,
          city: 1,
          categories: 1,
          updatedAt: 1,
        },
      },
    ];

    const rows = await ModashProfile.aggregate(pipeline);
    const results = rows.map((r) => {
      const username = cleanStr(r.username).replace(/^@/, '');
      const handle = cleanStr(r.handle || (username ? `@${username}` : ''));
      const followers = Number(r.followers || 0);
      const tier = influencerTierFromFollowers(followers);

      return {
        ids: {
          modashId: String(r._id),
          influencerObjectId: r.influencer ? String(r.influencer) : null,
          influencerId: cleanStr(r.influencerId) || null,
          userId: cleanStr(r.userId) || null,
        },
        name: cleanStr(r.fullname) || null,
        username: username || null,
        handle: handle || null,
        platform: cleanStr(r.provider) || null,
        followers,
        tier,
        categories: groupCategories(r.categories),
        picture: cleanStr(r.picture) || null,
        url: cleanStr(r.url) || null,
        isVerified: !!r.isVerified,
        isPrivate: !!r.isPrivate,
        stats: {
          engagementRate: typeof r.engagementRate === 'number' ? r.engagementRate : null,
          engagements: typeof r.engagements === 'number' ? r.engagements : null,
          averageViews: typeof r.averageViews === 'number' ? r.averageViews : null,
        },
        location: {
          country: cleanStr(r.country) || null,
          state: cleanStr(r.state) || null,
          city: cleanStr(r.city) || null,
        },
      };
    });

    return res.json({ count: results.length, results });
  } catch (err) {
    console.error('[getRandomInfluencers] Error:', err);
    await saveErrorLog(req, err, 500, "GET_RANDOM_INFLUENCERS_ERROR");
    return res.status(500).json({ error: 'Internal error' });
  }
}

async function exportSavedInfluencersCsv(req, res) {
  try {
    const body = req.body || {};

    const idsRaw = body.modashIds ?? body.ids ?? body.selectedIds ?? null;
    const selectedIds = Array.isArray(idsRaw)
      ? idsRaw.map((x) => String(x || '').trim()).filter(Boolean)
      : [];

    const requestedLimit = Math.min(
      MAX_EXPORT_LIMIT,
      Math.max(1, parseInt(String(body.limit ?? body.downloadLimit ?? body.count ?? 1000), 10) || 1000)
    );

    const filter = buildSavedInfluencerMongoFilter(body);

    if (selectedIds.length) {
      const objIds = selectedIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      if (!objIds.length) {
        return res.status(400).json({ error: 'No valid modashIds provided.' });
      }

      if (!filter.$and) filter.$and = [];
      filter.$and.push({ _id: { $in: objIds } });
    }

    const sort = buildSavedSort(body.sort || body.sortBy || 'updatedAt', body.dir || body.sortOrder || 'desc');

    const projection = {
      provider: 1,
      userId: 1,
      username: 1,
      fullname: 1,
      handle: 1,
      url: 1,
      followers: 1,
      engagementRate: 1,
      engagements: 1,
      averageViews: 1,
      country: 1,
      language: 1,
      categories: 1,
      createdAt: 1,
      updatedAt: 1,
      influencerId: 1,
    };

    const limit = selectedIds.length ? Math.min(MAX_EXPORT_LIMIT, selectedIds.length) : requestedLimit;

    let items = await ModashProfile.find(filter).select(projection).sort(sort).limit(limit).lean();

    if (selectedIds.length) {
      const rank = new Map(selectedIds.map((id, idx) => [String(id), idx]));
      items.sort((a, b) => {
        const ra = rank.get(String(a._id)) ?? 999999;
        const rb = rank.get(String(b._id)) ?? 999999;
        return ra - rb;
      });
    }

    const dash = '--';
    const csvEscape = (v) => {
      const s = String(v ?? '');
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const fmt = (v) => (v == null || v === '' ? dash : String(v));
    const fmtNum = (v) => (v == null || Number.isNaN(Number(v)) ? dash : String(v));
    const fmtPercent = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dash;
      return `${(n * 100).toFixed(2)}%`;
    };

    const getUsernameNoAt = (doc) => cleanStr(doc.username || doc.handle || '').replace(/^@/, '');
    const getHandleAt = (doc) => {
      const u = getUsernameNoAt(doc);
      return u ? `@${u}` : dash;
    };

    const getLang = (doc) => {
      const l = doc.language;
      if (!l) return dash;
      if (typeof l === 'string') return l || dash;
      if (typeof l === 'object') return cleanStr(l.name) || cleanStr(l.code) || dash;
      return dash;
    };

    const getLinks = (doc) => {
      const u = getUsernameNoAt(doc);
      const prov = cleanStr(doc.provider).toLowerCase();
      const rawUrl = cleanStr(doc.url);

      const yt =
        prov === 'youtube'
          ? rawUrl ||
          (doc.userId
            ? `https://www.youtube.com/channel/${doc.userId}`
            : u
              ? `https://www.youtube.com/@${u}`
              : dash)
          : dash;

      const ig = prov === 'instagram' ? rawUrl || (u ? `https://www.instagram.com/${u}` : dash) : dash;
      const tt = prov === 'tiktok' ? rawUrl || (u ? `https://www.tiktok.com/@${u}` : dash) : dash;

      return { yt, ig, tt };
    };

    const getNiche = (doc) => {
      const cats = Array.isArray(doc.categories) ? doc.categories : [];
      const first = cats[0] || null;
      const name = cleanStr(first?.categoryName || first?.name || '');
      return name || dash;
    };

    const getSubNiche = (doc) => {
      const cats = Array.isArray(doc.categories) ? doc.categories : [];
      const first = cats[0] || null;
      const sub = cleanStr(first?.subcategoryName || first?.subName || first?.subcategory || '');
      return sub || dash;
    };

    const header = [
      'Sr. No.',
      'Handle Title',
      'Influencer Handle',
      'Email',
      'Phone',
      'YouTube Handle link',
      'Instagram Handle link',
      'TikTok Handle link',
      'Country/Region',
      'Language',
      'Niche',
      'Sub-Niche',
      'Subscriber/Follower count',
      'Avg Views (last 15 videos)',
      'Engagement Rate',
      'Upload Frequency',
      'Last Sponsor',
      'Managed by Any Agency',
      'Top Audience Country',
      'Average Audience Age',
      'CollabGlam Demographics link',
      'Last Contacted Date',
      'Last Working Handle',
      'Last 1st followup date',
      'Last 2nd followup date',
      'Status',
      'Reply',
      'Notes',
    ];

    const lines = [header.map(csvEscape).join(',')];
    items.forEach((doc, idx) => {
      const links = getLinks(doc);
      const row = [
        idx + 1,
        fmt(doc.fullname),
        fmt(getHandleAt(doc)),
        dash,
        dash,
        fmt(links.yt),
        fmt(links.ig),
        fmt(links.tt),
        fmt(doc.country),
        fmt(getLang(doc)),
        fmt(getNiche(doc)),
        fmt(getSubNiche(doc)),
        fmtNum(doc.followers),
        fmtNum(doc.averageViews),
        fmtPercent(doc.engagementRate),
        dash,
        dash,
        dash,
        dash,
        dash,
        dash,
        dash,
        fmt(getHandleAt(doc)),
        dash,
        dash,
        dash,
        dash,
        dash,
      ];
      lines.push(row.map(csvEscape).join(','));
    });

    const csv = lines.join('\n');
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}_${String(ts.getHours()).padStart(2, '0')}${String(ts.getMinutes()).padStart(2, '0')}${String(ts.getSeconds()).padStart(2, '0')}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="modash_saved_${stamp}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[exportSavedInfluencersCsv] Error:', err);
    await saveErrorLog(req, err, 500, "EXPORT_SAVED_INFLUENCERS_CSV_ERROR");
    return res.status(500).json({ error: err?.message || 'Failed to export CSV' });
  }
}

async function getMediaKitLink(req, res) {
  try {
    const platform = normalizePlatform(req.query.platform || req.body?.platform || '');
    let username = cleanStr(req.query.username || req.body?.username || '').replace(/^@/, '');

    if (!platform) {
      return res.status(400).json({ error: 'platform must be instagram|youtube|tiktok' });
    }

    if (!username) {
      return res.status(400).json({ error: 'username is required' });
    }

    const usernameRx = exactCI(username);
    const handleRx = exactCI(`@${username}`);

    let saved = await ModashProfile.findOne({
      provider: platform,
      $or: [{ username: usernameRx }, { handle: usernameRx }, { handle: handleRx }],
    })
      .select('_id provider userId username handle fullname')
      .lean();

    if (!saved) {
      const hit = await searchForUsername(platform, username);

      if (!hit || !hit.userId) {
        return res.status(404).json({ error: 'Modash profile not found' });
      }

      const reportJSON = await modashGET(
        `/${platform}/profile/${encodeURIComponent(hit.userId)}/report`,
        { calculationMethod: 'median' }
      );

      const normalized = normalizeReportData(reportJSON);

      await upsertModashProfileFromReport(normalized, platform, {
        userIdFromRequest: hit.userId,
      });

      saved = await ModashProfile.findOne({
        provider: platform,
        userId: String(hit.userId),
      })
        .select('_id provider userId username handle fullname')
        .lean();
    }

    if (!saved) {
      return res.status(404).json({ error: 'Unable to create media kit link' });
    }

    const baseUrl = cleanStr(process.env.CAMPAIGN_BASE_URL || 'http://localhost:3000');
    const publicProfileId = encodeURIComponent(cleanStr(saved.userId) || String(saved._id));
    const publicPlatform = encodeURIComponent(cleanStr(saved.provider));
    const link = `${baseUrl}/mediakit/${publicProfileId}?platform=${publicPlatform}&np=1`;

    return res.json({
      success: true,
      data: {
        modashId: String(saved._id),
        userId: cleanStr(saved.userId) || null,
        platform: saved.provider,
        username: saved.username || saved.handle || username,
        link,
      },
    });
  } catch (err) {
    console.error('[getMediaKitLink] Error:', err);
    await saveErrorLog(req, err, 500, "GET_MEDIA_KIT_LINK_ERROR");
    return res.status(500).json({ error: err?.message || 'Failed to generate media kit link' });
  }
}
async function upsertCreator(req, res) {
  try {
    const {
      userId,
      username,
      handle,
      fullname,
      followers,
      engagementRate,
      engagements,
      averageViews,
      picture,
      url,
      isVerified,
      isPrivate,
      platform,
      bio,
      country,
      location,
      categories,
      searchType,
      source,
    } = req.body || {};

    if (!userId || !String(userId).trim()) {
      return res.status(400).json({
        message: "userId is required",
      });
    }

    const payload = {
      userId: String(userId).trim(),
      username: username || "",
      handle: handle || "",
      fullname: fullname || "",
      followers: followers || 0,
      engagementRate: engagementRate || 0,
      engagements: engagements || 0,
      averageViews: averageViews || 0,
      picture: picture || "",
      url: url || "",
      isVerified: isVerified || false,
      isPrivate: isPrivate || false,
      platform: platform || "",
      bio: bio || "",
      country: country || "",
      location: location || "",
      categories: Array.isArray(categories) ? categories : [],
      searchType: searchType || "standard",
      source: source || "standard",
    };

    const creator = await Creator.findOneAndUpdate(
      { userId: payload.userId },
      { $set: payload },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    return res.status(200).json({
      message: "Creator saved successfully",
      data: creator,
    });
  } catch (error) {
    console.error("upsertCreator error:", error);
    await saveErrorLog(req, error, 500, "UPSERT_CREATOR_ERROR");
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
}

async function getCreatorByUserId(req, res) {
  try {
    const { userId } = req.params;

    if (!userId || !String(userId).trim()) {
      return res.status(400).json({
        message: "userId is required",
      });
    }

    const creator = await Creator.findOne({
      userId: String(userId).trim(),
    });

    if (!creator) {
      return res.status(404).json({
        message: "Creator not found",
      });
    }

    return res.status(200).json({
      message: "Creator details fetched successfully",
      data: creator,
    });
  } catch (error) {
    console.error("getCreatorByUserId error:", error);
    await saveErrorLog(req, error, 500, "GET_CREATOR_BY_USER_ID_ERROR");
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
}
function cleanParam(value, fallback = "") {
  try {
    if (value === undefined || value === null) return fallback;

    if (typeof value === "string") {
      const clean = value.trim();
      return clean || fallback;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const clean = cleanParam(item, "");
        if (clean) return clean;
      }
      return fallback;
    }

    if (typeof value === "object") {
      if (value.value !== undefined) return cleanParam(value.value, fallback);
      if (value.query !== undefined) return cleanParam(value.query, fallback);
      if (value.name !== undefined) return cleanParam(value.name, fallback);
      if (value.label !== undefined) return cleanParam(value.label, fallback);
      if (value.title !== undefined) return cleanParam(value.title, fallback);
      if (value.id !== undefined) return cleanParam(value.id, fallback);

      return fallback;
    }

    return fallback;
  } catch {
    return fallback;
  }
}
function cleanParam(value, fallback = "") {
  try {
    if (value === undefined || value === null) return fallback;

    if (typeof value === "string") {
      const clean = value.trim();
      return clean || fallback;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const clean = cleanParam(item, "");
        if (clean) return clean;
      }
      return fallback;
    }

    if (typeof value === "object") {
      if (value.value !== undefined) return cleanParam(value.value, fallback);
      if (value.query !== undefined) return cleanParam(value.query, fallback);
      if (value.name !== undefined) return cleanParam(value.name, fallback);
      if (value.label !== undefined) return cleanParam(value.label, fallback);
      if (value.title !== undefined) return cleanParam(value.title, fallback);
      if (value.id !== undefined) return cleanParam(value.id, fallback);

      return fallback;
    }

    return fallback;
  } catch {
    return fallback;
  }
}

function getUrlParam(req, key, fallback = "") {
  const directValue = req.query && req.query[key];
  const directClean = cleanParam(directValue, "");

  if (directClean) return directClean;

  const rawUrl = cleanParam(req.originalUrl || req.url, "");
  const questionIndex = rawUrl.indexOf("?");

  if (questionIndex === -1) return fallback;

  const queryString = rawUrl.slice(questionIndex + 1);
  if (!queryString) return fallback;

  const parts = queryString.split("&");

  for (const part of parts) {
    const equalIndex = part.indexOf("=");

    const rawKey = equalIndex === -1 ? part : part.slice(0, equalIndex);
    const rawValue = equalIndex === -1 ? "" : part.slice(equalIndex + 1);

    if (decodeURIComponent(rawKey) === key) {
      return decodeURIComponent(rawValue || "").trim() || fallback;
    }
  }

  return fallback;
}

function safeNumber(value, fallback = 20) {
  const cleanValue = cleanParam(value, String(fallback));
  const numberValue = parseInt(cleanValue, 10);

  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return fallback;
  }

  return numberValue;
}

function getModashBaseUrl() {
  const baseUrl = cleanParam(
    process.env.MODASH_BASE_URL,
    "https://api.modash.io/v1"
  );

  return baseUrl.replace(/\/+$/, "");
}

function normalizeModashPlatform(platform) {
  const cleanPlatform = cleanParam(platform, "tiktok").toLowerCase();

  const allowedPlatforms = ["tiktok", "instagram", "youtube"];

  if (!allowedPlatforms.includes(cleanPlatform)) {
    const error = new Error(
      `Invalid platform '${cleanPlatform}'. Use tiktok, instagram, or youtube.`
    );
    error.statusCode = 400;
    throw error;
  }

  return cleanPlatform;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();

    const timer = setTimeout(() => {
      controller.abort();

      const error = new Error(
        `Modash request timeout after ${timeoutMs / 1000} seconds`
      );
      error.statusCode = 504;
      reject(error);
    }, timeoutMs);

    fetch(url, {
      ...options,
      signal: controller.signal,
    })
      .then((response) => {
        clearTimeout(timer);
        resolve(response);
      })
      .catch((error) => {
        clearTimeout(timer);

        if (error.name === "AbortError") {
          const timeoutError = new Error(
            `Modash request timeout after ${timeoutMs / 1000} seconds`
          );
          timeoutError.statusCode = 504;
          reject(timeoutError);
          return;
        }

        reject(error);
      });
  });
}

async function getModashLocations({ platform, query, limit = 20 }) {
  const token = cleanParam(process.env.MODASH_API_KEY, "");

  if (!token) {
    const error = new Error("MODASH_API_KEY is missing in .env");
    error.statusCode = 500;
    throw error;
  }

  const cleanPlatform = normalizeModashPlatform(platform);
  const cleanQuery = cleanParam(query, "");
  const cleanLimit = safeNumber(limit, 20);

  if (!cleanQuery) {
    const error = new Error("query is required");
    error.statusCode = 400;
    throw error;
  }

  const baseUrl = getModashBaseUrl();

  const url =
    `${baseUrl}/${cleanPlatform}/locations` +
    `?query=${encodeURIComponent(cleanQuery)}` +
    `&limit=${encodeURIComponent(String(cleanLimit))}`;

  console.log("[Modash Locations] URL:", url);

  const response = await fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    },
    12000
  );

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      data?.message || data?.error || "Failed to fetch locations from Modash"
    );

    error.statusCode = response.status;
    error.data = data;

    throw error;
  }

  const locations = Array.isArray(data?.locations)
    ? data.locations
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.items)
        ? data.items
        : [];

  return {
    platform: cleanPlatform,
    query: cleanQuery,
    total: data?.total || locations.length || 0,
    locations,
  };
}

exports.getModashLocationController = async (req, res) => {
  console.log("✅ [Location API] controller hit");

  let controllerTimeout;

  try {
    controllerTimeout = setTimeout(() => {
      if (!res.headersSent) {
        return res.status(504).json({
          success: false,
          message: "Controller timeout after 15 seconds",
          hint: "Route is hit, but Modash request or backend process is hanging.",
        });
      }
    }, 15000);

    const platform = getUrlParam(req, "platform", "tiktok");
    const query = getUrlParam(req, "query", "");
    const limit = getUrlParam(req, "limit", "20");

    console.log("[Location API] parsed params:", {
      platform,
      query,
      limit,
    });

    const data = await getModashLocations({
      platform,
      query,
      limit,
    });

    clearTimeout(controllerTimeout);

    if (res.headersSent) return;

    return res.status(200).json({
      success: true,
      message: "Locations fetched successfully",
      platform: data.platform,
      query: data.query,
      total: data.total,
      locations: data.locations,
    });
  } catch (error) {
    if (controllerTimeout) clearTimeout(controllerTimeout);

    console.error("[Location API] error:", error);
    console.error("[Location API] stack:", error.stack);

    if (res.headersSent) return;

    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message || "Internal server error",
      data: error.data || null,
    });
  }
};

function isUsefulCampaignSearchValue(value) {
  const text = cleanStr(value);
  if (!text) return false;
  if (/^[a-f0-9]{24}$/i.test(text)) return false;

  const lower = text.toLowerCase();
  if (/([a-z]{2,6})\1{2,}/i.test(lower)) return false;

  return true;
}

function buildCampaignRecommendationQuery(campaign = {}) {
  const details = campaign.details || {};

  const values = uniqStrings([
    campaign.campaignTitle,
    campaign.productOrServiceName,
    campaign.campaignGoal,
    campaign.campaignObjective,
    campaign.campaignCategory,
    campaign.campaignSubcategory,
    campaign.description,
    campaign.additionalNotes,
    details.category && details.category.name,
    ...(Array.isArray(details.subcategories)
      ? details.subcategories.flatMap((x) => [
        x && x.name,
        ...(Array.isArray(x && x.tags) ? x.tags : []),
      ])
      : []),
    ...(Array.isArray(details.campaignGoals)
      ? details.campaignGoals.map((x) => x && x.goal)
      : []),
    ...(Array.isArray(details.contentFormats)
      ? details.contentFormats.map((x) => x && x.format)
      : []),
    ...(Array.isArray(campaign.categories)
      ? campaign.categories.flatMap((x) => [
        x && x.categoryName,
        x && x.subcategoryName,
      ])
      : []),
    ...(Array.isArray(campaign.hashtags) ? campaign.hashtags : []),
    ...(Array.isArray(campaign.preferredHashtags)
      ? campaign.preferredHashtags
      : []),
  ]).filter(isUsefulCampaignSearchValue);

  return values
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function buildCampaignRecommendationBody(campaign = {}) {
  const influencer = {};

  const minFollowers = Number(campaign.minFollowers || 0);
  const maxFollowers = Number(campaign.maxFollowers || 0);

  if (minFollowers || maxFollowers) {
    influencer.followers = {};
    if (minFollowers) influencer.followers.min = minFollowers;
    if (maxFollowers) influencer.followers.max = maxFollowers;
  }

  const categories = [
    campaign.campaignCategory,
    campaign.campaignSubcategory,
    ...(Array.isArray(campaign.categories)
      ? campaign.categories.flatMap((x) => [
        x.categoryName,
        x.subcategoryName,
      ])
      : []),
  ].filter(Boolean);

  if (categories.length) {
    influencer.categories = [...new Set(categories)];
  }

  return {
    sort: { field: 'followers', direction: 'desc' },
    filter: {
      influencer,
    },
  };
}

function buildRecommendationReason(item = {}) {
  const parts = [];

  if (item.searchType === 'ai') parts.push('AI content match');
  if (Array.isArray(item.categories) && item.categories.length) {
    parts.push(`Matches ${item.categories.slice(0, 2).join(', ')}`);
  }
  if (item.followers) {
    parts.push(`${new Intl.NumberFormat('en', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(Number(item.followers))} followers`);
  }
  if (item.engagementRate) {
    parts.push(`${Number(item.engagementRate).toFixed(2)}% engagement`);
  }

  return parts.slice(0, 3).join(' • ') || 'Matched campaign keywords and filters';
}

function mapRecommendedInfluencer(item, maxScore) {
  const rawScore = Number(item.__relevanceScore || 0);
  const aiScore = maxScore > 0
    ? Math.max(1, Math.min(100, Math.round((rawScore / maxScore) * 100)))
    : 0;

  return {
    ids: {
      modashId: item.userId || null,
      userId: item.userId || null,
    },
    name: item.fullname || item.username || item.handle || 'Unknown Creator',
    username: item.username || item.handle || '',
    handle: item.handle || item.username || '',
    platform: item.platform,
    followers: Number(item.followers || 0),
    tier: influencerTierFromFollowers(item.followers),
    categories: Array.isArray(item.categories) ? item.categories : [],
    bio: cleanStr(
      item.bio ||
      item.description ||
      item.about ||
      item.summary ||
      item.introduction ||
      ""
    ),
    picture: item.picture || null,
    picture: item.picture || null,
    urls: {
      url: item.url || null,
    },
    isVerified: Boolean(item.isVerified),
    isPrivate: Boolean(item.isPrivate),
    stats: {
      engagementRate: Number(item.engagementRate || 0),
      engagements: Number(item.engagements || 0),
      averageViews: Number(item.averageViews || 0),
    },
    location: {
      country: item.country || null,
      state: item.state || null,
      city: item.city || null,
    },
    aiScore,
    rawAiScore: rawScore,
    recommendationReason: buildRecommendationReason(item),
  };
}

async function getCampaignRecommendationSource(req, res) {
  try {
    const brandId = cleanStr(req.body?.brandId || req.query?.brandId);
    const campaignId = cleanStr(req.body?.campaignId || req.query?.campaignId);

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return res.status(400).json({
        status: "error",
        message: "Valid brandId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(campaignId)) {
      return res.status(400).json({
        status: "error",
        message: "Valid campaignId is required",
      });
    }

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(campaignId),
      brandId: new mongoose.Types.ObjectId(brandId),
    })
      .select("_id brandId platformSelection campaignTitle")
      .lean();

    if (!campaign) {
      return res.status(404).json({
        status: "error",
        message: "Campaign not found for this brand",
      });
    }

    const requestedPlatforms = buildRequestedPlatforms(
      campaign.platformSelection || []
    );

    const hasYoutube = requestedPlatforms.includes("youtube");

    return res.json({
      status: "success",
      campaignId,
      requestedPlatforms,

      // ✅ Final frontend decision
      source: hasYoutube ? "youtube_api" : "modash_ai",

      // ✅ Final platforms frontend should expect
      effectivePlatforms: hasYoutube
        ? ["youtube"]
        : requestedPlatforms.filter((p) => p !== "youtube"),

      rule: hasYoutube
        ? "youtube_selected_use_youtube_api_only"
        : "no_youtube_use_modash_ai_only",
    });
  } catch (err) {
    console.error("getCampaignRecommendationSource error:", err);

    return res.status(err.status || 500).json({
      status: "error",
      message: err.message || "Failed to check campaign platforms",
    });
  }
}

async function getRecommendedInfluencersForCampaign(req, res) {
  try {
    const brandId = cleanStr(req.body?.brandId || req.query?.brandId);
    const campaignId = cleanStr(req.body?.campaignId || req.query?.campaignId);
    const limit = Math.min(
      15,
      Math.max(
        10,
        parseInt(String(req.body?.limit || req.query?.limit || 15), 10) || 15
      )
    );
    const minimumResults = Math.min(
      limit,
      Math.max(
        1,
        parseInt(String(req.body?.minResults || req.query?.minResults || 10), 10) || 10
      )
    );

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return res.status(400).json({
        status: "error",
        message: "Valid brandId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(campaignId)) {
      return res.status(400).json({
        status: "error",
        message: "Valid campaignId is required",
      });
    }

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(campaignId),
      brandId: new mongoose.Types.ObjectId(brandId),
    }).lean();

    if (!campaign) {
      return res.status(404).json({
        status: "error",
        message: "Campaign not found for this brand",
      });
    }

    const requestedPlatforms = buildRequestedPlatforms(
      campaign.platformSelection || []
    );

    if (requestedPlatforms.includes("youtube")) {
      const youtubeResult = await getYouTubeRecommendationsForCampaign(
        campaign,
        { limit, minResults: minimumResults }
      );

      return res.json({
        status: "success",
        campaignId,
        query: youtubeResult.query,
        results: youtubeResult.results,
        total: youtubeResult.total,
        meta: {
          ...youtubeResult.meta,
          requestedPlatforms,
          platforms: ["youtube"],
          rule: "youtube_selected_use_youtube_api_only",
        },
      });
    }

    const query = buildCampaignRecommendationQuery(campaign);

    if (!query || query.length < 2) {
      return res.status(400).json({
        status: "error",
        message: "Campaign does not have enough text to recommend influencers",
      });
    }

    // ✅ When YouTube is not selected, use Modash AI Search only.
    // Example:
    // ["instagram", "tiktok"] => Modash AI Search only
    const platforms = requestedPlatforms.filter((p) => p !== "youtube");

    if (!platforms.length) {
      return res.json({
        status: "success",
        campaignId,
        query: "",
        results: [],
        total: 0,
        meta: {
          source: "modash_ai",
          requestedPlatforms,
          platforms,
          warnings: [
            {
              message: "No Instagram or TikTok platform is selected for Modash recommendations.",
            },
          ],
          rule: "no_youtube_use_modash_ai_only",
        },
      });
    }

    const body = buildCampaignRecommendationBody(campaign);
    const fetchPlan = buildBalancedPlatformFetchPlan(platforms, limit);
    const fetchLimitByPlatform = new Map(
      fetchPlan.map((entry) => [entry.platform, entry.limit])
    );

    const responses = [];
    const warnings = [];

    for (const platform of platforms) {
      const fetchLimit = fetchLimitByPlatform.get(platform) || limit;

      try {
        responses.push(
          await runAiPlatformSearch(
            platform,
            {
              brandId,
              query,
              searchMode: "ai",
              body,
              ai: { query },
            },
            0,
            fetchLimit
          )
        );
      } catch (err) {
        if (isAuthError(err)) {
          warnings.push({
            platform,
            kind: "ai",
            message:
              "AI search skipped because Modash AI endpoint is not allowed for this key.",
          });
        } else {
          throw err;
        }
      }
    }

    for (let pageIndex = 1; pageIndex < 4; pageIndex += 1) {
      const currentMerged = mergeUnifiedSearchItems(
        responses.flatMap((entry) =>
          Array.isArray(entry.results) ? entry.results : []
        )
      );

      if (currentMerged.length >= minimumResults) break;

      for (const platform of platforms) {
        const fetchLimit = fetchLimitByPlatform.get(platform) || limit;

        try {
          responses.push(
            await runAiPlatformSearch(
              platform,
              {
                brandId,
                query,
                searchMode: "ai",
                body,
                ai: { query },
              },
              pageIndex,
              fetchLimit
            )
          );
        } catch (err) {
          if (isAuthError(err)) {
            warnings.push({
              platform,
              kind: "ai",
              page: pageIndex,
              message:
                "AI search page skipped because Modash AI endpoint is not allowed for this key.",
            });
          } else {
            throw err;
          }
        }
      }
    }

    let merged = mergeUnifiedSearchItems(
      responses.flatMap((entry) =>
        Array.isArray(entry.results) ? entry.results : []
      )
    );

    let cachedEnriched = await enrichResultsFromCache(merged);
    let orderedResults = decorateUnifiedResults(cachedEnriched, query);

    // If Modash AI returns fewer than the minimum display count, fill the same
    // platform set using the standard search endpoint. This keeps the invitation
    // page at 10-15 cards without mixing YouTube into Modash-only campaigns.
    if (orderedResults.length < minimumResults) {
      const standardResponses = [];

      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const currentMerged = mergeUnifiedSearchItems(
          responses
            .concat(standardResponses)
            .flatMap((entry) =>
              Array.isArray(entry.results) ? entry.results : []
            )
        );

        if (currentMerged.length >= minimumResults) break;

        for (const platform of platforms) {
          const fetchLimit = fetchLimitByPlatform.get(platform) || limit;

          try {
            standardResponses.push(
              await runStandardPlatformSearch(
                platform,
                body,
                query,
                pageIndex,
                fetchLimit
              )
            );
          } catch (err) {
            warnings.push({
              platform,
              kind: "standard",
              page: pageIndex,
              message: buildSafeErrorMessage(
                err,
                "Standard search fallback skipped for this platform."
              ),
            });
          }
        }
      }

      if (standardResponses.length) {
        responses.push(...standardResponses);
        merged = mergeUnifiedSearchItems(
          responses.flatMap((entry) =>
            Array.isArray(entry.results) ? entry.results : []
          )
        );
        cachedEnriched = await enrichResultsFromCache(merged);
        orderedResults = decorateUnifiedResults(cachedEnriched, query);
      }
    }

    const balancedResults =
      platforms.length > 1
        ? balanceRankedResultsAcrossPlatforms(
          orderedResults,
          platforms,
          limit,
          query
        )
        : orderedResults;

    const sliced = balancedResults.slice(0, limit);
    const maxScore = Math.max(
      ...sliced.map((x) => Number(x.__relevanceScore || 0)),
      0
    );

    return res.json({
      status: "success",
      campaignId,
      query,
      results: sliced.map((item) =>
        mapRecommendedInfluencer(item, maxScore)
      ),
      total: sliced.length,
      meta: {
        source: "modash_ai",
        requestedPlatforms,
        platforms,
        warnings,
        minimumResults,
        rule: "no_youtube_use_modash_ai_only",
      },
    });
  } catch (err) {
    console.error("getRecommendedInfluencersForCampaign error:", err);

    return res.status(err.status || 500).json({
      status: "error",
      message: err.message || "Failed to recommend influencers",
    });
  }
}

function toMongoObjectId(value) {
  const id = cleanStr(value);

  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  return new mongoose.Types.ObjectId(id);
}

function requireMongoObjectId(value, label) {
  const objectId = toMongoObjectId(value);

  if (!objectId) {
    const err = new Error(`Valid ${label} is required`);
    err.status = 400;
    throw err;
  }

  return objectId;
}

function readFirstNumber() {
  for (const value of arguments) {
    if (value === undefined || value === null || value === '') continue;

    const raw =
      typeof value === 'string'
        ? value.replace(/[₹$,]/g, '').replace(/\s+/g, '')
        : value;

    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) return num;
  }

  return 0;
}

function normalizePercentToFraction(value) {
  const num = Number(value || 0);

  if (!Number.isFinite(num) || num <= 0) return 0;

  return num > 1 ? num / 100 : num;
}

function stringifyCampaignValue(value) {
  if (value === undefined || value === null) return '';

  if (typeof value === 'string' || typeof value === 'number') {
    return cleanStr(value);
  }

  if (Array.isArray(value)) {
    return value.map(stringifyCampaignValue).filter(Boolean).join(' ');
  }

  if (typeof value === 'object') {
    return Object.values(value).map(stringifyCampaignValue).filter(Boolean).join(' ');
  }

  return '';
}

function getCampaignBudget(campaign) {
  return readFirstNumber(
    campaign?.campaignBudget,
    campaign?.budget,
    campaign?.totalBudget,
    campaign?.estimatedBudget,
    campaign?.feeAmount,
    campaign?.compensationAmount,
    campaign?.compensation,
    campaign?.paymentAmount,
    campaign?.price,
    campaign?.amount
  );
}

function getCampaignText(campaign) {
  return [
    campaign?.campaignTitle,
    campaign?.title,
    campaign?.name,
    campaign?.description,
    campaign?.campaignDescription,
    campaign?.objective,
    campaign?.campaignObjective,
    campaign?.deliverables,
    campaign?.requiredDeliverables,
    campaign?.contentDeliverables,
    campaign?.contentRequirements,
    campaign?.platformDeliverables,
    campaign?.productName,
    campaign?.category,
    campaign?.campaignCategory,
    campaign?.niche,
    campaign?.brand,
  ]
    .map(stringifyCampaignValue)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function getCampaignDeliverables(campaign) {
  const campaignText = getCampaignText(campaign);
  const deliverables = [];

  const pushDeliverable = (key, label, weight, count = 1) => {
    const safeCount = Math.max(1, Number(count || 1));
    const existing = deliverables.find((item) => item.key === key);

    if (existing) {
      existing.count = Math.max(existing.count, safeCount);
      return;
    }

    deliverables.push({
      key,
      label,
      weight,
      count: safeCount,
    });
  };

  const countFromText = (regex, fallback = 1) => {
    const match = campaignText.match(regex);
    const count = Number(match?.[1] || fallback);

    return Number.isFinite(count) && count > 0 ? count : fallback;
  };

  if (/story|stories/.test(campaignText)) {
    pushDeliverable(
      'story',
      'Story / Story Set',
      0.35,
      countFromText(/(\d+)\s*(story|stories)/i)
    );
  }

  if (/reel|reels/.test(campaignText)) {
    pushDeliverable(
      'reel',
      'Reel / Short Video',
      1.2,
      countFromText(/(\d+)\s*(reel|reels)/i)
    );
  }

  if (/short|shorts/.test(campaignText)) {
    pushDeliverable(
      'short',
      'Short-form Video',
      1.0,
      countFromText(/(\d+)\s*(short|shorts)/i)
    );
  }

  if (/post|posts|carousel|feed/.test(campaignText)) {
    pushDeliverable(
      'post',
      'Feed Post / Carousel',
      0.85,
      countFromText(/(\d+)\s*(post|posts|carousel|feed)/i)
    );
  }

  if (/youtube|dedicated video|long video|video integration/.test(campaignText)) {
    pushDeliverable('youtube_video', 'YouTube Video / Integration', 2.0, 1);
  }

  if (/live|livestream|stream/.test(campaignText)) {
    pushDeliverable('live', 'Live Session', 1.6, 1);
  }

  if (!deliverables.length) {
    pushDeliverable('base_content', 'Sponsored Content Package', 1.0, 1);
  }

  return deliverables;
}

function getPlatformRateConfig(platform) {
  if (platform === 'youtube') {
    return {
      cpm: 20,
      minBase: 150,
      platformMultiplier: 1.25,
    };
  }

  if (platform === 'tiktok') {
    return {
      cpm: 8,
      minBase: 60,
      platformMultiplier: 0.9,
    };
  }

  return {
    cpm: 12,
    minBase: 75,
    platformMultiplier: 1,
  };
}

function getTierMultiplier(followers) {
  const f = Number(followers || 0);

  if (f >= 1000000) return 1.55;
  if (f >= 500000) return 1.35;
  if (f >= 100000) return 1.18;
  if (f >= 10000) return 1.0;

  return 0.85;
}

function getGeoMultiplier(audience) {
  const countries = asArray(audience?.geoCountries);

  const premiumCountries = new Set([
    'United States',
    'US',
    'USA',
    'Canada',
    'United Kingdom',
    'UK',
    'Australia',
    'Germany',
    'France',
    'Netherlands',
    'Singapore',
    'UAE',
    'United Arab Emirates',
  ]);

  let premiumWeight = 0;

  for (const item of countries) {
    const name = cleanStr(item?.name || item?.code);
    const weight = Number(item?.weight || 0);

    if (premiumCountries.has(name)) {
      premiumWeight += weight;
    }
  }

  if (premiumWeight >= 0.5) return 1.35;
  if (premiumWeight >= 0.3) return 1.2;
  if (premiumWeight >= 0.15) return 1.1;

  return 1;
}

function getNicheMultiplier(campaign, normalizedReport) {
  const categoryText = asArray(normalizedReport?.categories)
    .map((item) => {
      if (typeof item === 'string') return item;

      return [
        item?.categoryName,
        item?.subcategoryName,
        item?.name,
        item?.label,
      ]
        .filter(Boolean)
        .join(' ');
    })
    .join(' ');

  const text = `${getCampaignText(campaign)} ${categoryText}`.toLowerCase();

  if (/finance|investment|crypto|real estate|b2b|saas|software|medical|healthcare/.test(text)) {
    return 1.3;
  }

  if (/beauty|fashion|skincare|fitness|sportswear|luxury|jewelry|travel/.test(text)) {
    return 1.15;
  }

  if (/food|lifestyle|home|parenting|gaming|tech/.test(text)) {
    return 1.08;
  }

  return 1;
}

function getUsageRightsMultiplier(campaign) {
  const text = getCampaignText(campaign);

  if (/perpetual|forever|unlimited usage|full rights|whitelisting|paid ads|ad usage|spark ads/.test(text)) {
    return 1.45;
  }

  if (/usage rights|boosting|paid media|license/.test(text)) {
    return 1.25;
  }

  return 1;
}

function roundRate(value) {
  const num = Number(value || 0);

  if (!Number.isFinite(num) || num <= 0) return 0;

  if (num >= 10000) return Math.round(num / 250) * 250;
  if (num >= 2500) return Math.round(num / 100) * 100;
  if (num >= 1000) return Math.round(num / 50) * 50;
  if (num >= 250) return Math.round(num / 25) * 25;

  return Math.round(num / 5) * 5;
}


function formatCompactUS(value) {
  const num = Number(value || 0);

  if (!Number.isFinite(num) || num <= 0) return '0';

  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(num);
}

function formatRatePercent(value) {
  const num = Number(value || 0);

  if (!Number.isFinite(num) || num <= 0) return '0%';

  const pct = num > 1 ? num : num * 100;

  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

function getWeightedNames(items, limit = 3) {
  return asArray(items)
    .slice()
    .sort((a, b) => Number(b?.weight || 0) - Number(a?.weight || 0))
    .map((item) => cleanStr(item?.name || item?.code || item?.label))
    .filter(Boolean)
    .slice(0, limit);
}

function getCampaignFocusLabels(campaign) {
  const categoryPairs = asArray(campaign?.categories)
    .flatMap((item) => [
      item?.categoryName,
      item?.subcategoryName,
    ])
    .filter(Boolean);

  return uniqStrings([
    campaign?.campaignCategory,
    campaign?.campaignSubcategory,
    campaign?.campaignType,
    campaign?.influencerTier,
    campaign?.targetCountry,
    ...asArray(campaign?.platformSelection),
    ...categoryPairs,
  ]);
}

function getCreatorFocusLabels(normalizedReport, influencerDoc) {
  const categoryNames = asArray(normalizedReport?.categories || influencerDoc?.categories)
    .flatMap((item) => {
      if (typeof item === 'string') return [item];

      return [
        item?.categoryName,
        item?.subcategoryName,
        item?.name,
        item?.label,
      ];
    })
    .filter(Boolean);

  const interests = asArray(
    normalizedReport?.audience?.interests ||
    normalizedReport?.interests ||
    influencerDoc?.audience?.interests ||
    influencerDoc?.interests
  )
    .map((item) => (typeof item === 'string' ? item : item?.name || item?.code || item?.label))
    .filter(Boolean);

  return uniqStrings([
    ...categoryNames,
    ...interests,
    influencerDoc?.country,
    influencerDoc?.language,
  ]);
}

function getMatchingFocusLabels(campaignLabels, creatorLabels) {
  const campaignLower = campaignLabels.map((item) => cleanStr(item).toLowerCase());

  return creatorLabels.filter((creatorLabel) => {
    const c = cleanStr(creatorLabel).toLowerCase();
    if (!c) return false;

    return campaignLower.some((campaignLabel) => {
      return campaignLabel.includes(c) || c.includes(campaignLabel);
    });
  });
}

function buildSelectionReason({
  campaign,
  influencerDoc,
  normalizedReport,
  audience,
  platform,
  followers,
  engagementRate,
  estimatedReach,
  credibility,
  deliverables,
  campaignBudget,
  budgetFit,
  budgetNote,
}) {
  const campaignTitle =
    campaign?.campaignTitle ||
    campaign?.title ||
    campaign?.name ||
    'this campaign';

  const creatorName =
    normalizedReport?.profile?.fullname ||
    influencerDoc?.fullname ||
    influencerDoc?.username ||
    'this creator';

  const campaignFocusLabels = getCampaignFocusLabels(campaign);
  const creatorFocusLabels = getCreatorFocusLabels(normalizedReport, influencerDoc);
  const matchingLabels = getMatchingFocusLabels(campaignFocusLabels, creatorFocusLabels);

  const topCountries = getWeightedNames(
    audience?.geoCountries || influencerDoc?.audience?.geoCountries,
    3
  );

  const topLanguages = getWeightedNames(
    audience?.languages || influencerDoc?.audience?.languages,
    2
  );

  const deliverableLabels = asArray(deliverables)
    .map((item) => item?.label)
    .filter(Boolean)
    .slice(0, 3);

  const reasons = [];

  if (matchingLabels.length) {
    reasons.push(
      `${creatorName} is a good fit for ${campaignTitle} because their creator signals match ${matchingLabels
        .slice(0, 3)
        .join(', ')}, which aligns with the campaign focus.`
    );
  } else if (campaignFocusLabels.length || creatorFocusLabels.length) {
    reasons.push(
      `${creatorName} is selected because their profile, content category, and ${platform} presence fit the campaign requirements for ${campaignTitle}.`
    );
  } else {
    reasons.push(
      `${creatorName} is selected because their profile has enough performance and audience data to evaluate against this campaign.`
    );
  }

  reasons.push(
    `Performance fit: ${formatCompactUS(followers)} followers, ${formatRatePercent(
      engagementRate
    )} engagement, and an estimated reach of ${formatCompactUS(
      estimatedReach
    )} make this creator suitable for ${deliverableLabels.length ? deliverableLabels.join(', ') : 'the planned deliverables'}.`
  );

  if (credibility) {
    reasons.push(
      `Audience quality supports the selection with ${Math.round(
        credibility * 100
      )}% credibility${topCountries.length ? ` and strongest audience presence in ${topCountries.join(', ')}` : ''}${topLanguages.length ? `, with language signals around ${topLanguages.join(', ')}` : ''
      }.`
    );
  } else if (topCountries.length) {
    reasons.push(
      `Geography supports the selection because the audience is concentrated around ${topCountries.join(
        ', '
      )}, which helps validate campaign targeting.`
    );
  }

  if (campaignBudget > 0) {
    reasons.push(
      `Budget fit is marked as ${String(budgetFit || 'unknown').replaceAll(
        '_',
        ' '
      )}; ${budgetNote}`
    );
  }

  return reasons.filter(Boolean).slice(0, 4);
}

function buildRateCardFromCampaignAndReport({
  campaign,
  influencerDoc,
  reportJSON,
  platform,
  currency = 'USD',
}) {
  const normalized = normalizeReportData(reportJSON || {});
  const profile = normalized.profile || {};
  const audience = normalized.audience || {};

  const followers = readFirstNumber(
    profile.followers,
    influencerDoc?.followers
  );

  const engagementRate = normalizePercentToFraction(
    profile.engagementRate ?? influencerDoc?.engagementRate
  );

  const avgViews = readFirstNumber(
    profile.averageViews,
    normalized.avgViews,
    normalized.avgReelsPlays,
    reportJSON?.profile?.avgViews,
    reportJSON?.profile?.avgReelsPlays,
    influencerDoc?.averageViews
  );

  const credibilityRaw = Number(audience?.credibility || influencerDoc?.audience?.credibility || 0);
  const credibility = credibilityRaw > 1 ? credibilityRaw / 100 : credibilityRaw;

  const estimatedReach = Math.max(
    avgViews,
    Math.round(
      followers * Math.min(0.28, Math.max(0.035, engagementRate + 0.045))
    )
  );

  const platformConfig = getPlatformRateConfig(platform);
  const deliverables = getCampaignDeliverables(campaign);
  const campaignBudget = getCampaignBudget(campaign);

  const engagementMultiplier = Math.min(
    1.55,
    Math.max(0.85, 1 + (engagementRate - 0.025) * 8)
  );

  const credibilityMultiplier = credibility
    ? Math.min(1.3, Math.max(0.85, 0.85 + credibility * 0.45))
    : 1;

  const tierMultiplier = getTierMultiplier(followers);
  const geoMultiplier = getGeoMultiplier(audience || influencerDoc?.audience);
  const nicheMultiplier = getNicheMultiplier(campaign, normalized);
  const usageMultiplier = getUsageRightsMultiplier(campaign);

  const baseRate = Math.max(
    platformConfig.minBase,
    (estimatedReach / 1000) * platformConfig.cpm
  );

  const totalMultiplier =
    platformConfig.platformMultiplier *
    engagementMultiplier *
    credibilityMultiplier *
    tierMultiplier *
    geoMultiplier *
    nicheMultiplier *
    usageMultiplier;

  const lineItems = deliverables.map((item) => {
    const quantity = Math.max(1, Number(item.count || 1));
    const unitEstimate = roundRate(baseRate * item.weight * totalMultiplier);
    const totalEstimate = roundRate(unitEstimate * quantity);

    return {
      key: item.key,
      label: item.label,
      quantity,
      unitEstimate,
      low: roundRate(unitEstimate * 0.8),
      high: roundRate(unitEstimate * 1.25),
      totalEstimate,
      totalLow: roundRate(totalEstimate * 0.8),
      totalHigh: roundRate(totalEstimate * 1.25),
    };
  });

  const estimatedTotal = lineItems.reduce(
    (sum, item) => sum + item.totalEstimate,
    0
  );

  const low = lineItems.reduce((sum, item) => sum + item.totalLow, 0);
  const high = lineItems.reduce((sum, item) => sum + item.totalHigh, 0);

  let budgetFit = 'unknown';
  let budgetNote =
    'No campaign budget was detected, so this estimate is based on creator performance and deliverables.';

  if (campaignBudget > 0) {
    if (campaignBudget >= low && campaignBudget <= high) {
      budgetFit = 'within_range';
      budgetNote = 'Campaign budget is within the suggested negotiation range.';
    } else if (campaignBudget < low) {
      budgetFit = 'below_range';
      budgetNote =
        'Campaign budget is below the suggested range. Consider fewer deliverables, gifted value, or a performance bonus.';
    } else {
      budgetFit = 'above_range';
      budgetNote =
        'Campaign budget is above the suggested range. You may negotiate usage rights, exclusivity, or extra deliverables.';
    }
  }

  const confidenceScore = Math.round(
    Math.min(
      95,
      Math.max(
        55,
        55 +
        (followers > 0 ? 10 : 0) +
        (estimatedReach > 0 ? 10 : 0) +
        (engagementRate > 0 ? 8 : 0) +
        (credibility > 0 ? 7 : 0) +
        (deliverables.length > 0 ? 5 : 0)
      )
    )
  );

  const selectionReason = buildSelectionReason({
    campaign,
    influencerDoc,
    normalizedReport: normalized,
    audience,
    platform,
    followers,
    engagementRate,
    estimatedReach,
    credibility,
    deliverables,
    campaignBudget,
    budgetFit,
    budgetNote,
  });

  return {
    currency,
    campaign: {
      _id: String(campaign?._id || ''),
      title:
        campaign?.campaignTitle ||
        campaign?.title ||
        campaign?.name ||
        'Campaign',
      budget: campaignBudget || null,
      budgetFit,
      budgetNote,
    },
    influencer: {
      _id: influencerDoc?._id ? String(influencerDoc._id) : null,
      modashUserId: profile.userId || influencerDoc?.userId || null,
      username: profile.username || influencerDoc?.username || null,
      handle:
        profile.handle ||
        influencerDoc?.handle ||
        (profile.username ? `@${profile.username}` : null),
      name:
        profile.fullname ||
        influencerDoc?.fullname ||
        influencerDoc?.username ||
        'Creator',
      platform,
      followers,
      engagementRate,
      estimatedReach,
      credibility: credibility ? Math.round(credibility * 100) : null,
    },
    suggested: {
      low,
      high,
      recommended: estimatedTotal,
      confidenceScore,
    },
    lineItems,
    multipliers: {
      platform: Number(platformConfig.platformMultiplier.toFixed(2)),
      engagement: Number(engagementMultiplier.toFixed(2)),
      credibility: Number(credibilityMultiplier.toFixed(2)),
      tier: Number(tierMultiplier.toFixed(2)),
      geography: Number(geoMultiplier.toFixed(2)),
      niche: Number(nicheMultiplier.toFixed(2)),
      usageRights: Number(usageMultiplier.toFixed(2)),
    },
    selectionReason,
    reasoning: [
      `Estimated reach: ${estimatedReach.toLocaleString('en-US')}`,
      `Followers: ${followers.toLocaleString('en-US')}`,
      `Engagement multiplier: ${engagementMultiplier.toFixed(2)}x`,
      `Audience credibility multiplier: ${credibilityMultiplier.toFixed(2)}x`,
      `Campaign deliverables detected: ${deliverables
        .map((item) => item.label)
        .join(', ')}`,
      budgetNote,
    ],
    disclaimer:
      'This is an estimated negotiation range in USD, not a guaranteed creator quote. Final pricing depends on usage rights, exclusivity, timeline, revisions, and creator demand.',
  };
}


function buildVirtualRateCardInfluencerDoc({ reportJSON, platform, body = {} }) {
  const normalized = normalizeReportData(reportJSON || {});
  const profile = normalized.profile || {};
  const rootProfile = (reportJSON && reportJSON.profile) || {};

  const rawUsername = cleanStr(
    profile.username ||
    profile.handle ||
    reportJSON?.username ||
    reportJSON?.handle ||
    rootProfile?.username ||
    rootProfile?.handle ||
    ''
  ).replace(/^@/, '');

  const userId = cleanStr(
    body.youtubeChannelId ||
    body.channelId ||
    body.modashUserId ||
    body.userId ||
    profile.userId ||
    reportJSON?.userId ||
    reportJSON?.channelId ||
    rootProfile?.userId ||
    rootProfile?.channelId ||
    rawUsername
  );

  const handle = cleanStr(
    body.handle ||
    profile.handle ||
    reportJSON?.handle ||
    rootProfile?.handle ||
    (rawUsername ? `@${rawUsername}` : '')
  );

  return {
    _id: null,
    provider: platform,
    userId: userId || null,
    username: rawUsername || null,
    fullname:
      cleanStr(profile.fullname || reportJSON?.fullname || reportJSON?.name || rootProfile?.fullname || rootProfile?.name) ||
      rawUsername ||
      'Creator',
    handle: handle || (rawUsername ? `@${rawUsername}` : null),
    url: profile.url || reportJSON?.url || rootProfile?.url || null,
    picture: profile.picture || reportJSON?.picture || rootProfile?.picture || null,
    followers: readFirstNumber(profile.followers, reportJSON?.followers, rootProfile?.followers),
    engagementRate: normalizePercentToFraction(
      profile.engagementRate ?? reportJSON?.engagementRate ?? rootProfile?.engagementRate
    ),
    averageViews: readFirstNumber(
      profile.averageViews,
      normalized.avgViews,
      normalized.avgReelsPlays,
      reportJSON?.avgViews,
      reportJSON?.averageViews,
      rootProfile?.avgViews,
      rootProfile?.averageViews
    ),
    country: normalized.country || reportJSON?.country || rootProfile?.country || null,
    language: normalized.language || reportJSON?.language || rootProfile?.language || null,
    audience: normalized.audience || reportJSON?.audience || rootProfile?.audience || null,
    categories: normalized.categories || reportJSON?.categories || rootProfile?.categories || [],
    providerRaw: reportJSON || null,
  };
}

async function getSuggestedRateCard(req, res) {
  try {
    const body = req.body || {};

    const brandObjectId = requireMongoObjectId(
      body.brandId || body.brand_id,
      'brandId'
    );

    const campaignObjectId = requireMongoObjectId(
      body.campaignId || body.campaign_id,
      'campaignId'
    );

    const rawInfluencerId = cleanStr(
      body.influencerId || body.influencer_id || body.modashProfileId
    );
    const influencerObjectId = toMongoObjectId(rawInfluencerId);
    const currency = cleanStr(body.currency || 'USD') || 'USD';

    const campaign = await Campaign.findOne({
      _id: campaignObjectId,
      brandId: brandObjectId,
    }).lean();

    if (!campaign) {
      return res.status(404).json({
        status: 'error',
        message: 'Campaign not found for this brand',
      });
    }

    let influencerDoc = null;

    if (influencerObjectId) {
      influencerDoc = await ModashProfile.findOne({
        _id: influencerObjectId,
      }).lean();
    }

    const reportJSON = body.report || body.raw || influencerDoc?.providerRaw || null;
    const platform = normalizePlatform(body.platform || influencerDoc?.provider || '');

    if (!platform) {
      return res.status(400).json({
        status: 'error',
        message: 'platform must be instagram|tiktok|youtube',
      });
    }

    if (!influencerDoc) {
      if (platform === 'youtube' && reportJSON) {
        influencerDoc = buildVirtualRateCardInfluencerDoc({
          reportJSON,
          platform,
          body,
        });
      } else if (rawInfluencerId && !influencerObjectId) {
        return res.status(400).json({
          status: 'error',
          message: 'Valid influencerId is required',
        });
      } else {
        return res.status(404).json({
          status: 'error',
          message: 'Influencer not found',
        });
      }
    }

    if (cleanStr(influencerDoc.provider) && cleanStr(influencerDoc.provider) !== platform) {
      return res.status(400).json({
        status: 'error',
        message: 'Influencer platform does not match requested platform',
      });
    }

    if (!reportJSON) {
      return res.status(400).json({
        status: 'error',
        message:
          'Report data is required. Open the creator report first so providerRaw is saved, or send the current report in the request.',
      });
    }

    const rateCard = buildRateCardFromCampaignAndReport({
      campaign,
      influencerDoc,
      reportJSON,
      platform,
      currency,
    });

    return res.json({
      status: 'success',
      data: rateCard,
    });
  } catch (err) {
    console.error('[getSuggestedRateCard] Error:', err);

    await saveErrorLog(req, err, err.status || 500, "GET_SUGGESTED_RATE_CARD_ERROR");

    return res.status(err.status || 500).json({
      status: 'error',
      message: err.message || 'Failed to generate suggested rate card',
    });
  }
}


/* -------------------------------------------------------------------------- */
/*                                   Exports                                  */
/* -------------------------------------------------------------------------- */

module.exports = {
  frontendUsers,
  frontendSearch,
  frontendUnifiedSearch,
  frontendReportPreview,
  frontendReport,
  getSuggestedRateCard,
  resolveProfile,
  search: legacySearch,
  upsertCreator,
  getCreatorByUserId,
  normalizeReportData,
  upsertModashProfileFromReport,
  findCachedReport,
  getSavedInfluencers,
  getRandomInfluencers,
  getModashLocations,
  exportSavedInfluencersCsv,
  getMediaKitLink,
  getCampaignRecommendationSource,
  getRecommendedInfluencersForCampaign,
};