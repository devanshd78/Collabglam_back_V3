require("dotenv").config();

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

// Models
const BrandModule = require("../models/brand");
const BrandModel = BrandModule.BrandModel || BrandModule.default || BrandModule;
const Brand = BrandModel;
const SubscriptionPlan = require("../models/subscription");
const InfluencerModule = require("../models/influencer");
const InfluencerModel =
  InfluencerModule.InfluencerModel ||
  InfluencerModule.default ||
  InfluencerModule;
const Influencer = InfluencerModel;

const CategoryModule = require("../models/categories");
const Category =
  CategoryModule.Category || CategoryModule.default || CategoryModule;

const Language = require("../models/language");

const VerifyEmailModule = require("../models/verifyEmail");
const VerifyEmail =
  VerifyEmailModule.VerifyEmail ||
  VerifyEmailModule.default ||
  VerifyEmailModule;

// same underlying model in your code
const VerifyOtpModel = VerifyEmail;

const ApplyCampaign = require("../models/applyCampaign");
const Campaign = require("../models/campaign");
const { AgeRangeModel: AgeRange } = require("../models/ageRange");
const Country = require("../models/country");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");
const Modash = require("../models/modash");

const { linkConversationsForInfluencer } = require("../services/emailLinking");
const { attachExternalEmailToInfluencer } = require("../utils/emailAliases");
const { escapeRegExp } = require("../utils/searchTokens");
const { buildOtpEmailTemplate } = require("../template/buildOtpEmailTemplate");
const saveErrorLog = require("../services/errorLog.service");

const UUIDv4Regex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BASE_API_URL = "http://192.168.1.20:8000";
const WELCOME_EMAIL_API_URL = `${BASE_API_URL}/emails/send-welcome`;

/* ========================= SMTP / Mailer ========================= */
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const JWT_SECRET = process.env.JWT_SECRET;

const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || "CollabGlam";
const PRODUCT_NAME = process.env.PRODUCT_NAME || "CollabGlam";

const RESET_TTL_MIN = Number(process.env.RESET_PASSWORD_TTL_MINUTES || 15);
const RESET_TTL_MS = RESET_TTL_MIN * 60 * 1000;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

function signResetJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is missing in env");

  return jwt.sign(payload, secret, {
    expiresIn: `${RESET_TTL_MIN}m`,
  });
}

const OTP_TTL_MIN = Number(process.env.OTP_TTL_MIN || 15);
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || "CHANGE_ME_OTP_SECRET";
const OTP_LIMIT_MAX = Number(process.env.OTP_LIMIT_MAX || 6);
const OTP_LIMIT_COOLDOWN_MIN = Number(process.env.OTP_LIMIT_COOLDOWN_MIN || 15);
const OTP_BATCH_LIMIT = Number(process.env.OTP_BATCH_LIMIT || 3);
const OTP_RESET_HOURS = Number(process.env.OTP_RESET_HOURS || 24);

const SIGNIN_FIRST_ATTEMPTS = Number(process.env.SIGNIN_FIRST_ATTEMPTS || 5);
const SIGNIN_SECOND_ATTEMPTS = Number(process.env.SIGNIN_SECOND_ATTEMPTS || 3);
const SIGNIN_THIRD_ATTEMPTS = Number(process.env.SIGNIN_THIRD_ATTEMPTS || 3);

const SIGNIN_LOCK_1_MIN = Number(process.env.SIGNIN_LOCK_1_MIN || 1);
const SIGNIN_LOCK_15_MIN = Number(process.env.SIGNIN_LOCK_15_MIN || 15);
const SIGNIN_LOCK_24_HOURS = Number(process.env.SIGNIN_LOCK_24_HOURS || 24);

const SIGNIN_STAGE_1_TOTAL = SIGNIN_FIRST_ATTEMPTS;
const SIGNIN_STAGE_2_TOTAL = SIGNIN_FIRST_ATTEMPTS + SIGNIN_SECOND_ATTEMPTS;
const SIGNIN_STAGE_3_TOTAL =
  SIGNIN_FIRST_ATTEMPTS + SIGNIN_SECOND_ATTEMPTS + SIGNIN_THIRD_ATTEMPTS;

function clearSigninLimitFields(doc) {
  doc.signinFailedCount = 0;
  doc.signinCooldownUntil = null;
  doc.signinResetAt = null;
}

/* ================================ Helpers ================================ */
function isValidEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function toObjectId(id) {
  return new mongoose.Types.ObjectId(String(id));
}

function norm(e) {
  return String(e || "").trim().toLowerCase();
}

function stripAt(value = "") {
  return String(value || "").trim().replace(/^@+/, "");
}

function normalizeHandle(handle, username) {
  let h = String(handle || username || "").trim();
  if (!h) return null;
  if (!h.startsWith("@")) h = `@${h}`;
  return h;
}

function signJwt(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is missing in env");

  return jwt.sign(payload, secret, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function uniqueValidObjectIds(ids) {
  if (!Array.isArray(ids)) return [];

  const out = [];
  const seen = new Set();

  for (const x of ids) {
    const s = String(x || "").trim();
    if (!s) continue;
    if (!isValidObjectId(s)) continue;
    if (seen.has(s)) continue;

    seen.add(s);
    out.push(s);
  }

  return out;
}

const PROXY_MAIL_DOMAIN =
  process.env.PROXY_MAIL_DOMAIN || "mail.collabglam.com";

function slugifyInfluencerName(name = "") {
  const base = String(name || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  return base || "influencer";
}

async function generateUniqueInfluencerProxyEmail(name) {
  const base = slugifyInfluencerName(name);
  const escapedBase = escapeRegExp(base);
  const escapedDomain = escapeRegExp(PROXY_MAIL_DOMAIN);

  const regex = new RegExp(`^${escapedBase}(\\d+)?@${escapedDomain}$`, "i");

  const existing = await InfluencerModel.find(
    { proxyEmail: regex },
    "proxyEmail"
  ).lean();

  let baseTaken = false;
  let maxSuffix = 1;

  for (const row of existing) {
    const email = String(row.proxyEmail || "").toLowerCase();
    const local = email.split("@")[0];

    if (local === base) {
      baseTaken = true;
      continue;
    }

    const match = local.match(new RegExp(`^${escapedBase}(\\d+)$`, "i"));
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > maxSuffix) {
        maxSuffix = n;
      }
    }
  }

  const localPart = baseTaken ? `${base}${maxSuffix + 1}` : base;
  return `${localPart}@${PROXY_MAIL_DOMAIN}`;
}

function isStrongPassword(pw) {
  const s = String(pw || "");
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(s);
}

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtp(email, otp) {
  const data = `${norm(email)}|${String(otp).trim()}|${OTP_HASH_SECRET}`;
  return crypto.createHash("sha256").update(data).digest("hex");
}

async function hashPassword(password) {
  return bcrypt.hash(String(password), 10);
}

function isPendingAdminCreatedInfluencer(doc = {}) {
  return doc?.isAdminCreated === true && doc?.signupCompleted === false;
}

function assertNotPendingAdminCreatedInfluencer(influencer) {
  if (isPendingAdminCreatedInfluencer(influencer)) {
    const err = new Error(
      "This influencer was added by admin. Please complete signup first using the same email."
    );
    err.statusCode = 400;
    throw err;
  }
}

async function findBrandByEmailForInfluencerSignup(email) {
  const normalizedEmail = norm(email);
  const emailRegexCI = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, "i");

  return BrandModel.findOne({ email: emailRegexCI }).lean().exec();
}

function getAuthenticatedInfluencerMongoId(req) {
  return String(
    req.user?._id ||
    req.user?.id ||
    req.influencer?._id ||
    req.influencer?.id ||
    ""
  ).trim();
}

function getInfluencerPublicId(doc) {
  return String(doc?._id || "");
}

function hasCompletedOnboardingStep(step) {
  if (Array.isArray(step)) {
    return step.some((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return Object.keys(item).length > 0;
      }

      return Boolean(item);
    });
  }

  if (step && typeof step === "object") {
    return Object.keys(step).length > 0;
  }

  return Boolean(step);
}

function computeInfluencerNextRoute(influencer) {
  const page1Done = hasCompletedOnboardingStep(influencer?.page1);

  const page2Done =
    hasCompletedOnboardingStep(influencer?.page2) ||
    influencer?.ispage2Skip === true;

  const page3Done =
    hasCompletedOnboardingStep(influencer?.page3) ||
    influencer?.ispage3Skip === true;

  let route = "campaign";

  if (!page1Done) route = "page1";
  else if (!page2Done) route = "page2";
  else if (!page3Done) route = "page3";

  return { route, page1Done, page2Done, page3Done };
}

const safeParse = (v) => {
  if (!v) return null;

  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }

  if (typeof v === "object") return v;
  return null;
};

async function buildCategoryIndex() {
  const rows = await Category.find({}, "id name subcategories").lean();

  const bySubId = new Map();
  const bySubName = new Map();
  const byCatId = new Map();

  for (const r of rows) {
    byCatId.set(r.id, r);

    for (const s of r.subcategories || []) {
      const node = {
        categoryId: r.id,
        categoryName: r.name,
        subcategoryId: s.subcategoryId,
        subcategoryName: s.name,
      };

      bySubId.set(String(s.subcategoryId), node);
      bySubName.set(String(s.name).toLowerCase(), node);
    }
  }

  return { bySubId, bySubName, byCatId };
}

function normalizeCategories(raw, idx) {
  if (!raw) return [];

  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];

  for (const item of list) {
    if (!item) continue;

    if (typeof item === "string") {
      const s = String(item).trim();

      if (UUIDv4Regex.test(s)) {
        const hit = idx.bySubId.get(s);
        if (hit) out.push(hit);
      } else {
        const byName = idx.bySubName.get(s.toLowerCase());
        if (byName) out.push(byName);
      }

      continue;
    }

    if (item.subcategoryId && UUIDv4Regex.test(String(item.subcategoryId))) {
      const hit = idx.bySubId.get(String(item.subcategoryId));
      if (hit) out.push(hit);
      continue;
    }

    if (typeof item.categoryId === "number" && item.subcategoryName) {
      const cat = idx.byCatId.get(item.categoryId);

      if (cat && Array.isArray(cat.subcategories)) {
        const sub = cat.subcategories.find(
          (s) =>
            String(s.name).toLowerCase() ===
            String(item.subcategoryName).toLowerCase()
        );

        if (sub) {
          out.push({
            categoryId: cat.id,
            categoryName: cat.name,
            subcategoryId: sub.subcategoryId,
            subcategoryName: sub.name,
          });
        }
      }

      continue;
    }

    if (typeof item.id === "number" || typeof item.name === "string") {
      const byName = item.name
        ? idx.bySubName.get(String(item.name).toLowerCase())
        : null;

      if (byName) out.push(byName);
    }
  }

  const seen = new Set();
  const deduped = [];

  for (const node of out) {
    if (!seen.has(node.subcategoryId)) {
      seen.add(node.subcategoryId);
      deduped.push(node);
    }
  }

  return deduped;
}

function normalizePromptAnswers(selectedPrompts = [], promptAnswers = {}) {
  const groupByPrompt = new Map();

  if (Array.isArray(selectedPrompts)) {
    for (const sp of selectedPrompts) {
      if (sp && sp.prompt) {
        groupByPrompt.set(String(sp.prompt), sp.group || "");
      }
    }
  }

  if (Array.isArray(promptAnswers)) {
    return promptAnswers
      .map((row) => {
        if (!row || !row.prompt) return null;

        return {
          prompt: String(row.prompt),
          answer: row.answer != null ? String(row.answer) : "",
          group:
            row.group != null
              ? String(row.group)
              : groupByPrompt.get(String(row.prompt)) || "",
        };
      })
      .filter(Boolean);
  }

  if (promptAnswers && typeof promptAnswers === "object") {
    return Object.entries(promptAnswers).map(([prompt, answer]) => ({
      prompt: String(prompt),
      answer: answer != null ? String(answer) : "",
      group: groupByPrompt.get(String(prompt)) || "",
    }));
  }

  return [];
}

async function resolveCategoryBasics(categoryIdRaw) {
  if (!categoryIdRaw) {
    return { categoryId: undefined, categoryName: undefined };
  }

  let doc = null;

  if (mongoose.Types.ObjectId.isValid(categoryIdRaw)) {
    doc = await Category.findById(categoryIdRaw, "id name").lean();
  }

  if (!doc && /^\d+$/.test(String(categoryIdRaw))) {
    doc = await Category.findOne(
      { id: Number(categoryIdRaw) },
      "id name"
    ).lean();
  }

  if (!doc) {
    return { categoryId: undefined, categoryName: undefined };
  }

  return { categoryId: doc.id, categoryName: doc.name };
}

function extractRawCategoriesFromProviderRaw(providerRaw) {
  const p = safeParse(providerRaw) || providerRaw || {};
  const root = p.profile || p;
  const prof = root.profile || {};

  return (
    prof.categories ||
    root.categories ||
    prof.interests ||
    root.interests ||
    []
  );
}

const mapPayload = (provider, input) => {
  const p = safeParse(input);
  if (!p) return null;

  const root = p.profile || p;
  const prof = root.profile || {};

  return {
    provider,
    userId: root.userId || prof.userId,
    username: prof.username,
    fullname: prof.fullname,
    handle: prof.handle,
    url: prof.url,
    picture: prof.picture,
    followers: prof.followers,
    engagements: prof.engagements,
    engagementRate: prof.engagementRate,
    averageViews: prof.averageViews,
    isPrivate: root.isPrivate,
    isVerified: root.isVerified,
    accountType: root.accountType,
    secUid: root.secUid,
    city: root.city,
    state: root.state,
    country: root.country,
    ageGroup: root.ageGroup,
    gender: root.gender,
    language: root.language,
    statsByContentType: root.statsByContentType,
    stats: root.stats,
    recentPosts: root.recentPosts,
    popularPosts: root.popularPosts,
    postsCount: root.postsCount || root.postsCounts,
    avgLikes: root.avgLikes,
    avgComments: root.avgComments,
    avgViews: root.avgViews,
    avgReelsPlays: root.avgReelsPlays,
    totalLikes: root.totalLikes,
    totalViews: root.totalViews,
    bio: root.description || root.bio,
    categories: [],
    hashtags: root.hashtags,
    mentions: root.mentions,
    brandAffinity: root.brandAffinity,
    audience: root.audience,
    audienceCommenters: root.audienceCommenters,
    lookalikes: root.lookalikes || root.audienceLookalikes,
    sponsoredPosts: root.sponsoredPosts,
    paidPostPerformance: root.paidPostPerformance,
    paidPostPerformanceViews: root.paidPostPerformanceViews,
    sponsoredPostsMedianViews: root.sponsoredPostsMedianViews,
    sponsoredPostsMedianLikes: root.sponsoredPostsMedianLikes,
    nonSponsoredPostsMedianViews: root.nonSponsoredPostsMedianViews,
    nonSponsoredPostsMedianLikes: root.nonSponsoredPostsMedianLikes,
    audienceExtra: root.audienceExtra,
    providerRaw: p,
  };
};

function mapOnboardingPage1ToProfile(item = {}) {
  const platform = String(item.platform || item.provider || "")
    .trim()
    .toLowerCase();

  if (!platform) return null;

  let mapped = item.data ? mapPayload(platform, item.data) : null;

  const username = item.username
    ? String(item.username).trim()
    : stripAt(item.handle);

  const handle = normalizeHandle(item.handle, username);

  if (!mapped) {
    mapped = {
      provider: platform,
      userId: item.userId || item.secUid || username || undefined,
      username: username || undefined,
      handle: handle || undefined,
      url: item.url || null,
      picture: item.picture || null,
      followers: item.followers || 0,
      categories: [],
      providerRaw: item,
    };
  }

  if (!mapped.username && username) mapped.username = username;
  if (!mapped.handle && handle) mapped.handle = handle;

  if (!mapped.userId) {
    mapped.userId =
      item.userId ||
      item.secUid ||
      mapped.username ||
      stripAt(mapped.handle) ||
      undefined;
  }

  if (Array.isArray(item.categories) && item.categories.length) {
    mapped.categories = item.categories;
  }

  return mapped;
}

async function loadSocialProfilesFromModash(influencerMongoId) {
  const docs = await Modash.find(
    { influencerId: String(influencerMongoId) },
    "provider handle username followers url picture"
  ).lean();

  return docs.map((d) => ({
    provider: d.provider,
    handle: normalizeHandle(d.handle, d.username),
    username: d.username || null,
    followers: Number(d.followers) || 0,
    url: d.url || null,
    picture: d.picture || null,
  }));
}

async function loadSocialProfilesFromModashBulk(influencerIds = []) {
  const docs = await Modash.find(
    { influencerId: { $in: influencerIds.map((id) => String(id)) } },
    "influencerId provider handle username followers url picture"
  ).lean();

  const grouped = {};

  for (const d of docs) {
    const key = String(d.influencerId);
    if (!grouped[key]) grouped[key] = [];

    grouped[key].push({
      provider: d.provider,
      handle: normalizeHandle(d.handle, d.username),
      username: d.username || null,
      followers: Number(d.followers) || 0,
      url: d.url || null,
      picture: d.picture || null,
    });
  }

  return grouped;
}

const ALLOWED_GENDERS = new Set([
  "Female",
  "Male",
  "Non-binary",
  "Prefer not to say",
  "",
]);

const ALLOWED_PLATFORMS = new Set([
  "youtube",
  "tiktok",
  "instagram",
  "other",
  null,
]);

function normalizeGender(value) {
  if (typeof value === "undefined" || value === null) return null;

  const raw = String(value).trim();
  const t = raw.toLowerCase();

  if (t === "" || t === "none" || t === "na" || t === "n/a") return "";
  if (t === "male" || t === "m") return "Male";
  if (t === "female" || t === "f") return "Female";
  if (t === "non-binary" || t === "nonbinary" || t === "nb") {
    return "Non-binary";
  }
  if (t === "prefer not to say" || t === "prefer-not-to-say") {
    return "Prefer not to say";
  }

  if (ALLOWED_GENDERS.has(raw)) return raw;
  return "__INVALID__";
}

function normalizePrimaryPlatform(value) {
  if (typeof value === "undefined") return undefined;
  if (value === null) return null;

  const v = String(value).trim().toLowerCase();

  if (ALLOWED_PLATFORMS.has(v)) return v;
  return "__INVALID__";
}

async function upsertOnboardingFromPayload(inf, onboardingPayload) {
  let ob = onboardingPayload;

  if (typeof ob === "string") {
    try {
      ob = JSON.parse(ob);
    } catch {
      const err = new Error("Invalid onboarding payload (must be JSON).");
      err.statusCode = 400;
      throw err;
    }
  }

  if (!ob || typeof ob !== "object") {
    const err = new Error("onboarding must be an object.");
    err.statusCode = 400;
    throw err;
  }

  const catIdNum = Number(ob.categoryId);

  if (!Number.isFinite(catIdNum)) {
    const err = new Error("categoryId must be a number.");
    err.statusCode = 400;
    throw err;
  }

  const catDoc = await Category.findOne({ id: catIdNum }).lean();

  if (!catDoc) {
    const err = new Error("Invalid categoryId.");
    err.statusCode = 400;
    throw err;
  }

  let incomingIds = [];

  if (Array.isArray(ob.subcategories) && ob.subcategories.length) {
    incomingIds = ob.subcategories
      .map((s) => s && s.subcategoryId)
      .filter(Boolean);
  } else if (Array.isArray(ob.subcategoryIds) && ob.subcategoryIds.length) {
    incomingIds = [...ob.subcategoryIds];
  }

  const valid = new Set(
    (catDoc.subcategories || []).map((s) => s.subcategoryId)
  );

  const nameById = new Map(
    (catDoc.subcategories || []).map((s) => [s.subcategoryId, s.name])
  );

  for (const id of incomingIds) {
    if (!valid.has(id)) {
      const err = new Error(`Invalid subcategoryId for this category: ${id}`);
      err.statusCode = 400;
      throw err;
    }
  }

  const finalSubs = incomingIds.map((id) => ({
    subcategoryId: id,
    subcategoryName: nameById.get(id),
  }));

  inf.onboarding = {
    ...(inf.onboarding || {}),
    categoryId: catDoc.id,
    categoryName: catDoc.name,
    subcategories: finalSubs,
  };
}

/* ========================= Mail Template ========================= */
const esc = (s = "") =>
  String(s).replace(
    /[&<>"]/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
      })[c]
  );

const PREHEADER = (t) =>
  `<div style="display:none;opacity:0;visibility:hidden;overflow:hidden;height:0;width:0;mso-hide:all;">${esc(t)}</div>`;

const WRAP =
  "max-width:640px;margin:0 auto;padding:0;background:#f7fafc;color:#0f172a;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;";
const SHELL = "padding:24px;";
const CARD =
  "border-radius:16px;background:#ffffff;border:1px solid #e5e7eb;overflow:hidden;box-shadow:0 8px 20px rgba(17,24,39,0.06);";
const BRAND_BAR =
  "padding:18px 20px;background:#ffffff;color:#111827;border-bottom:1px solid #FFE8B7;";
const BRAND_NAME = "font-weight:900;font-size:15px;letter-spacing:.2px;";
const ACCENT_BAR =
  "height:4px;background:linear-gradient(90deg,#FF6A00 0%, #FF8A00 30%, #FF9A00 60%, #FFBF00 100%);";
const HDR =
  "padding:20px 24px 6px 24px;font-weight:800;font-size:20px;color:#111827;";
const SUBHDR = "padding:0 24px 10px 24px;color:#374151;font-size:13px;";
const BODY = "padding:0 24px 24px 24px;";
const FOOT =
  "padding:14px 24px;color:#6b7280;font-size:12px;border-top:1px solid #f1f5f9;background:#fcfcfd;";
const BTN =
  "display:inline-block;background:#111827;color:#ffffff;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:800;";
const SMALL = "color:#6b7280;font-size:12px;";
const CODE_WRAPPER = "margin-top:12px;margin-bottom:6px;";
const CODE = [
  "display:inline-block",
  "font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace",
  "font-weight:900",
  "font-size:26px",
  "letter-spacing:6px",
  "color:#111827",
  "background:#FFF7E6",
  "border:1px solid #FFE2B3",
  "border-radius:14px",
  "padding:14px 18px",
].join(";");

function otpHtmlTemplate({
  title = "Your verification code",
  subtitle = "Use the one-time code below to continue.",
  code,
  minutes = 10,
  ctaHref,
  ctaLabel,
  footerNote = "If you didn’t request this, you can safely ignore this email.",
  preheader = "Your one-time verification code",
}) {
  const hasCta = Boolean(ctaHref && ctaLabel);

  return `
  ${PREHEADER(preheader)}
  <div style="${WRAP}">
    <div style="${SHELL}">
      <div style="${CARD}">
        <div style="${BRAND_BAR}">
          <div style="${BRAND_NAME}">${esc(PRODUCT_NAME)}</div>
        </div>
        <div style="${ACCENT_BAR}"></div>

        <div style="${HDR}">${esc(title)}</div>
        <div style="${SUBHDR}">${esc(subtitle)}</div>

        <div style="${BODY}">
          <div style="${CODE_WRAPPER}">
            <span style="${CODE}">${esc(code)}</span>
          </div>
          <div style="${SMALL}">This code expires in ${minutes} minutes.</div>

          ${hasCta
      ? `
            <div style="margin-top:16px;">
              <a href="${esc(ctaHref)}" style="${BTN}">${esc(ctaLabel)}</a>
              <div style="${SMALL};margin-top:8px;">If the button doesn’t work, copy &amp; paste this link:<br><span style="word-break:break-all;color:#111827;">${esc(ctaHref)}</span></div>
            </div>`
      : ""
    }
        </div>

        <div style="${FOOT}">
          ${esc(footerNote)}
        </div>
      </div>
    </div>
  </div>`;
}

function otpTextFallback({
  code,
  minutes = 10,
  title = "Your verification code",
}) {
  return `${title}\n\nCode: ${code}\nThis code expires in ${minutes} minutes.\n\nIf you didn’t request this, you can ignore this email.`;
}

async function sendMail({ to, subject, html, text }) {
  if (!to || !SMTP_HOST || !SMTP_USER) {
    console.warn("[mailer] Missing recipient or SMTP config; skipping email");
    return;
  }

  try {
    await transporter.sendMail({
      from: `"${MAIL_FROM_NAME}" <${SMTP_USER}>`,
      to,
      subject,
      html,
      text,
    });
  } catch (e) {
    console.error("[mailer] sendMail failed:", e?.message || e);
  }
}

/* =============================== Uploads =============================== */
const uploadDir = path.join(__dirname, "../uploads/profile_images");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);

    if (ext && mime) return cb(null, true);

    return cb(new Error("Only JPEG, JPG, and PNG files are allowed"));
  },
  limits: { fileSize: 2 * 1024 * 1024 },
});

exports.uploadProfileImage = upload.single("profileImage");

/* ========================== OTP: Request & Verify ========================== */
async function findInfluencerByEmail(email, includePassword = false) {
  const normalizedEmail = norm(email);
  const emailRegexCI = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, "i");

  let query = InfluencerModel.findOne({ email: emailRegexCI });

  if (includePassword) {
    query = query.select("+password");
  }

  return query.exec();
}

async function findUserByEmail(email, includePassword = false) {
  const normalizedEmail = norm(email);
  const emailRegexCI = new RegExp(`^${escapeRegExp(normalizedEmail)}$`, "i");

  let influencerQuery = InfluencerModel.findOne({ email: emailRegexCI });
  let brandQuery = BrandModel.findOne({ email: emailRegexCI });

  if (includePassword) {
    influencerQuery = influencerQuery.select("+password");
    brandQuery = brandQuery.select("+password");
  }

  const [influencer, brand] = await Promise.all([
    influencerQuery.exec(),
    brandQuery.exec(),
  ]);

  if (brand) return brand;

  if (influencer && !isPendingAdminCreatedInfluencer(influencer)) {
    return influencer;
  }

  return null;
}

function validateInfluencerSignupRequest(body = {}) {
  const { email, name, password, countryId, categoryIds, confirmPassword } =
    body;

  if (!email || !isValidEmail(email)) {
    throw Object.assign(new Error("Valid email is required"), {
      statusCode: 400,
    });
  }

  if (!name || typeof name !== "string" || name.trim().length < 2) {
    throw Object.assign(new Error("Valid name is required"), {
      statusCode: 400,
    });
  }

  if (!password || typeof password !== "string") {
    throw Object.assign(new Error("Password is required"), {
      statusCode: 400,
    });
  }

  if (!isStrongPassword(password)) {
    throw Object.assign(
      new Error(
        "Password must be at least 8 characters and include uppercase, lowercase, number, and special character"
      ),
      { statusCode: 400 }
    );
  }

  if (confirmPassword != null && String(confirmPassword) !== String(password)) {
    throw Object.assign(new Error("Passwords do not match"), {
      statusCode: 400,
    });
  }

  if (!countryId || !isValidObjectId(countryId)) {
    throw Object.assign(new Error("Valid countryId is required"), {
      statusCode: 400,
    });
  }

  const catIds = uniqueValidObjectIds(categoryIds);

  if (catIds.length === 0) {
    throw Object.assign(new Error("Select at least 1 category"), {
      statusCode: 400,
    });
  }

  if (catIds.length > 5) {
    throw Object.assign(new Error("Maximum 5 categories allowed"), {
      statusCode: 400,
    });
  }
}

function buildInfluencerSignupPayload({
  name,
  password,
  country,
  languages,
  categories,
}) {
  return {
    name: String(name || "").trim(),
    password: String(password || ""),
    country: country
      ? {
        _id: country._id,
        name: String(country.countryName ?? country.name ?? "").trim(),
      }
      : null,
    languages: Array.isArray(languages)
      ? languages.map((l) => ({
        _id: l._id,
        name: String(l.name || "").trim(),
      }))
      : [],
    categories: Array.isArray(categories)
      ? categories.map((c) => ({
        _id: c._id,
        name: String(c.name || "").trim(),
      }))
      : [],
  };
}

async function clearPendingOtpDocs(email, purpose) {
  await VerifyOtpModel.deleteMany({
    email: norm(email),
    role: "influencer",
    docType: "otp",
    purpose,
    status: 0,
  }).exec();
}

async function clearAllOtpDocs(email, purpose) {
  await VerifyOtpModel.deleteMany({
    email: norm(email),
    role: "influencer",
    docType: "otp",
    purpose,
  }).exec();
}

async function createOtpDoc({
  email,
  purpose,
  otpPlain,
  userId = null,
  signupPayload = null,
}) {
  return VerifyOtpModel.create({
    email: norm(email),
    role: "influencer",
    otp: hashOtp(email, otpPlain),
    status: 0,
    userId,
    docType: "otp",
    purpose,
    signupPayload,
  });
}

async function getLatestPendingOtp(email, purpose) {
  return VerifyOtpModel.findOne({
    email: norm(email),
    role: "influencer",
    docType: "otp",
    purpose,
    status: 0,
  })
    .sort({ createdAt: -1 })
    .exec();
}

function assertValidOtpDoc(otpDoc, email, otp) {
  if (!otpDoc) {
    throw Object.assign(
      new Error("OTP not requested or expired. Please request a new OTP."),
      { statusCode: 400 }
    );
  }

  const ageMs = Date.now() - new Date(otpDoc.createdAt).getTime();

  if (ageMs > OTP_TTL_MIN * 60 * 1000) {
    throw Object.assign(
      new Error("OTP expired. Please request a new OTP."),
      { statusCode: 400 }
    );
  }

  const incomingHash = hashOtp(email, String(otp).trim());

  if (incomingHash !== otpDoc.otp) {
    throw Object.assign(new Error("Invalid OTP"), { statusCode: 400 });
  }
}

async function markOtpUsed(otpDoc, options = {}) {
  const { userId = null } = options;

  await VerifyOtpModel.updateOne(
    { _id: otpDoc._id, status: 0 },
    {
      $set: {
        status: 1,
        userId: userId || otpDoc.userId || null,
      },
    }
  ).exec();
}

function msToWaitString(ms) {
  const sec = Math.ceil(ms / 1000);
  if (sec <= 60) return `${sec} seconds`;

  const min = Math.ceil(sec / 60);
  if (min <= 60) return `${min} minutes`;

  const hr = Math.ceil(min / 60);
  return `${hr} hours`;
}

async function getSigninLimitDoc(email) {
  return VerifyOtpModel.findOneAndUpdate(
    {
      email: norm(email),
      role: "influencer",
      docType: "limit",
      key: "signin_limit",
    },
    {
      $setOnInsert: {
        email: norm(email),
        role: "influencer",
        docType: "limit",
        key: "signin_limit",
        otp: "__SIGNIN_LIMIT__",
        status: 0,
        userId: null,
        signinFailedCount: 0,
        signinCooldownUntil: null,
        signinResetAt: null,
      },
    },
    { new: true, upsert: true }
  ).exec();
}

async function enforceOtpLimitByKey(email, role, key) {
  const normalizedEmail = norm(email);
  const normalizedRole = String(role || "").trim().toLowerCase();
  const nowMs = Date.now();

  const limitDoc = await VerifyOtpModel.findOneAndUpdate(
    {
      email: normalizedEmail,
      role: normalizedRole,
      docType: "limit",
      key,
    },
    {
      $setOnInsert: {
        email: normalizedEmail,
        role: normalizedRole,
        otp: key === "signup_limit" ? "__SIGNUP_LIMIT__" : "__FORGOT_LIMIT__",
        status: 0,
        userId: null,
        docType: "limit",
        key,
        signupOtpSend: OTP_LIMIT_MAX,
        signupOtpBatchCount: 0,
        signupOtpCooldownUntil: null,
        signupOtpResetAt: null,
      },
    },
    { new: true, upsert: true }
  ).exec();

  if (
    limitDoc.signupOtpResetAt &&
    nowMs >= new Date(limitDoc.signupOtpResetAt).getTime()
  ) {
    limitDoc.signupOtpSend = OTP_LIMIT_MAX;
    limitDoc.signupOtpBatchCount = 0;
    limitDoc.signupOtpCooldownUntil = null;
    limitDoc.signupOtpResetAt = null;
    await limitDoc.save();
  }

  if ((limitDoc.signupOtpSend ?? OTP_LIMIT_MAX) <= 0) {
    if (!limitDoc.signupOtpResetAt) {
      limitDoc.signupOtpResetAt = new Date(
        nowMs + OTP_RESET_HOURS * 60 * 60 * 1000
      );
      await limitDoc.save();
    }

    const e = new Error("Try again after 24 hours.");
    e.statusCode = 429;
    throw e;
  }

  if (
    limitDoc.signupOtpCooldownUntil &&
    nowMs < new Date(limitDoc.signupOtpCooldownUntil).getTime()
  ) {
    const waitMs =
      new Date(limitDoc.signupOtpCooldownUntil).getTime() - nowMs;

    const e = new Error(`Try again in ${msToWaitString(waitMs)}.`);
    e.statusCode = 429;
    throw e;
  }

  limitDoc.signupOtpSend = (limitDoc.signupOtpSend ?? OTP_LIMIT_MAX) - 1;
  limitDoc.signupOtpBatchCount = (limitDoc.signupOtpBatchCount ?? 0) + 1;

  if (limitDoc.signupOtpBatchCount >= OTP_BATCH_LIMIT) {
    limitDoc.signupOtpCooldownUntil = new Date(
      nowMs + OTP_LIMIT_COOLDOWN_MIN * 60 * 1000
    );
    limitDoc.signupOtpBatchCount = 0;
  }

  if (limitDoc.signupOtpSend <= 0) {
    limitDoc.signupOtpSend = 0;
    limitDoc.signupOtpResetAt = new Date(
      nowMs + OTP_RESET_HOURS * 60 * 60 * 1000
    );
  }

  await limitDoc.save();
}

async function enforceSigninLimit2(email) {
  const nowMs = Date.now();
  const doc = await getSigninLimitDoc(email);

  if (doc.signinResetAt && nowMs >= new Date(doc.signinResetAt).getTime()) {
    clearSigninLimitFields(doc);
    await doc.save();
  }

  if (
    doc.signinCooldownUntil &&
    nowMs < new Date(doc.signinCooldownUntil).getTime()
  ) {
    const waitMs = new Date(doc.signinCooldownUntil).getTime() - nowMs;
    const isFinalLock =
      (doc.signinFailedCount ?? 0) >= SIGNIN_STAGE_3_TOTAL ||
      Boolean(doc.signinResetAt);

    const e = new Error(
      isFinalLock
        ? "Too many failed login attempts. Try again after 24 hours."
        : `Too many failed login attempts. Try again in ${msToWaitString(waitMs)}.`
    );

    e.statusCode = 429;
    throw e;
  }

  if (
    (doc.signinFailedCount ?? 0) >= SIGNIN_STAGE_3_TOTAL &&
    doc.signinResetAt &&
    nowMs < new Date(doc.signinResetAt).getTime()
  ) {
    const e = new Error(
      "Too many failed login attempts. Try again after 24 hours."
    );
    e.statusCode = 429;
    throw e;
  }
}

async function recordFailedSignin2(email) {
  const nowMs = Date.now();
  const doc = await getSigninLimitDoc(email);

  if (doc.signinResetAt && nowMs >= new Date(doc.signinResetAt).getTime()) {
    clearSigninLimitFields(doc);
  }

  let currentFailedCount = Number(doc.signinFailedCount || 0);

  if (currentFailedCount >= SIGNIN_STAGE_3_TOTAL) {
    currentFailedCount = SIGNIN_STAGE_3_TOTAL;
  }

  doc.signinFailedCount = currentFailedCount + 1;

  if (doc.signinFailedCount === SIGNIN_STAGE_1_TOTAL) {
    doc.signinCooldownUntil = new Date(
      nowMs + SIGNIN_LOCK_1_MIN * 60 * 1000
    );
  } else if (doc.signinFailedCount === SIGNIN_STAGE_2_TOTAL) {
    doc.signinCooldownUntil = new Date(
      nowMs + SIGNIN_LOCK_15_MIN * 60 * 1000
    );
  } else if (doc.signinFailedCount >= SIGNIN_STAGE_3_TOTAL) {
    doc.signinFailedCount = SIGNIN_STAGE_3_TOTAL;
    doc.signinCooldownUntil = new Date(
      nowMs + SIGNIN_LOCK_24_HOURS * 60 * 60 * 1000
    );
    doc.signinResetAt = doc.signinCooldownUntil;
  }

  await doc.save();

  if (
    doc.signinCooldownUntil &&
    nowMs < new Date(doc.signinCooldownUntil).getTime()
  ) {
    const waitMs = new Date(doc.signinCooldownUntil).getTime() - nowMs;
    const isFinalLock = (doc.signinFailedCount ?? 0) >= SIGNIN_STAGE_3_TOTAL;

    const e = new Error(
      isFinalLock
        ? "Too many failed login attempts. Try again after 24 hours."
        : `Too many failed login attempts. Try again in ${msToWaitString(waitMs)}.`
    );

    e.statusCode = 429;
    throw e;
  }
}

async function resetSigninLimit(email) {
  await VerifyOtpModel.updateOne(
    {
      email: norm(email),
      role: "influencer",
      docType: "limit",
      key: "signin_limit",
    },
    {
      $set: {
        signinFailedCount: 0,
        signinCooldownUntil: null,
        signinResetAt: null,
      },
    }
  ).exec();
}

async function resetSigninLimit2(email) {
  return resetSigninLimit(email);
}

/* ========================== Signup OTP ========================== */
exports.sendSignupOtpInfluencer = async (req, res) => {
  let otpDoc = null;

  try {
    const { email, name, password, countryId, languageIds, categoryIds } =
      req.body || {};

    validateInfluencerSignupRequest(req.body || {});

    const normalizedEmail = norm(email);

    const existingBrand = await findBrandByEmailForInfluencerSignup(
      normalizedEmail
    );

    if (existingBrand) {
      return res.status(409).json({
        message:
          "This email is already registered as a brand. Please use another email.",
      });
    }

    const existingInfluencer = await findInfluencerByEmail(normalizedEmail);

    if (
      existingInfluencer &&
      !isPendingAdminCreatedInfluencer(existingInfluencer)
    ) {
      return res.status(409).json({
        message: "Email already registered. Please Login.",
      });
    }

    await enforceOtpLimitByKey(normalizedEmail, "influencer", "signup_limit");
    await clearPendingOtpDocs(normalizedEmail, "signup");

    const country = await Country.findById(countryId)
      .select("_id countryName countryCode callingCode")
      .lean();

    if (!country) {
      return res.status(400).json({ message: "Invalid countryId" });
    }

    const countryName = String(country.countryName ?? country.name ?? "").trim();

    if (!countryName) {
      return res.status(400).json({
        message: "Country name missing for this countryId",
      });
    }

    const langIds = uniqueValidObjectIds(languageIds);
    const catIds = uniqueValidObjectIds(categoryIds);

    if (langIds.length > 5) {
      return res.status(400).json({
        message: "Maximum 5 languages allowed",
      });
    }

    const [langs, cats] = await Promise.all([
      langIds.length
        ? Language.find({ _id: { $in: langIds } }).select("_id name").lean()
        : Promise.resolve([]),
      Category.find({ _id: { $in: catIds } }).select("_id name").lean(),
    ]);

    if (langIds.length && langs.length !== langIds.length) {
      return res.status(400).json({
        message: "One or more languageIds invalid",
      });
    }

    if (cats.length !== catIds.length) {
      return res.status(400).json({
        message: "One or more categoryIds invalid",
      });
    }

    const otpPlain = genOtp();
    const hashedPassword = await hashPassword(password);

    otpDoc = await createOtpDoc({
      email: normalizedEmail,
      purpose: "signup",
      otpPlain,
      signupPayload: buildInfluencerSignupPayload({
        name,
        password: hashedPassword,
        country,
        languages: langs,
        categories: cats,
      }),
    });

    const { subject, text, html } = buildOtpEmailTemplate({
      otp: otpPlain,
      role: "Influencer",
      expiryMinutes: OTP_TTL_MIN,
      purpose: "signup",
    });

    await sendMail({
      to: normalizedEmail,
      subject,
      text,
      html,
    });

    return res.status(200).json({
      message: "OTP sent successfully",
      email: normalizedEmail,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "SEND_SIGNUP_OTP_INFLUENCER_ERROR");
    if (otpDoc?._id) {
      try {
        await VerifyOtpModel.deleteOne({ _id: otpDoc._id }).exec();
      } catch (cleanupErr) {
        console.error("sendSignupOtpInfluencer cleanup error:", cleanupErr);
      }
    }

    console.error("sendSignupOtpInfluencer error:", error);

    return res.status(error?.statusCode || 500).json({
      message:
        error?.statusCode === 429
          ? error.message
          : error?.message || "Internal server error",
    });
  }
};
function buildSubscriptionFromPlan(plan) {
  return {
    planId: plan.planId,
    planName: plan.name,
    role: plan.role,
    planRef: plan._id,

    monthlyCost: plan.monthlyCost || 0,
    annualCost: plan.annualCost || 0,
    billingCycle: "monthly",

    autoRenew: false,
    status: "active",

    durationMins: plan.durationMins || 43200,
    startedAt: new Date(),
    expiresAt: null,

    features: Array.isArray(plan.features)
      ? plan.features.map((feature) => ({
        key: feature.key,
        value: feature.value ?? null,
        limit:
          typeof feature.value === "number"
            ? feature.value
            : typeof feature.limit === "number"
              ? feature.limit
              : 0,
        used: 0,
        note: feature.note || null,
        resetsEvery: feature.resetsEvery || null,
        resetsAt: null,
      }))
      : [],

    internalCredits: {
      used: 0,
      resetsAt: null,
    },
  };
}
exports.verifyOtpSignUpInfluencer = async (req, res) => {
  try {
    const { email, otp, location } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        message: "Valid email is required",
      });
    }

    if (!otp || !/^\d{6}$/.test(String(otp).trim())) {
      return res.status(400).json({
        message: "Valid 6-digit OTP is required",
      });
    }

    const normalizedEmail = norm(email);
    const otpDoc = await getLatestPendingOtp(normalizedEmail, "signup");

    if (!otpDoc) {
      const existingInfluencer = await findInfluencerByEmail(normalizedEmail);

      if (
        existingInfluencer &&
        !isPendingAdminCreatedInfluencer(existingInfluencer)
      ) {
        return res.status(409).json({
          message: "Email already registered. Please Login.",
        });
      }

      return res.status(400).json({
        message: "OTP not requested or expired. Please request a new OTP.",
      });
    }

    assertValidOtpDoc(otpDoc, normalizedEmail, otp);

    const payload = otpDoc.signupPayload || {};
    const cleanName = String(payload?.name || "").trim();
    const countryName = String(payload?.country?.name || "").trim();

    if (!cleanName) {
      return res.status(400).json({
        message: "Signup details missing (name). Please request OTP again.",
      });
    }

    if (!countryName) {
      return res.status(400).json({
        message: "Signup details missing (country). Please request OTP again.",
      });
    }

    if (!payload?.password) {
      return res.status(400).json({
        message: "Signup details missing (password). Please request OTP again.",
      });
    }

    const existingBrand = await findBrandByEmailForInfluencerSignup(
      normalizedEmail
    );

    if (existingBrand) {
      await clearAllOtpDocs(normalizedEmail, "signup");

      return res.status(409).json({
        message:
          "This email is already registered as a brand. Please use another email.",
      });
    }

    const existingInfluencer = await findInfluencerByEmail(normalizedEmail);

    if (
      existingInfluencer &&
      !isPendingAdminCreatedInfluencer(existingInfluencer)
    ) {
      await clearAllOtpDocs(normalizedEmail, "signup");

      return res.status(409).json({
        message: "Email already registered. Please Login.",
      });
    }

    const freePlan = await SubscriptionPlan.findOne({
      role: "Influencer",
      name: "free",
      status: "active",
    });

    if (!freePlan && !existingInfluencer?.subscription?.planId) {
      return res.status(500).json({
        message: "Free influencer plan not found",
      });
    }

    const cleanLanguages = Array.isArray(payload?.languages)
      ? payload.languages
        .filter(
          (item) =>
            item &&
            typeof item.name === "string" &&
            item.name.trim().length > 0
        )
        .map((item) => ({
          _id: item._id || undefined,
          name: String(item.name).trim(),
        }))
      : [];

    const cleanCategories = Array.isArray(payload?.categories)
      ? payload.categories
        .filter(
          (item) =>
            item &&
            typeof item.name === "string" &&
            item.name.trim().length > 0
        )
        .map((item) => ({
          _id: item._id || undefined,
          name: String(item.name).trim(),
        }))
      : [];

    let proxyEmail = existingInfluencer?.proxyEmail || "";
    let savedInfluencer = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        if (!proxyEmail) {
          proxyEmail = await generateUniqueInfluencerProxyEmail(cleanName);
        }

        if (
          existingInfluencer &&
          isPendingAdminCreatedInfluencer(existingInfluencer)
        ) {
          existingInfluencer.email = normalizedEmail;
          existingInfluencer.name = cleanName;
          existingInfluencer.location = location || "";
          existingInfluencer.countryId = payload?.country?._id || undefined;
          existingInfluencer.countryName = countryName;
          existingInfluencer.country = countryName;
          existingInfluencer.languages = cleanLanguages;
          existingInfluencer.categories = cleanCategories;
          existingInfluencer.password = payload.password;
          existingInfluencer.primaryPlatform = null;
          existingInfluencer.page1 = [];
          existingInfluencer.page2 = [];
          existingInfluencer.page3 = [];
          existingInfluencer.ispage2Skip = false;
          existingInfluencer.ispage3Skip = false;
          existingInfluencer.proxyEmail = proxyEmail;

          existingInfluencer.signupCompleted = true;
          existingInfluencer.signupCompletedAt = new Date();

          // Keep true for audit history.
          existingInfluencer.isAdminCreated = true;

          if (!existingInfluencer.subscription?.planId && freePlan) {
            existingInfluencer.subscription = buildSubscriptionFromPlan(freePlan);
          }

          existingInfluencer.subscriptionExpired = false;

          savedInfluencer = await existingInfluencer.save();
        } else {
          savedInfluencer = await InfluencerModel.create({
            email: normalizedEmail,
            name: cleanName,
            location: location || "",
            countryId: payload?.country?._id || undefined,
            countryName,
            country: countryName,
            languages: cleanLanguages,
            categories: cleanCategories,
            password: payload.password,
            primaryPlatform: null,
            page1: [],
            page2: [],
            page3: [],
            ispage2Skip: false,
            ispage3Skip: false,
            proxyEmail,

            isAdminCreated: false,
            signupCompleted: true,
            signupCompletedAt: new Date(),

            subscription: buildSubscriptionFromPlan(freePlan),
            subscriptionExpired: false,
          });
        }

        break;
      } catch (saveErr) {
        if (saveErr?.code === 11000 && saveErr?.keyPattern?.proxyEmail) {
          proxyEmail = "";
          continue;
        }

        throw saveErr;
      }
    }

    if (!savedInfluencer) {
      return res.status(500).json({
        message: "Unable to allocate proxy email",
      });
    }

    await markOtpUsed(otpDoc, {
      userId: savedInfluencer._id,
    });

    await clearAllOtpDocs(normalizedEmail, "signup");
    await clearAllOtpDocs(normalizedEmail, "reset_password");

    const token = jwt.sign(
      {
        _id: savedInfluencer._id.toString(),
        role: "influencer",
        email: savedInfluencer.email,
      },
      JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
      }
    );

    const routeInfo = computeInfluencerNextRoute(savedInfluencer);

    return res.status(201).json({
      message: "Influencer signup successful",
      _id: savedInfluencer._id.toString(),
      proxyEmail: savedInfluencer.proxyEmail,
      token,
      route: routeInfo.route,
      onboarding: {
        page1Done: routeInfo.page1Done,
        page2Done: routeInfo.page2Done,
        page3Done: routeInfo.page3Done,
      },
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VERIFY_OTP_SIGN_UP_INFLUENCER_ERROR");
    console.error("verifyOtpSignUpInfluencer error:", err);

    if (err?.code === 11000) {
      if (err?.keyPattern?.email) {
        return res.status(409).json({
          message: "Email already registered. Please Login.",
        });
      }

      if (err?.keyPattern?.proxyEmail) {
        return res.status(409).json({
          message: "Proxy email conflict. Please try again.",
        });
      }

      return res.status(409).json({
        message: "Duplicate data found. Please try again.",
      });
    }

    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
    });
  }
};

/* ============================== Onboarding ============================== */
exports.saveQuickOnboarding = async (req, res) => {
  try {
    const user = req.user || req.influencer;
    const influencerMongoId = getAuthenticatedInfluencerMongoId(req);

    if (!influencerMongoId) {
      return res.status(401).json({
        message: "Invalid token payload",
      });
    }

    if (user?.role && user.role !== "influencer") {
      return res.status(403).json({
        message: "Invalid role",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(401).json({
        message: "Invalid token payload",
      });
    }

    const { page1, page2, page3, ispage2Skip, ispage3Skip, preferredPlatform } =
      req.body;

    const isObjectArray = (arr) =>
      Array.isArray(arr) &&
      arr.every((x) => x && typeof x === "object" && !Array.isArray(x));

    if (page1 !== undefined && !isObjectArray(page1)) {
      return res.status(400).json({
        message: "page1 must be an array of objects",
      });
    }

    if (page2 !== undefined && !isObjectArray(page2)) {
      return res.status(400).json({
        message: "page2 must be an array of objects",
      });
    }

    if (page3 !== undefined && !isObjectArray(page3)) {
      return res.status(400).json({
        message: "page3 must be an array of objects",
      });
    }

    if (ispage2Skip !== undefined && typeof ispage2Skip !== "boolean") {
      return res.status(400).json({
        message: "ispage2Skip must be boolean",
      });
    }

    if (ispage3Skip !== undefined && typeof ispage3Skip !== "boolean") {
      return res.status(400).json({
        message: "ispage3Skip must be boolean",
      });
    }

    if (ispage2Skip === true && page2 !== undefined) {
      return res.status(400).json({
        message: "Cannot provide page2 when ispage2Skip is true",
      });
    }

    if (ispage3Skip === true && page3 !== undefined) {
      return res.status(400).json({
        message: "Cannot provide page3 when ispage3Skip is true",
      });
    }

    const existing = await InfluencerModel.findById(influencerMongoId)
      .select("_id page1 page2 page3 ispage2Skip ispage3Skip primaryPlatform")
      .exec();

    if (!existing) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    const page1AlreadySaved =
      Array.isArray(existing.page1) && existing.page1.length > 0;

    if (!page1AlreadySaved && page1 === undefined) {
      return res.status(400).json({
        message: "page1 is required",
      });
    }

    const update = {};
    let profiles = [];

    if (page1 !== undefined) {
      if (!page1.length) {
        return res.status(400).json({
          message: "page1 cannot be empty",
        });
      }

      const normalizedPage1 = page1.map((item) => {
        const platform = String(item?.platform || item?.provider || "")
          .trim()
          .toLowerCase();

        return {
          ...item,
          platform,
        };
      });

      const validPage1Items = normalizedPage1.filter((item) => {
        const hasPlatform = Boolean(item.platform);
        const hasIdentity =
          Boolean(item.handle) || Boolean(item.username) || Boolean(item.data);

        return hasPlatform && hasIdentity;
      });

      if (!validPage1Items.length) {
        return res.status(400).json({
          message:
            "At least one valid page1 item is required with platform and handle/username/data",
        });
      }

      profiles = validPage1Items.map(mapOnboardingPage1ToProfile).filter(Boolean);

      if (!profiles.length) {
        return res.status(400).json({
          message: "No valid platform payloads provided in page1",
        });
      }

      const idx = await buildCategoryIndex();

      for (const prof of profiles) {
        let rawCats = [];

        if (Array.isArray(prof.categories) && prof.categories.length) {
          rawCats = prof.categories;
        } else {
          rawCats = extractRawCategoriesFromProviderRaw(prof.providerRaw);
        }

        prof.categories = normalizeCategories(rawCats, idx);
      }

      const validProviders = new Set(profiles.map((p) => p.provider));

      const primaryFromPage =
        validPage1Items.find((x) => x?.isPrimary)?.platform ||
        preferredPlatform ||
        null;

      const normalizedPreferred = primaryFromPage
        ? String(primaryFromPage).trim().toLowerCase()
        : null;

      let primaryPlatform = profiles[0]?.provider || null;

      if (normalizedPreferred && validProviders.has(normalizedPreferred)) {
        primaryPlatform = normalizedPreferred;
      }

      update.page1 = validPage1Items;
      update.primaryPlatform = primaryPlatform;
    }

    if (ispage2Skip === true) {
      update.ispage2Skip = true;
      update.page2 = [];
    } else {
      if (ispage2Skip !== undefined) update.ispage2Skip = ispage2Skip;
      if (page2 !== undefined) update.page2 = page2;
    }

    if (ispage3Skip === true) {
      update.ispage3Skip = true;
      update.page3 = [];
    } else {
      if (ispage3Skip !== undefined) update.ispage3Skip = ispage3Skip;
      if (page3 !== undefined) update.page3 = page3;
    }

    const influencer = await InfluencerModel.findByIdAndUpdate(
      influencerMongoId,
      { $set: update },
      { new: true }
    )
      .select(
        "_id email page1 page2 page3 ispage2Skip ispage3Skip primaryPlatform"
      )
      .exec();

    if (!influencer) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    if (profiles.length) {
      try {
        const publicInfluencerId = getInfluencerPublicId(influencer);

        await Promise.all(
          profiles.map(async (prof) => {
            const raw = prof.providerRaw || {};
            const profileRoot = raw.profile || raw;
            const nestedProf = profileRoot.profile || profileRoot;

            const userId =
              prof.userId ||
              prof.secUid ||
              prof.username ||
              raw.userId ||
              profileRoot.userId ||
              nestedProf.userId ||
              stripAt(prof.handle);

            if (!userId) {
              console.warn(
                "[saveQuickOnboarding] Skipping Modash upsert because no userId/secUid/username/handle found",
                { provider: prof.provider }
              );
              return;
            }

            await Modash.findOneAndUpdate(
              { provider: prof.provider, userId },
              {
                $set: {
                  influencer: influencer._id,

                  // Existing Modash schema field is named influencerId.
                  // Store MongoDB _id string in it.
                  influencerId: publicInfluencerId,

                  userId,
                  ...prof,
                },
              },
              {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
              }
            );
          })
        );
      } catch (modashErr) {
        console.error("saveQuickOnboarding modash sync error:", modashErr);
      }
    }

    const routeInfo = computeInfluencerNextRoute(influencer);

    return res.status(200).json({
      message: "Onboarding questions saved successfully",
      _id: influencer._id.toString(),
      primaryPlatform: influencer.primaryPlatform || null,
      page1: influencer.page1 || [],
      page2: influencer.page2 || [],
      page3: influencer.page3 || [],
      ispage2Skip: influencer.ispage2Skip || false,
      ispage3Skip: influencer.ispage3Skip || false,
      route: routeInfo.route,
      onboarding: {
        page1Done: routeInfo.page1Done,
        page2Done: routeInfo.page2Done,
        page3Done: routeInfo.page3Done,
      },
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SAVE_QUICK_ONBOARDING_ERROR");
    console.error("saveQuickOnboarding error:", err);

    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
    });
  }
};

/* ============================== Sign In ============================== */
exports.signInInfluencer = async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        message: "Valid email is required",
      });
    }

    if (!password || !String(password).trim()) {
      return res.status(400).json({
        message: "Valid password is required",
      });
    }

    const normalizedEmail = norm(email);

    await enforceSigninLimit2(normalizedEmail);

    const influencer = await findInfluencerByEmail(normalizedEmail, true);

    if (!influencer) {
      return res.status(404).json({
        message: "Email does not exist. Please sign up.",
      });
    }

    assertNotPendingAdminCreatedInfluencer(influencer);

    if (!influencer.password) {
      return res.status(400).json({
        message: "Password not set. Please use forgot password.",
      });
    }

    let ok = false;

    if (
      typeof influencer.password === "string" &&
      influencer.password.startsWith("$2")
    ) {
      ok = await bcrypt.compare(String(password), String(influencer.password));
    } else {
      ok = String(password) === String(influencer.password);
    }

    if (!ok) {
      await recordFailedSignin2(normalizedEmail);

      return res.status(400).json({
        message: "Incorrect password",
      });
    }

    await resetSigninLimit2(normalizedEmail);

    const token = signJwt({
      _id: influencer._id.toString(),
      role: "influencer",
      email: influencer.email,
    });

    const routeInfo = computeInfluencerNextRoute(influencer);

    return res.status(200).json({
      message: "Influencer sign in successful",
      _id: influencer._id.toString(),
      token,
      route: routeInfo.route,
      onboarding: {
        page1Done: routeInfo.page1Done,
        page2Done: routeInfo.page2Done,
        page3Done: routeInfo.page3Done,
      },
      page1: influencer.page1 || [],
      page2: influencer.page2 || [],
      page3: influencer.page3 || [],
      ispage2Skip: influencer.ispage2Skip || false,
      ispage3Skip: influencer.ispage3Skip || false,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SIGN_IN_INFLUENCER_ERROR");
    console.error("signInInfluencer error:", err);

    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
    });
  }
};

exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(403).json({
      message: "Token required",
    });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({
        message: "Invalid or expired token",
      });
    }

    req.influencer = decoded;
    req.user = decoded;
    return next();
  });
};

/* ============================== Read APIs ============================== */
exports.getList = async (req, res) => {
  try {
    const influencers = await Influencer.find({}, "-password -__v");
    return res.status(200).json(influencers);
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_LIST_ERROR");
    console.error("Error fetching influencers:", error);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.getById = async (req, res) => {
  try {
    const id = String(req.query?._id || req.query?.id || "").trim();

    if (!id) {
      return res.status(400).json({
        message: 'Query parameter "_id" or "id" is required.',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Valid influencer _id is required.",
      });
    }

    const influencer = await InfluencerModel.findById(id)
      .select("-password -__v")
      .lean();

    if (!influencer) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    influencer.socialProfiles = await loadSocialProfilesFromModash(id);

    return res.status(200).json({
      influencer,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BY_ID_ERROR");
    console.error("Error in getById:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.getBulkByIds = async (req, res) => {
  try {
    const ids = req.body?._ids || req.body?.ids || [];

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        message: 'Body parameter "_ids" or "ids" must be a non-empty array.',
      });
    }

    const cleanIds = [
      ...new Set(
        ids
          .map((id) => String(id || "").trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      ),
    ];

    if (!cleanIds.length) {
      return res.status(400).json({
        message: "At least one valid influencer _id is required.",
      });
    }

    const influencers = await InfluencerModel.find({
      _id: { $in: cleanIds.map((id) => toObjectId(id)) },
    })
      .select("-password -__v")
      .lean();

    const influencerMap = new Map(
      influencers.map((inf) => [String(inf._id), inf])
    );

    const result = cleanIds.map((id) => {
      const influencer = influencerMap.get(id);

      if (!influencer) {
        return {
          _id: id,
          found: false,
          message: "Influencer not found",
        };
      }

      return {
        ...influencer,
        _id: String(influencer._id),
        found: true,
      };
    });

    return res.status(200).json({
      count: result.length,
      influencers: result,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BULK_BY_IDS_ERROR");
    console.error("Error in getBulkByIds:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.getLiteById = async (req, res) => {
  try {
    const influencerId = String(
      req.query?.influencerId ||
      req.query?.id ||
      req.user?._id ||
      req.user?.id ||
      req.influencer?._id ||
      req.influencer?.id ||
      ""
    ).trim();

    if (!influencerId) {
      return res.status(400).json({
        message: 'Query parameter "influencerId" is required.',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(influencerId)) {
      return res.status(400).json({
        message: "Valid influencer _id is required.",
      });
    }

    const doc = await InfluencerModel.findById(influencerId)
      .select(
        "_id name email profileImage profilePic profilePicture avatar image photo primaryPlatform subscription.planId subscription.planName subscription.expiresAt"
      )
      .lean();

    if (!doc) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    let socialProfiles = [];

    try {
      socialProfiles = await loadSocialProfilesFromModash(influencerId);
    } catch (err) {
      console.error("Failed to load social profiles from Modash:", err);
      socialProfiles = [];
    }

    let primaryProfile = null;

    if (Array.isArray(socialProfiles) && socialProfiles.length) {
      primaryProfile =
        socialProfiles.find((p) => p.provider === doc.primaryPlatform) ||
        socialProfiles
          .slice()
          .sort((a, b) => Number(b.followers || 0) - Number(a.followers || 0))[0];
    }

    const pickImage = (value) => {
      if (!value || typeof value !== "object") return "";

      return (
        value.profileImage ||
        value.profilePic ||
        value.profilePicture ||
        value.avatar ||
        value.picture ||
        value.image ||
        value.imageUrl ||
        value.photo ||
        value.thumbnail ||
        value.profilePictureUrl ||
        value.profile_pic_url ||
        ""
      );
    };

    const profileImage =
      pickImage(doc) ||
      pickImage(primaryProfile) ||
      socialProfiles.map(pickImage).find(Boolean) ||
      "";

    return res.status(200).json({
      _id: String(doc._id),
      influencerId: String(doc._id),
      name: doc.name || "",
      email: doc.email || "",
      profileImage,
      planId: doc.subscription?.planId || null,
      planName: doc.subscription?.planName || null,
      expiresAt: doc.subscription?.expiresAt || null,
      primaryPlatform: doc.primaryPlatform || null,
      socialProfiles,
      primaryProfile,
      socialProfilesCount: Array.isArray(socialProfiles)
        ? socialProfiles.length
        : 0,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_LITE_BY_ID_ERROR");
    console.error("Error in getLiteById:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.getLiteInfluencerByIdPost = async (req, res) => {
  try {
    const id = String(req.body?._id || req.body?.id || "").trim();

    if (!id) {
      return res.status(400).json({
        message: "_id is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Valid influencer _id is required",
      });
    }

    const influencer = await InfluencerModel.findById(id)
      .select("_id name email")
      .lean();

    if (!influencer) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    return res.status(200).json({
      _id: String(influencer._id),
      name: influencer.name || "",
      email: influencer.email || "",
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_LITE_INFLUENCER_BY_ID_POST_ERROR");
    console.error("Error in getLiteInfluencerByIdPost:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

/* ============================== Campaigns ============================== */
exports.getCampaignsByInfluencer = async (req, res) => {
  try {
    const {
      influencerId,
      page = 1,
      limit = 10,
      search = "",
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.body || {};

    const influencerMongoId = String(influencerId || "").trim();

    if (!influencerMongoId) {
      return res.status(400).json({
        message: "influencerId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(400).json({
        message: "Valid influencerId is required",
      });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.max(parseInt(limit, 10) || 10, 1);
    const skip = (pageNum - 1) * limitNum;
    const sortDirection = sortOrder === "asc" ? 1 : -1;

    const safeSortFields = [
      "createdAt",
      "updatedAt",
      "campaignTitle",
      "brandName",
      "campaignBudget",
      "budget",
      "startAt",
      "endAt",
      "status",
      "publishedAt",
    ];

    const finalSortBy = safeSortFields.includes(sortBy) ? sortBy : "createdAt";

    const influencer = await InfluencerModel.findById(
      influencerMongoId,
      "_id name email"
    ).lean();

    if (!influencer) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    const internalInfluencerId = String(influencer._id);
    const influencerName = influencer.name || "";

    const applyDocs = await ApplyCampaign.find({
      $or: [
        { "applicants.influencerId": internalInfluencerId },
        { "approved.influencerId": internalInfluencerId },
      ],
    }).lean();

    if (!applyDocs.length) {
      return res.status(200).json({
        total: 0,
        page: pageNum,
        pages: 0,
        influencer: {
          _id: internalInfluencerId,
          influencerId: internalInfluencerId,
          name: influencerName,
          email: influencer.email || "",
        },
        campaigns: [],
      });
    }

    const campaignIds = [
      ...new Set(
        applyDocs
          .map((doc) => String(doc.campaignId || "").trim())
          .filter(Boolean)
      ),
    ];

    const campaignObjectIds = campaignIds
      .filter((campaignId) => mongoose.Types.ObjectId.isValid(campaignId))
      .map((campaignId) => new mongoose.Types.ObjectId(campaignId));

    if (!campaignObjectIds.length) {
      return res.status(200).json({
        total: 0,
        page: pageNum,
        pages: 0,
        influencer: {
          _id: internalInfluencerId,
          influencerId: internalInfluencerId,
          name: influencerName,
          email: influencer.email || "",
        },
        campaigns: [],
      });
    }

    const filter = {
      _id: { $in: campaignObjectIds },
    };

    if (search && String(search).trim()) {
      const s = String(search).trim();

      filter.$and = [
        {
          $or: [
            { campaignTitle: { $regex: s, $options: "i" } },
            { brandName: { $regex: s, $options: "i" } },
            { description: { $regex: s, $options: "i" } },
            { campaignType: { $regex: s, $options: "i" } },
            { campaignCategory: { $regex: s, $options: "i" } },
            { campaignSubcategory: { $regex: s, $options: "i" } },
            { hashtags: { $elemMatch: { $regex: s, $options: "i" } } },
            { productLink: { $regex: s, $options: "i" } },
            { videoLink: { $regex: s, $options: "i" } },
          ],
        },
      ];
    }

    const total = await Campaign.countDocuments(filter);

    const campaigns = await Campaign.find(filter)
      .sort({ [finalSortBy]: sortDirection })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const allCountryIds = [
      ...new Set(
        campaigns.flatMap((campaign) =>
          Array.isArray(campaign.targetCountryIds)
            ? campaign.targetCountryIds.map((countryId) => String(countryId))
            : []
        )
      ),
    ].filter((countryId) => mongoose.Types.ObjectId.isValid(countryId));

    const allAgeRangeIds = [
      ...new Set(
        campaigns.flatMap((campaign) =>
          Array.isArray(campaign.targetAgeRanges)
            ? campaign.targetAgeRanges.map((ageRangeId) => String(ageRangeId))
            : []
        )
      ),
    ].filter((ageRangeId) => mongoose.Types.ObjectId.isValid(ageRangeId));

    const allCampaignGoalIds = [
      ...new Set(
        campaigns.flatMap((campaign) =>
          Array.isArray(campaign.campaignGoals)
            ? campaign.campaignGoals.map((goalId) => String(goalId))
            : []
        )
      ),
    ].filter((goalId) => mongoose.Types.ObjectId.isValid(goalId));

    const getBrandMongoId = (campaign = {}) => {
      const rawBrandId =
        campaign?.createdBy?.userModel === "Brand"
          ? campaign?.createdBy?.userId
          : campaign?.createdBy?.userId ||
          campaign?.brandId ||
          campaign?.brand?._id ||
          campaign?.createdByBrand ||
          campaign?.userId ||
          "";

      const brandMongoId = String(rawBrandId || "").trim();

      return mongoose.Types.ObjectId.isValid(brandMongoId)
        ? brandMongoId
        : "";
    };

    const brandMongoIds = [
      ...new Set(campaigns.map(getBrandMongoId).filter(Boolean)),
    ];

    const [countries, ageRanges, campaignGoals, brands] = await Promise.all([
      allCountryIds.length
        ? Country.find(
          { _id: { $in: allCountryIds } },
          "_id countryNameEn countryNameLocal countryName name countryCode"
        ).lean()
        : Promise.resolve([]),

      allAgeRangeIds.length
        ? AgeRange.find({ _id: { $in: allAgeRangeIds } }, "_id range").lean()
        : Promise.resolve([]),

      allCampaignGoalIds.length
        ? ProductServiceGoalModel.find(
          { _id: { $in: allCampaignGoalIds } },
          "_id goal"
        ).lean()
        : Promise.resolve([]),

      brandMongoIds.length
        ? Brand.find(
          {
            _id: {
              $in: brandMongoIds.map(
                (brandId) => new mongoose.Types.ObjectId(brandId)
              ),
            },
          },
          "_id brandName name email proxyEmail website profilePic industry companySize companyDetails pocContact currencyFormat preferredLanguage region"
        ).lean()
        : Promise.resolve([]),
    ]);

    const getCountryName = (item = {}) =>
      String(
        item.countryNameEn ||
        item.countryName ||
        item.name ||
        item.countryNameLocal ||
        item.countryCode ||
        ""
      ).trim();

    const countryMap = new Map(
      countries.map((item) => [String(item._id), getCountryName(item)])
    );

    const ageRangeMap = new Map(
      ageRanges.map((item) => [String(item._id), item.range || ""])
    );

    const campaignGoalMap = new Map(
      campaignGoals.map((item) => [String(item._id), item.goal || ""])
    );

    const brandMap = new Map(
      brands.map((brand) => [String(brand._id), brand])
    );

    const result = campaigns.map((campaign) => {
      const campaignId = String(campaign._id);

      const related = applyDocs.find(
        (doc) => String(doc.campaignId || "") === campaignId
      );

      const approvedApplicant = related?.approved?.find(
        (item) => String(item.influencerId || "") === internalInfluencerId
      );

      const applicant = related?.applicants?.find(
        (item) => String(item.influencerId || "") === internalInfluencerId
      );

      let applicationStatus = "pending";

      if (approvedApplicant) {
        applicationStatus = "approved";
      } else if (applicant) {
        applicationStatus = "applied";
      }

      const targetCountryIds = Array.isArray(campaign.targetCountryIds)
        ? campaign.targetCountryIds.map((countryId) => String(countryId))
        : [];

      const targetAgeRanges = Array.isArray(campaign.targetAgeRanges)
        ? campaign.targetAgeRanges.map((ageRangeId) => String(ageRangeId))
        : [];

      const campaignGoalsIds = Array.isArray(campaign.campaignGoals)
        ? campaign.campaignGoals.map((goalId) => String(goalId))
        : [];

      const targetCountryValues = targetCountryIds
        .map((countryId) => countryMap.get(countryId))
        .filter(Boolean);

      const targetCountry =
        targetCountryValues.length > 0
          ? targetCountryValues.join(", ")
          : campaign.targetCountry || "";

      const targetAgeGroupValues = targetAgeRanges.map(
        (ageRangeId) => ageRangeMap.get(ageRangeId) || ageRangeId
      );

      const campaignGoalValues = campaignGoalsIds.map(
        (goalId) => campaignGoalMap.get(goalId) || goalId
      );

      const brandMongoId = getBrandMongoId(campaign);
      const brandDoc = brandMongoId ? brandMap.get(brandMongoId) : null;

      const resolvedBrandId = brandDoc?._id
        ? String(brandDoc._id)
        : brandMongoId;

      const resolvedBrandName =
        brandDoc?.brandName ||
        brandDoc?.name ||
        campaign.brandName ||
        "";

      const resolvedBrandProfilePic =
        brandDoc?.profilePic ||
        campaign.brandProfilePic ||
        campaign.brandprofilepic ||
        campaign.brandLogoUrl ||
        campaign.brandLogo ||
        "";

      return {
        id: campaignId,
        campaignId,

        brandId: resolvedBrandId,
        brand: {
          _id: resolvedBrandId,
          brandId: resolvedBrandId,
          brandName: resolvedBrandName,
          name: brandDoc?.name || "",
          email: brandDoc?.email || "",
          proxyEmail: brandDoc?.proxyEmail || "",
          website: brandDoc?.website || "",
          profilePic: resolvedBrandProfilePic,
          industry: brandDoc?.industry || "",
          companySize: brandDoc?.companySize || "",
          companyDetails: brandDoc?.companyDetails || "",
          pocContact: brandDoc?.pocContact || "",
          currencyFormat: brandDoc?.currencyFormat || "",
          preferredLanguage: brandDoc?.preferredLanguage || "",
          region: brandDoc?.region || "",
        },

        campaignName: campaign.campaignTitle || "",
        name: campaign.campaignTitle || "",
        campaignTitle: campaign.campaignTitle || "",

        brandName: resolvedBrandName,
        brandProfilePic: resolvedBrandProfilePic,
        brandLogoUrl: resolvedBrandProfilePic,

        influencer: {
          _id: internalInfluencerId,
          influencerId: internalInfluencerId,
          name: influencerName,
          email: influencer.email || "",
        },

        description: campaign.description || "",
        campaignType: campaign.campaignType || "",
        campaignCategory: campaign.campaignCategory || "",
        campaignSubcategory: campaign.campaignSubcategory || "",
        categoryId: campaign.categoryId || null,
        subcategoryIds: campaign.subcategoryIds || [],
        categories: campaign.categories || [],

        productImages: campaign.productImages || [],
        images: campaign.productImages || [],

        productLink: campaign.productLink || "",
        videoLink: campaign.videoLink || "",
        productServiceInfo: campaign.productServiceInfo || [],

        campaignGoals: campaign.campaignGoals || [],
        campaignGoalValues,

        influencerTierIds: campaign.influencerTierIds || [],
        contentFormats: campaign.contentFormats || [],
        contentLanguageIds: campaign.contentLanguageIds || [],
        preferredHashtags: campaign.preferredHashtags || [],

        targetCountryIds: campaign.targetCountryIds || [],
        targetCountryValues,
        targetCountries: targetCountryValues,
        targetCountry,

        targetAgeRanges: campaign.targetAgeRanges || [],
        targetAgeGroupValues,

        numberOfInfluencers: campaign.numberOfInfluencers || 0,
        influencerTier: campaign.influencerTier || "",
        minFollowers: campaign.minFollowers || 0,
        maxFollowers: campaign.maxFollowers || 0,

        creatorContentLanguage: campaign.creatorContentLanguage || "",
        audienceContentLanguage: campaign.audienceContentLanguage || "",

        campaignBudget: campaign.campaignBudget || 0,
        budget: campaign.budget || campaign.campaignBudget || 0,
        influencerBudget: campaign.influencerBudget || 0,
        paymentType: campaign.paymentType || "Milestone",

        platformSelection: campaign.platformSelection || [],
        hashtags: campaign.hashtags || [],
        additionalNotes: campaign.additionalNotes || "",
        campaignTimezone: campaign.campaignTimezone || "UTC",

        startAt: campaign.startAt || null,
        endAt: campaign.endAt || null,
        publishedAt: campaign.publishedAt || null,
        timeline: campaign.timeline || {},

        createdLocation: campaign.createdLocation || null,

        status: campaign.status || "draft",
        applicationStatus,
        publishStatus: campaign.publishStatus || "draft",
        approvalMode: campaign.approvalMode || "direct",

        isActive: campaign.isActive,
        isDraft: campaign.isDraft,
        byAi: campaign.byAi,

        applicantCount: campaign.applicantCount || 0,
        hasApplied: applicant || approvedApplicant ? 1 : 0,
        hasApproved: approvedApplicant ? 1 : 0,

        pendingUpdate: campaign.pendingUpdate || { status: "none" },

        createdBy: campaign.createdBy || null,

        appliedDate:
          applicant?.appliedAt ||
          applicant?.createdAt ||
          approvedApplicant?.approvedAt ||
          approvedApplicant?.createdAt ||
          related?.createdAt ||
          campaign.createdAt,

        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
      };
    });

    return res.status(200).json({
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      influencer: {
        _id: internalInfluencerId,
        influencerId: internalInfluencerId,
        name: influencerName,
        email: influencer.email || "",
      },
      campaigns: result,
    });
  } catch (error) {
    await saveErrorLog(
      req,
      error,
      error?.statusCode || error?.status || 500,
      "GET_CAMPAIGNS_BY_INFLUENCER_ERROR"
    );

    console.error("Error in getCampaignsByInfluencer:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

/* ============================ Password Reset ============================ */
exports.requestPasswordResetOtpInfluencer = async (req, res) => {
  let otpDoc = null;

  try {
    const { email } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        message: "Valid email is required",
      });
    }

    const normalizedEmail = norm(email);

    const influencer = await findInfluencerByEmail(normalizedEmail);

    if (!influencer) {
      return res.status(404).json({
        message: "Influencer account not found",
      });
    }

    assertNotPendingAdminCreatedInfluencer(influencer);

    await enforceOtpLimitByKey(normalizedEmail, "influencer", "forgot_limit");
    await clearPendingOtpDocs(normalizedEmail, "reset_password");

    const otpPlain = genOtp();

    otpDoc = await createOtpDoc({
      email: normalizedEmail,
      purpose: "reset_password",
      otpPlain,
      userId: influencer._id,
    });

    const subject = "Password reset code";

    const html = otpHtmlTemplate({
      title: "Password reset code",
      subtitle: "Use this one-time code to reset your password.",
      code: otpPlain,
      minutes: OTP_TTL_MIN,
      preheader: "Your password reset code",
    });

    const text = otpTextFallback({
      code: otpPlain,
      minutes: OTP_TTL_MIN,
      title: "Password reset code",
    });

    await sendMail({
      to: normalizedEmail,
      subject,
      html,
      text,
    });

    return res.status(200).json({
      message: "OTP sent for password reset",
      email: normalizedEmail,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "REQUEST_PASSWORD_RESET_OTP_INFLUENCER_ERROR");
    if (otpDoc?._id) {
      try {
        await VerifyOtpModel.deleteOne({ _id: otpDoc._id }).exec();
      } catch (cleanupErr) {
        console.error(
          "requestPasswordResetOtpInfluencer cleanup error:",
          cleanupErr
        );
      }
    }

    console.error("Error in requestPasswordResetOtpInfluencer:", err);

    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
    });
  }
};

exports.verifyPasswordResetOtpInfluencer = async (req, res) => {
  try {
    const { email, otp } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        message: "Valid email is required",
      });
    }

    if (!otp || !/^\d{6}$/.test(String(otp).trim())) {
      return res.status(400).json({
        message: "Valid 6-digit OTP is required",
      });
    }

    const normalizedEmail = norm(email);

    const influencer = await findInfluencerByEmail(normalizedEmail);

    if (!influencer) {
      return res.status(404).json({
        message: "Influencer account not found",
      });
    }

    assertNotPendingAdminCreatedInfluencer(influencer);

    const otpDoc = await getLatestPendingOtp(normalizedEmail, "reset_password");
    assertValidOtpDoc(otpDoc, normalizedEmail, otp);

    await markOtpUsed(otpDoc, {
      userId: influencer._id,
    });

    const resetToken = signResetJwt({
      tokenType: "pwd_reset",
      role: "influencer",
      _id: influencer._id.toString(),
      email: influencer.email,
      resetId: otpDoc._id.toString(),
    });

    return res.status(200).json({
      message: "OTP verified",
      resetToken,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VERIFY_PASSWORD_RESET_OTP_INFLUENCER_ERROR");
    console.error("Error in verifyPasswordResetOtpInfluencer:", err);

    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
    });
  }
};

exports.resetPasswordInfluencer = async (req, res) => {
  try {
    const { resetToken, newPassword, confirmPassword } = req.body || {};

    if (!resetToken || !newPassword) {
      return res.status(400).json({
        message: "resetToken and newPassword required",
      });
    }

    if (
      confirmPassword != null &&
      String(confirmPassword) !== String(newPassword)
    ) {
      return res.status(400).json({
        message: "Passwords do not match",
      });
    }

    if (!isStrongPassword(newPassword)) {
      return res.status(400).json({
        message:
          "Password must be at least 8 characters and include uppercase, lowercase, number, and special character",
      });
    }

    const decoded = jwt.verify(resetToken, JWT_SECRET);

    const influencerMongoId = String(decoded?._id || decoded?.id || "").trim();

    if (
      decoded?.tokenType !== "pwd_reset" ||
      decoded?.role !== "influencer" ||
      !influencerMongoId ||
      !decoded?.resetId ||
      !decoded?.email
    ) {
      return res.status(403).json({
        message: "Invalid reset token",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(403).json({
        message: "Invalid reset token",
      });
    }

    const otpDoc = await VerifyOtpModel.findOne({
      _id: decoded.resetId,
      email: norm(decoded.email),
      role: "influencer",
      status: 1,
      docType: "otp",
      purpose: "reset_password",
    }).exec();

    if (!otpDoc) {
      return res.status(400).json({
        message: "Invalid or expired reset request",
      });
    }

    const verifiedAt = new Date(otpDoc.updatedAt || otpDoc.createdAt).getTime();

    if (Date.now() - verifiedAt > RESET_TTL_MS) {
      return res.status(400).json({
        message: "Reset session expired. Verify OTP again.",
      });
    }

    const influencer = await InfluencerModel.findById(influencerMongoId)
      .select("+password")
      .exec();

    if (!influencer) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    assertNotPendingAdminCreatedInfluencer(influencer);

    let samePassword = false;

    if (
      typeof influencer.password === "string" &&
      influencer.password.startsWith("$2")
    ) {
      samePassword = await bcrypt.compare(
        String(newPassword),
        String(influencer.password)
      );
    } else {
      samePassword = String(newPassword) === String(influencer.password || "");
    }

    if (samePassword) {
      return res.status(400).json({
        message: "New password cannot be the same as your last password",
      });
    }

    influencer.password = await hashPassword(newPassword);
    await influencer.save();

    await VerifyOtpModel.deleteMany({
      email: norm(decoded.email),
      role: "influencer",
      docType: "otp",
      purpose: "reset_password",
    }).exec();

    await resetSigninLimit(decoded.email);

    return res.status(200).json({
      message: "Password updated successfully",
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "RESET_PASSWORD_INFLUENCER_ERROR");
    console.error("Error in resetPasswordInfluencer:", err);

    if (err?.name === "TokenExpiredError" || err?.name === "JsonWebTokenError") {
      return res.status(403).json({
        message: "Invalid or expired reset token",
      });
    }

    return res.status(err?.statusCode || 500).json({
      message: err?.message || "Internal server error",
    });
  }
};

/* ============================ Payments (CRUD) ============================ */
exports.addPaymentMethod = async (req, res) => {
  try {
    const {
      type,
      bank = {},
      paypal = {},
      isDefault = false,
      _id,
      id,
    } = req.body || {};

    const influencerMongoId = String(
      _id || id || getAuthenticatedInfluencerMongoId(req) || ""
    ).trim();

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(400).json({
        message: "Valid influencer _id is required",
      });
    }

    if (![0, 1].includes(Number(type))) {
      return res.status(400).json({
        message: "type must be 0 (PayPal) or 1 (Bank)",
      });
    }

    const inf = await Influencer.findById(influencerMongoId);

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    inf.paymentMethods = Array.isArray(inf.paymentMethods)
      ? inf.paymentMethods
      : [];

    const paymentObj = {
      paymentId: uuidv4(),
      type: Number(type),
      bank: undefined,
      paypal: undefined,
      isDefault: Boolean(isDefault),
    };

    if (Number(type) === 1) {
      const required = ["accountHolder", "accountNumber", "bankName", "countryId"];

      for (const f of required) {
        if (!bank[f] || !bank[f].toString().trim()) {
          return res.status(400).json({
            message: `Missing bank field: ${f}`,
          });
        }
      }

      const countryDoc = await Country.findById(bank.countryId);

      if (!countryDoc) {
        return res.status(400).json({
          message: "Invalid bank.countryId",
        });
      }

      paymentObj.bank = {
        accountHolder: bank.accountHolder.trim(),
        accountNumber: bank.accountNumber.trim(),
        ifsc: bank.ifsc?.trim(),
        swift: bank.swift?.trim(),
        bankName: bank.bankName.trim(),
        branch: bank.branch?.trim(),
        countryId: countryDoc._id,
        countryName: countryDoc.countryName,
      };
    } else {
      if (!paypal.email || !paypal.email.trim()) {
        return res.status(400).json({
          message: "paypal.email is required",
        });
      }

      paymentObj.paypal = {
        email: paypal.email.trim(),
        username: paypal.username?.trim(),
      };
    }

    if (paymentObj.isDefault) {
      inf.paymentMethods.forEach((pm) => {
        pm.isDefault = false;
      });
    } else if (inf.paymentMethods.length === 0) {
      paymentObj.isDefault = true;
    }

    inf.paymentMethods.push(paymentObj);
    await inf.save();

    return res.status(201).json({
      message: "Payment method added",
      paymentId: paymentObj.paymentId,
      paymentMethods: inf.paymentMethods,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "ADD_PAYMENT_METHOD_ERROR");
    console.error("Error in addPaymentMethod:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.deletePaymentMethod = async (req, res) => {
  try {
    const influencerMongoId = getAuthenticatedInfluencerMongoId(req);
    const { paymentId } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(401).json({
        message: "Invalid token payload",
      });
    }

    const inf = await Influencer.findById(influencerMongoId);

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    inf.paymentMethods = Array.isArray(inf.paymentMethods)
      ? inf.paymentMethods
      : [];

    const idx = inf.paymentMethods.findIndex(
      (pm) => pm.paymentId === paymentId
    );

    if (idx === -1) {
      return res.status(404).json({
        message: "Payment method not found",
      });
    }

    const wasDefault = inf.paymentMethods[idx].isDefault;
    inf.paymentMethods.splice(idx, 1);

    if (wasDefault && inf.paymentMethods.length > 0) {
      inf.paymentMethods[0].isDefault = true;
    }

    await inf.save();

    return res.status(200).json({
      message: "Payment method deleted",
      paymentMethods: inf.paymentMethods,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "DELETE_PAYMENT_METHOD_ERROR");
    console.error("Error in deletePaymentMethod:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const mask = (val = "", keep = 4) =>
  val.length <= keep ? val : "*".repeat(val.length - keep) + val.slice(-keep);

exports.viewPaymentByType = async (req, res) => {
  try {
    const requesterId = getAuthenticatedInfluencerMongoId(req);
    const { _id, id, type } = req.body || {};
    const influencerMongoId = String(_id || id || requesterId || "").trim();

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(400).json({
        message: "Valid influencer _id is required",
      });
    }

    if (type === undefined || ![0, 1].includes(Number(type))) {
      return res.status(400).json({
        message: "type must be 0 (PayPal) or 1 (Bank)",
      });
    }

    if (!requesterId || requesterId !== influencerMongoId) {
      return res.status(403).json({
        message: "Forbidden",
      });
    }

    const inf = await Influencer.findById(influencerMongoId, "paymentMethods");

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    const paymentMethods = Array.isArray(inf.paymentMethods)
      ? inf.paymentMethods
      : [];

    let methods = paymentMethods.filter((pm) => pm.type === Number(type));

    if (Number(type) === 1) {
      methods = methods.map((pm) => {
        const obj = pm.toObject ? pm.toObject() : { ...pm };

        if (obj.bank?.accountNumber) {
          obj.bank.accountNumber = mask(obj.bank.accountNumber);
        }

        return obj;
      });
    }

    return res.status(200).json({
      _id: String(inf._id),
      type: Number(type),
      paymentMethods: methods,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VIEW_PAYMENT_BY_TYPE_ERROR");
    console.error("Error in viewPaymentByType:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.updatePaymentMethod = async (req, res) => {
  try {
    const {
      paymentId,
      type,
      bank = {},
      paypal = {},
      isDefault,
      _id,
      id,
    } = req.body || {};

    const influencerMongoId = String(_id || id || "").trim();

    if (!paymentId) {
      return res.status(400).json({
        message: "paymentId is required",
      });
    }

    if (type === undefined || ![0, 1].includes(Number(type))) {
      return res.status(400).json({
        message: "type must be 0 (PayPal) or 1 (Bank)",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(400).json({
        message: "Valid influencer _id is required",
      });
    }

    const inf = await Influencer.findById(influencerMongoId);

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    inf.paymentMethods = Array.isArray(inf.paymentMethods)
      ? inf.paymentMethods
      : [];

    const pm =
      inf.paymentMethods.id(paymentId) ||
      inf.paymentMethods.find((p) => p.paymentId === paymentId);

    if (!pm) {
      return res.status(404).json({
        message: "Payment method not found",
      });
    }

    pm.type = Number(type);

    if (pm.type === 1) {
      const required = ["accountHolder", "accountNumber", "bankName", "countryId"];

      for (const f of required) {
        const val = bank[f] ?? pm.bank?.[f];

        if (!val || !String(val).trim()) {
          return res.status(400).json({
            message: `Missing bank field: ${f}`,
          });
        }
      }

      let countryDoc;

      if (bank.countryId && String(bank.countryId) !== String(pm.bank?.countryId)) {
        countryDoc = await Country.findById(bank.countryId);

        if (!countryDoc) {
          return res.status(400).json({
            message: "Invalid bank.countryId",
          });
        }
      } else {
        countryDoc = await Country.findById(pm.bank.countryId);
      }

      pm.bank = {
        accountHolder: (bank.accountHolder ?? pm.bank.accountHolder).trim(),
        accountNumber: (bank.accountNumber ?? pm.bank.accountNumber).trim(),
        ifsc: bank.ifsc?.trim() ?? pm.bank.ifsc,
        swift: bank.swift?.trim() ?? pm.bank.swift,
        bankName: (bank.bankName ?? pm.bank.bankName).trim(),
        branch: bank.branch?.trim() ?? pm.bank.branch,
        countryId: countryDoc._id,
        countryName: countryDoc.countryName,
      };

      pm.paypal = undefined;
    } else {
      const emailVal = paypal.email ?? pm.paypal?.email;

      if (!emailVal || !String(emailVal).trim()) {
        return res.status(400).json({
          message: "paypal.email is required",
        });
      }

      pm.paypal = {
        email: paypal.email?.trim() ?? pm.paypal.email,
        username: paypal.username?.trim() ?? pm.paypal.username,
      };

      pm.bank = undefined;
    }

    if (typeof isDefault === "boolean") {
      if (isDefault) {
        inf.paymentMethods.forEach((x) => {
          x.isDefault = false;
        });

        pm.isDefault = true;
      } else {
        pm.isDefault = false;

        if (!inf.paymentMethods.some((x) => x.isDefault)) {
          pm.isDefault = true;
        }
      }
    }

    await inf.save();

    return res.status(200).json({
      message: "Payment method updated",
      paymentMethod: pm,
      paymentMethods: inf.paymentMethods,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_PAYMENT_METHOD_ERROR");
    console.error("Error in updatePaymentMethod:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

/* ============================ Search Endpoints ============================ */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.searchInfluencers = async (req, res) => {
  try {
    const requester = req.brand;
    const { search, brandId } = req.body || {};

    if (!brandId) {
      return res.status(400).json({
        message: "brandId is required",
      });
    }

    if (!requester || requester.brandId !== brandId) {
      return res.status(403).json({
        message: "Forbidden",
      });
    }

    if (!search || !String(search).trim()) {
      return res.status(400).json({
        message: "search is required",
      });
    }

    await delay(300);

    const q = search.trim();
    const rx = new RegExp(escapeRegExp(q), "i");

    const docs = await Influencer.find({ name: rx }, "_id name")
      .limit(10)
      .lean();

    if (docs.length === 0) {
      return res.status(404).json({
        message: "No influencers found",
      });
    }

    const results = docs.map((d) => ({
      name: d.name,
      _id: String(d._id),
    }));

    return res.json({
      results,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SEARCH_INFLUENCERS_ERROR");
    console.error("Error in searchInfluencers:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.searchBrands = async (req, res) => {
  try {
    const requesterId = getAuthenticatedInfluencerMongoId(req);
    const { search } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(requesterId)) {
      return res.status(403).json({
        message: "Forbidden",
      });
    }

    if (!search || !String(search).trim()) {
      return res.status(400).json({
        message: "search is required",
      });
    }

    await delay(300);

    const regex = new RegExp(escapeRegExp(search.trim()), "i");

    const docs = await Brand.find({ name: regex }, "name brandId")
      .limit(10)
      .lean();

    if (docs.length === 0) {
      return res.status(404).json({
        message: "No brands found",
      });
    }

    const results = docs.map((d) => ({
      name: d.name,
      brandId: d.brandId,
    }));

    return res.json({
      results,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SEARCH_BRANDS_ERROR");
    console.error("Error in searchBrands:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.suggestInfluencers = async (req, res) => {
  try {
    const { q: rawQ = "", limit: rawLimit = 8 } = req.body || {};
    const q = String(rawQ).trim().toLowerCase();
    const limit = Math.max(1, Math.min(20, parseInt(rawLimit, 10) || 8));

    if (!q) {
      return res.json({
        success: true,
        suggestions: [],
      });
    }

    const candidates = await Influencer.find(
      {},
      "name categoryName platformName country socialMedia"
    )
      .limit(100)
      .lean();

    const set = new Set();

    for (const c of candidates) {
      if (c.name) set.add(c.name);
      if (Array.isArray(c.categoryName)) {
        c.categoryName.forEach((v) => v && set.add(v));
      }
      if (c.platformName) set.add(c.platformName);
      if (c.country) set.add(c.country);
      if (c.socialMedia) set.add(c.socialMedia);
    }

    const list = Array.from(set);
    const starts = list.filter((s) => String(s).toLowerCase().startsWith(q));
    const contains = list.filter(
      (s) =>
        !String(s).toLowerCase().startsWith(q) &&
        String(s).toLowerCase().includes(q)
    );

    const ordered = [...starts, ...contains].slice(0, limit);

    return res.json({
      success: true,
      suggestions: ordered,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SUGGEST_INFLUENCERS_ERROR");
    console.error("Suggestion error:", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/* ========================= Profile Update (no email) ========================= */
exports.updateProfile = async (req, res) => {
  try {
    const {
      _id,
      id,
      name,
      password,
      phone,
      socialMedia,
      gender,
      primaryPlatform,
      profileLink,
      malePercentage,
      femalePercentage,
      audienceAgeRangeId,
      audienceId,
      countryId,
      callingId,
      bio,
      onboarding,
    } = req.body || {};

    const influencerMongoId = String(
      _id || id || getAuthenticatedInfluencerMongoId(req) || ""
    ).trim();

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(400).json({
        message: "Valid influencer _id is required",
      });
    }

    const inf = await Influencer.findById(influencerMongoId);

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    if (typeof req.body.email !== "undefined") {
      return res.status(400).json({
        message: "Email cannot be updated here. Use requestEmailUpdate & verifyotp.",
      });
    }

    if (req.file) {
      inf.profileImage = `/uploads/profile_images/${req.file.filename}`;
    }

    if (typeof name !== "undefined") inf.name = name;

    if (typeof password !== "undefined" && password) {
      if (!isStrongPassword(password)) {
        return res.status(400).json({
          message:
            "Password must be at least 8 characters and include uppercase, lowercase, number, and special character",
        });
      }

      inf.password = await hashPassword(password);
    }

    if (typeof phone !== "undefined") inf.phone = phone;
    if (typeof socialMedia !== "undefined") inf.socialMedia = socialMedia;
    if (typeof profileLink !== "undefined") inf.profileLink = profileLink;
    if (typeof bio !== "undefined") inf.bio = bio;

    if (typeof gender !== "undefined") {
      const g = normalizeGender(gender);

      if (g === "__INVALID__") {
        return res.status(400).json({
          message:
            "Invalid gender. Allowed: Male, Female, Non-binary, Prefer not to say, or empty.",
        });
      }

      if (g !== null) inf.gender = g;
    }

    if (typeof primaryPlatform !== "undefined") {
      const p = normalizePrimaryPlatform(primaryPlatform);

      if (p === "__INVALID__") {
        return res.status(400).json({
          message:
            "Invalid primaryPlatform. Allowed: youtube | tiktok | instagram | other | null.",
        });
      }

      inf.primaryPlatform = p;
    }

    const hasMale = typeof malePercentage !== "undefined";
    const hasFemale = typeof femalePercentage !== "undefined";

    if (hasMale || hasFemale) {
      inf.audienceBifurcation = {
        malePercentage: hasMale
          ? Number(malePercentage)
          : inf.audienceBifurcation?.malePercentage,
        femalePercentage: hasFemale
          ? Number(femalePercentage)
          : inf.audienceBifurcation?.femalePercentage,
      };
    }

    if (typeof audienceAgeRangeId !== "undefined") {
      return res.status(400).json({
        message:
          "audienceAgeRangeId update is not available because Audience model is not imported in this controller.",
      });
    }

    if (typeof audienceId !== "undefined") {
      return res.status(400).json({
        message:
          "audienceId update is not available because AudienceRange model is not imported in this controller.",
      });
    }

    if (typeof countryId !== "undefined") {
      const countryDoc = await Country.findById(countryId);

      if (!countryDoc) {
        return res.status(400).json({
          message: "Invalid countryId",
        });
      }

      inf.countryId = countryDoc._id;
      inf.country = countryDoc.countryName;
      inf.countryName = countryDoc.countryName;
    }

    if (typeof callingId !== "undefined") {
      const callingDoc = await Country.findById(callingId);

      if (!callingDoc) {
        return res.status(400).json({
          message: "Invalid callingId",
        });
      }

      inf.callingId = callingDoc._id;
      inf.callingcode = callingDoc.callingCode;
    }

    if (typeof onboarding !== "undefined") {
      await upsertOnboardingFromPayload(inf, onboarding);
    }

    await inf.save();

    return res.status(200).json({
      message: "Profile updated successfully",
      _id: String(inf._id),
      onboarding: inf.onboarding,
      primaryPlatform: inf.primaryPlatform,
      gender: inf.gender,
      socialMedia: inf.socialMedia,
      profileLink: inf.profileLink,
      country: {
        id: inf.countryId,
        name: inf.country || inf.countryName,
      },
      calling: {
        id: inf.callingId,
        code: inf.callingcode,
      },
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_PROFILE_ERROR");
    const status = err.statusCode || 500;

    console.error("Error in updateProfile:", err);

    return res.status(status).json({
      message: err.message || "Internal server error",
    });
  }
};

/* ================= Email Update (single-OTP to NEW email) ================= */
exports.requestEmailUpdate = async (req, res) => {
  try {
    const { _id, id, newEmail, role = "Influencer" } = req.body || {};
    const influencerMongoId = String(
      _id || id || getAuthenticatedInfluencerMongoId(req) || ""
    ).trim();

    if (!influencerMongoId || !newEmail || !role) {
      return res.status(400).json({
        message: "_id, newEmail and role are required",
      });
    }

    if (String(role).trim() !== "Influencer") {
      return res.status(400).json({
        message: 'role must be "Influencer" for this endpoint',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(400).json({
        message: "Valid influencer _id is required",
      });
    }

    const inf = await Influencer.findById(influencerMongoId);

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    const oldEmail = norm(inf.email);
    const nextEmail = norm(newEmail);

    if (!nextEmail || !isValidEmail(nextEmail)) {
      return res.status(400).json({
        message: "Valid newEmail is required",
      });
    }

    if (nextEmail === oldEmail) {
      return res.status(400).json({
        message: "New email must be different from current email",
      });
    }

    const emailRegexCI = new RegExp(`^${escapeRegExp(nextEmail)}$`, "i");

    const [existingInfluencer, existingBrand] = await Promise.all([
      Influencer.findOne({ email: emailRegexCI }, "_id"),
      Brand.findOne({ email: emailRegexCI }, "_id"),
    ]);

    if (existingInfluencer && String(existingInfluencer._id) !== influencerMongoId) {
      return res.status(409).json({
        message: "New email already in use",
      });
    }

    if (existingBrand) {
      return res.status(409).json({
        message: "This email is already registered as a brand.",
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await VerifyEmail.findOneAndUpdate(
      { email: nextEmail, role: "Influencer" },
      {
        $setOnInsert: {
          email: nextEmail,
          role: "Influencer",
        },
        $set: {
          otpCode: otp,
          otpExpiresAt: expiresAt,
          verified: false,
        },
        $inc: {
          attempts: 1,
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      }
    );

    const subject = "Confirm email change";

    const html = otpHtmlTemplate({
      title: "Verify your new email",
      subtitle: "Use this code to confirm your new email address.",
      code: otp,
      minutes: 10,
      preheader: "Confirm email change (new email)",
    });

    const text = otpTextFallback({
      code: otp,
      minutes: 10,
      title: "Verify your new email",
    });

    await sendMail({
      to: nextEmail,
      subject,
      html,
      text,
    });

    return res.status(200).json({
      message: "OTP sent to new email",
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "REQUEST_EMAIL_UPDATE_ERROR");
    console.error("Error in requestEmailUpdate:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.verifyotp = async (req, res) => {
  try {
    const { _id, id, role = "Influencer", otp, newEmail } = req.body || {};
    const influencerMongoId = String(
      _id || id || getAuthenticatedInfluencerMongoId(req) || ""
    ).trim();

    if (!influencerMongoId || !role || !otp || !newEmail) {
      return res.status(400).json({
        message: "_id, role, otp, and newEmail are required",
      });
    }

    if (String(role).trim() !== "Influencer") {
      return res.status(400).json({
        message: 'role must be "Influencer" for this endpoint',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(400).json({
        message: "Valid influencer _id is required",
      });
    }

    const inf = await Influencer.findById(influencerMongoId);

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    const oldEmail = norm(inf.email);
    const nextEmail = norm(newEmail);

    if (!nextEmail || !isValidEmail(nextEmail)) {
      return res.status(400).json({
        message: "Valid newEmail is required",
      });
    }

    if (nextEmail === oldEmail) {
      return res.status(400).json({
        message: "New email must be different from current email",
      });
    }

    const emailRegexCI = new RegExp(`^${escapeRegExp(nextEmail)}$`, "i");

    const [existingInfluencer, existingBrand] = await Promise.all([
      Influencer.findOne({ email: emailRegexCI }, "_id"),
      Brand.findOne({ email: emailRegexCI }, "_id"),
    ]);

    if (existingInfluencer && String(existingInfluencer._id) !== influencerMongoId) {
      return res.status(409).json({
        message: "New email already in use",
      });
    }

    if (existingBrand) {
      return res.status(409).json({
        message: "This email is already registered as a brand.",
      });
    }

    const now = new Date();

    const ve = await VerifyEmail.findOne({
      email: nextEmail,
      role: "Influencer",
      otpCode: String(otp).trim(),
      otpExpiresAt: { $gt: now },
    });

    if (!ve) {
      return res.status(400).json({
        message: "Invalid or expired OTP for new email",
      });
    }

    inf.email = nextEmail;
    await inf.save();

    ve.verified = true;
    ve.otpCode = undefined;
    ve.otpExpiresAt = undefined;
    ve.verifiedAt = new Date();
    await ve.save();

    await VerifyEmail.deleteOne({
      email: oldEmail,
      role: "Influencer",
    }).catch(() => { });

    return res.status(200).json({
      message: "Email updated successfully",
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VERIFYOTP_ERROR");
    console.error("Error in verifyotp:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

/* ================= Claim / Link Additional Email ================= */
exports.requestClaimEmailOtp = async (req, res) => {
  try {
    const influencerMongoId = getAuthenticatedInfluencerMongoId(req);
    const { externalEmail } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(403).json({
        message: "Forbidden",
      });
    }

    if (!externalEmail) {
      return res.status(400).json({
        message: "externalEmail is required",
      });
    }

    const normalized = norm(externalEmail);

    if (!normalized || !isValidEmail(normalized)) {
      return res.status(400).json({
        message: "Invalid externalEmail",
      });
    }

    const inf = await Influencer.findById(influencerMongoId);

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    if (normalized === norm(inf.email)) {
      return res.status(400).json({
        message: "This email is already your login email",
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await VerifyEmail.findOneAndUpdate(
      { email: normalized, role: "InfluencerAlias" },
      {
        $setOnInsert: {
          email: normalized,
          role: "InfluencerAlias",
        },
        $set: {
          otpCode: code,
          otpExpiresAt: expiresAt,
          verified: false,
        },
        $inc: {
          attempts: 1,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    const subject = "Verify this email to link your conversations";

    const html = otpHtmlTemplate({
      title: "Verify your additional email",
      subtitle: "Use this code to link your past CollabGlam conversations.",
      code,
      minutes: 10,
      preheader: "Link your email to CollabGlam",
    });

    const text = otpTextFallback({
      code,
      minutes: 10,
      title: "Verify your additional email",
    });

    await sendMail({
      to: normalized,
      subject,
      html,
      text,
    });

    return res.status(200).json({
      message: "OTP sent to external email",
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "REQUEST_CLAIM_EMAIL_OTP_ERROR");
    console.error("requestClaimEmailOtp error:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.verifyClaimEmailOtp = async (req, res) => {
  try {
    const influencerMongoId = getAuthenticatedInfluencerMongoId(req);
    const { externalEmail, otp } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(403).json({
        message: "Forbidden",
      });
    }

    if (!externalEmail || !otp) {
      return res.status(400).json({
        message: "externalEmail and otp are required",
      });
    }

    const normalized = norm(externalEmail);
    const code = String(otp).trim();

    const inf = await Influencer.findById(influencerMongoId);

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    const ve = await VerifyEmail.findOne({
      email: normalized,
      role: "InfluencerAlias",
      otpCode: code,
      otpExpiresAt: { $gt: new Date() },
    });

    if (!ve) {
      return res.status(400).json({
        message: "Invalid or expired OTP",
      });
    }

    ve.verified = true;
    ve.verifiedAt = new Date();
    ve.otpCode = undefined;
    ve.otpExpiresAt = undefined;
    await ve.save();

    await attachExternalEmailToInfluencer(inf, normalized);
    await linkConversationsForInfluencer(inf, normalized);

    return res.status(200).json({
      message:
        "Email linked successfully. Your past conversations are now attached.",
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VERIFY_CLAIM_EMAIL_OTP_ERROR");
    console.error("verifyClaimEmailOtp error:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

/* ================= Influencer Tour ================= */
exports.getInfluencerOnboarding = async (req, res) => {
  try {
    const influencerMongoId = getAuthenticatedInfluencerMongoId(req);

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const inf = await Influencer.findById(influencerMongoId)
      .select("onboarding.influencerTourSeen onboarding.influencerTourSeenAt")
      .lean();

    if (!inf) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    const seen = Boolean(inf?.onboarding?.influencerTourSeen);

    return res.status(200).json({
      influencerTourSeen: seen,
      influencerTourSeenAt: inf?.onboarding?.influencerTourSeenAt ?? null,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_INFLUENCER_ONBOARDING_ERROR");
    console.error("getInfluencerOnboarding error:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.markInfluencerTourSeen = async (req, res) => {
  try {
    const influencerMongoId = getAuthenticatedInfluencerMongoId(req);

    if (!mongoose.Types.ObjectId.isValid(influencerMongoId)) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    const now = new Date();

    const result = await Influencer.updateOne(
      { _id: influencerMongoId },
      {
        $set: {
          "onboarding.influencerTourSeen": true,
          "onboarding.influencerTourSeenAt": now,
        },
      }
    );

    if (!result?.matchedCount) {
      return res.status(404).json({
        message: "Influencer not found",
      });
    }

    return res.status(200).json({
      success: true,
      influencerTourSeen: true,
      influencerTourSeenAt: now,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "MARK_INFLUENCER_TOUR_SEEN_ERROR");
    console.error("markInfluencerTourSeen error:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};