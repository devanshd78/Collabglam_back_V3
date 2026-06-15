const mongoose = require("mongoose");
const { Types } = require("mongoose");
const multer = require("multer");
const OpenAI = require("openai");
const { DateTime } = require("luxon");
const { normalizeAndUploadProductImages, uploadMultipleFilesToS3 } = require("../utils/uploadBase64ImagesToS3.js");

const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const { Category } = require("../models/categories");
const ApplyCampaign = require("../models/applyCampaign");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Contract = require("../models/contract");
const Country = require("../models/country");
const Modash = require("../models/modash");
const { AdminModel: Admin } = require("../models/master");

const { AgeRangeModel: AgeRange } = require("../models/ageRange");
const ContentLanguage = require("../models/language");
const { InfluencerTierModel: InfluencerTier } = require("../models/influencerTier");
const { ProductServiceGoalModel } = require("../models/productServiceGoal");
const { ContentFormatModel: ContentFormat } = require("../models/contentFormat");
const { PreferredHashtagModel: PreferredHashtag } = require("../models/preferredHashtag");

// adjust these two imports only if your actual paths differ
const Milestone = require("../models/milestone");
const getFeature = require("../utils/getFeature");

const { CONTRACT_STATUS } = require("../constants/contract");
const { createAndEmit } = require("../utils/notifier");
const { detectGeoFromRequest } = require("../utils/ipGeo");
const { ApiResponse } = require("../core/http/ApiResponse.js");
const { HttpStatus } = require("../core/http/HttpStatus.js");
const saveErrorLog = require("../services/errorLog.service");

// ===============================
// helpers
// ===============================

const getSafeObjectId = (value) => {
  const id = String(value || "").trim();

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return null;
  }

  return new mongoose.Types.ObjectId(id);
};

const getCampaignIdMatchFilterForDispute = (campaignId) => {
  const id = String(campaignId || "").trim();
  const objectId = getSafeObjectId(id);

  const or = [
    { campaignId: id },
  ];

  if (objectId) {
    or.push({ _id: objectId });
  }

  return { $or: or };
};

const mapCampaignForDisputeDropdown = (campaign) => {
  const categories = Array.isArray(campaign.categories)
    ? campaign.categories
    : [];

  const categoryId =
    campaign.categoryId
      ? String(campaign.categoryId)
      : categories[0]?.categoryId
        ? String(categories[0].categoryId)
        : "";

  const categoryName =
    campaign.campaignCategory ||
    categories[0]?.categoryName ||
    "";

  const subcategoryIds = Array.isArray(campaign.subcategoryIds)
    ? campaign.subcategoryIds.map((id) => String(id))
    : categories
      .map((item) => item?.subcategoryId)
      .filter(Boolean)
      .map((id) => String(id));

  const subcategories = categories.length
    ? categories.map((item) => ({
      categoryId: item.categoryId ? String(item.categoryId) : categoryId,
      categoryName: item.categoryName || categoryName,
      subcategoryId: item.subcategoryId ? String(item.subcategoryId) : "",
      subcategoryName: item.subcategoryName || "",
    }))
    : String(campaign.campaignSubcategory || "")
      .split(",")
      .map((name, index) => ({
        categoryId,
        categoryName,
        subcategoryId: subcategoryIds[index] || "",
        subcategoryName: name.trim(),
      }))
      .filter((item) => item.subcategoryName);

  return {
    _id: String(campaign._id),
    campaignId: String(campaign._id),

    campaignTitle: campaign.campaignTitle || campaign.productOrServiceName || "",
    productOrServiceName: campaign.productOrServiceName || "",

    status: campaign.status,
    brandId: campaign.brandId ? String(campaign.brandId) : "",
    brandName: campaign.brandName || "",

    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    publishedAt: campaign.publishedAt,
    scheduledAt: campaign.scheduledAt,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    createdBy: campaign.createdBy || null,

    // fixed category fields
    category: categoryName
      ? {
        id: categoryId,
        name: categoryName,
      }
      : null,

    categoryId,
    categoryName,
    campaignCategory: categoryName,

    subcategoryIds,
    subcategory: campaign.campaignSubcategory || "",
    campaignSubcategory: campaign.campaignSubcategory || "",
    subcategories,
    categories: subcategories,

    numberOfInfluencers: campaign.numberOfInfluencers,
    campaignBudget: campaign.campaignBudget,
    budget: campaign.budget,
    applicantCount: campaign.applicantCount,

    productImages: campaign.productImages || [],

    byAi: campaign.byAi,
    isActive: campaign.isActive,
    isDraft: campaign.isDraft,
  };
};

const buildDisputeCampaignSearchOr = (search) => {
  const term = String(search || "").trim();

  if (!term) return [];

  return [
    { campaignTitle: { $regex: term, $options: "i" } },
    { productOrServiceName: { $regex: term, $options: "i" } },
    { brandName: { $regex: term, $options: "i" } },
    { campaignType: { $regex: term, $options: "i" } },
    { campaignCategory: { $regex: term, $options: "i" } },
    { campaignSubcategory: { $regex: term, $options: "i" } },
  ];
};

const escapeRegex = (s = "") =>
  String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const EC = (code) => code;
const getRequestId = (req) => req.requestId || req.id || req.headers?.["x-request-id"] || "NA";

const isOid = (v) => mongoose.Types.ObjectId.isValid(clean(v));
const toObjectId = (id) => new mongoose.Types.ObjectId(clean(id));
const toUnknownArray = (v) => (Array.isArray(v) ? v : []);

const toNumber = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};

const toInt = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : NaN;
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
};

const clampInt = (v, def, min, max) => {
  const n = toInt(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
};

const isValidHttpUrl = (v) => {
  const s = clean(v);
  if (!s) return false;
  try {
    const u = new URL(s);
    return /^https?:$/i.test(u.protocol);
  } catch {
    return false;
  }
};

const normalizeObjectIdArray = (v) => {
  if (Array.isArray(v)) return v.map((x) => clean(String(x))).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const s = clean(v);
  return s && mongoose.Types.ObjectId.isValid(s) ? [s] : [];
};

const fail = (res, http, code, message, requestId, meta) => {
  return ApiResponse.sendFail(res, http, EC(code), message, requestId, meta);
};

const missingRequired = (field) => `Missing required field: ${field}`;

const failField = (res, http, code, field, requestId, message) => {
  const msg = message || missingRequired(field);
  return ApiResponse.sendFail(res, http, EC(code), msg, requestId, {
    fieldErrors: { [field]: msg },
  });
};

const requireObjectId = (res, requestId, field, v) => {
  const s = clean(v);
  if (!s) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId) };
  }
  if (!mongoose.Types.ObjectId.isValid(s)) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId, `Invalid ${field}`),
    };
  }
  return { ok: true, value: s };
};

const requireString = (res, requestId, field, v) => {
  const s = clean(v);
  if (!s) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId) };
  }
  return { ok: true, value: s };
};

const requireIdArray = (res, requestId, field, v) => {
  const ids = normalizeObjectIdArray(v);
  if (!ids.length) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", field, requestId) };
  }
  return { ok: true, value: ids };
};

const normalizePaymentType = (v) => {
  const s = clean(v).toLowerCase();
  if (s === "milestone") return "Milestone";
  if (s === "fixed") return "Fixed";
  if (s === "gifting") return "Gifting";
  return s ? s[0].toUpperCase() + s.slice(1) : "Milestone";
};

const hasDateInput = (v) => (v instanceof Date ? Number.isFinite(v.getTime()) : !!clean(v));

const MIN_FOLLOWERS_ALLOWED = 1000;

const fmtInt = (n) => {
  const x = typeof n === "number" ? n : Number(n);
  return Number.isFinite(x) ? new Intl.NumberFormat("en-US").format(Math.trunc(x)) : "";
};

const sendControllerError = (res, requestId, err) => {
  const e = err;

  if (e?.code === 11000) {
    return ApiResponse.sendFail(
      res,
      HttpStatus.CONFLICT,
      EC("VALIDATION_ERROR"),
      "Duplicate record",
      requestId,
      { keyValue: e?.keyValue }
    );
  }

  if (e?.name === "CastError") {
    const field = String(e?.path || "value");
    const msg = `Invalid ${field}`;
    return ApiResponse.sendFail(
      res,
      HttpStatus.BAD_REQUEST,
      EC("VALIDATION_ERROR"),
      msg,
      requestId,
      {
        fieldErrors: { [field]: msg },
        value: e?.value,
      }
    );
  }

  if (e?.name === "ValidationError") {
    const first = Object.values(e?.errors || {})[0];
    const field = String(first?.path || "unknown");
    const fieldKey = field.replace(/\s+/g, "").toLowerCase();

    const minFromSchema = first?.properties?.min;
    let msg = String(first?.message || "Validation failed");

    if (first?.kind === "min" && (fieldKey === "minfollowers" || fieldKey === "maxfollowers")) {
      const minVal = Number.isFinite(Number(minFromSchema)) ? Number(minFromSchema) : MIN_FOLLOWERS_ALLOWED;
      msg =
        fieldKey === "minfollowers"
          ? `Min followers must be at least ${fmtInt(minVal)}.`
          : `Max followers must be at least ${fmtInt(minVal)}.`;
    }

    return ApiResponse.sendFail(
      res,
      HttpStatus.BAD_REQUEST,
      EC("VALIDATION_ERROR"),
      msg,
      requestId,
      {
        fieldErrors: { [field]: msg },
      }
    );
  }

  const message = err instanceof Error ? err.message : "Internal error";
  return ApiResponse.sendFail(
    res,
    HttpStatus.INTERNAL_SERVER_ERROR,
    EC("INTERNAL_ERROR"),
    message,
    requestId
  );
};

const pickStatus = (v) => {
  const allowed = ["draft", "scheduled", "active", "paused", "completed", "archived"];
  const s = clean(v);
  return allowed.includes(s) ? s : "draft";
};

const resolveCategoryAndSubcategories = async (categoryId, subIds) => {
  const cat = await Category.findById(categoryId)
    .select("_id name subcategories")
    .lean();

  if (!cat) return { cat: null, subs: [], error: "Category not found" };

  const allSubs = Array.isArray(cat.subcategories) ? cat.subcategories : [];
  const subMap = new Map(allSubs.map((s) => [String(s._id), s]));

  const orderedSubs = subIds.map((id) => subMap.get(String(id))).filter(Boolean);
  if (subIds.length && orderedSubs.length !== subIds.length) {
    return { cat: null, subs: [], error: "One or more subcategories not found in this category" };
  }

  return { cat, subs: orderedSubs, error: "" };
};

const DEFAULT_CAMPAIGN_TZ = "UTC";
const FULLY_MANAGED_PLAN_ID = "e5cb75da-6d0d-481b-b202-69b9cf864940";

function isFullyManagedBrandSnapshot(brandDoc = {}) {
  const subscription = brandDoc.subscription || {};
  const planId = String(subscription.planId || "").trim();
  const planName = String(subscription.planName || "").toLowerCase().trim();
  const features = Array.isArray(subscription.features) ? subscription.features : [];

  if (planId === FULLY_MANAGED_PLAN_ID) return true;
  if (planName.includes("fully managed") || planName.includes("full managed")) return true;

  return features.some((feature) =>
    [
      "creator_sourcing_and_outreach",
      "shortlist_delivered",
      "negotiation_and_followups",
    ].includes(String(feature?.key || ""))
  );
}

function buildBrandSubscriptionSnapshot(brandDoc = {}) {
  const subscription = brandDoc.subscription || {};
  const wasFullyManaged = isFullyManagedBrandSnapshot(brandDoc);

  return {
    planId: String(subscription.planId || ""),
    planName: String(subscription.planName || ""),
    status: String(subscription.status || ""),
    startedAt: subscription.startedAt || null,
    expiresAt: subscription.expiresAt || null,
    wasFullyManaged,
  };
}

const normalizeTimezone = (tzRaw) => {
  const tz = clean(tzRaw) || DEFAULT_CAMPAIGN_TZ;
  const probe = DateTime.now().setZone(tz);
  return probe.isValid ? tz : DEFAULT_CAMPAIGN_TZ;
};

const getCampaignTimezone = (body, fallback) => {
  return normalizeTimezone(body?.campaignTimezone ?? body?.timezone ?? body?.tz ?? fallback ?? DEFAULT_CAMPAIGN_TZ);
};

const hasOffsetOrZ = (s) => /([zZ]|[+\-]\d{2}:\d{2})$/.test(s);

const toUtcFromLocalOrAbsolute = (dtRaw, tzRaw) => {
  const dt = clean(dtRaw);
  if (!dt) return null;

  if (hasOffsetOrZ(dt)) {
    const d = new Date(dt);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  const tz = normalizeTimezone(tzRaw);
  const lx = DateTime.fromISO(dt, { zone: tz });
  return lx.isValid ? lx.toUTC().toJSDate() : null;
};

const assertNotPastUtc = (dtUtc, tz, field) => {
  const nowUtc = DateTime.utc();
  if (dtUtc.getTime() < nowUtc.toMillis()) {
    const prettyNowUtc = `${nowUtc.toFormat("yyyy-LL-dd HH:mm:ss")} UTC`;
    return {
      ok: false,
      message: `${field} cannot be in the past. Choose current/future time (${prettyNowUtc}). Timezone used for scheduling: ${normalizeTimezone(tz)}`,
      meta: {
        timezone: normalizeTimezone(tz),
        currentUtcTime: nowUtc.toISO({ suppressMilliseconds: true }),
      },
    };
  }
  return { ok: true };
};

const oidToStr = (v) => (v ? String(v) : "");
const asIdArray = (v) =>
  Array.isArray(v) ? v.map((x) => oidToStr(x)).filter((x) => mongoose.Types.ObjectId.isValid(x)) : [];

const orderByIds = (ids, docs) => {
  const map = new Map(docs.map((d) => [String(d._id), d]));
  return ids.map((id) => map.get(id)).filter(Boolean);
};

const enrichCampaigns = async (itemsRaw) => {
  const items = itemsRaw.map((x) => (typeof x?.toObject === "function" ? x.toObject() : x));

  const categoryIds = new Set();
  const goalIds = new Set();
  const tierIds = new Set();
  const formatIds = new Set();
  const langIds = new Set();
  const countryIds = new Set();
  const ageIds = new Set();
  const prefHashtagIds = new Set();

  for (const c of items) {
    const cid = oidToStr(c.categoryId);
    if (mongoose.Types.ObjectId.isValid(cid)) categoryIds.add(cid);

    asIdArray(c.campaignGoals).forEach((id) => goalIds.add(id));
    asIdArray(c.influencerTierIds).forEach((id) => tierIds.add(id));
    asIdArray(c.contentFormats).forEach((id) => formatIds.add(id));
    asIdArray(c.contentLanguageIds).forEach((id) => langIds.add(id));
    asIdArray(c.targetCountryIds).forEach((id) => countryIds.add(id));
    asIdArray(c.targetAgeRanges).forEach((id) => ageIds.add(id));
    asIdArray(c.preferredHashtags).forEach((id) => prefHashtagIds.add(id));
  }

  const [cats, goals, tiers, formats, langs, countries, ages, prefHashtags] = await Promise.all([
    categoryIds.size
      ? Category.find({ _id: { $in: [...categoryIds].map((id) => toObjectId(id)) } })
        .select("_id name subcategories")
        .lean()
      : Promise.resolve([]),

    goalIds.size
      ? ProductServiceGoalModel.find({ _id: { $in: [...goalIds].map((id) => toObjectId(id)) } })
        .select("_id goal sortOrder isActive")
        .lean()
      : Promise.resolve([]),

    tierIds.size
      ? InfluencerTier.find({ _id: { $in: [...tierIds].map((id) => toObjectId(id)) } })
        .select("_id category value sortOrder")
        .lean()
      : Promise.resolve([]),

    formatIds.size
      ? ContentFormat.find({ _id: { $in: [...formatIds].map((id) => toObjectId(id)) } }).lean()
      : Promise.resolve([]),

    langIds.size
      ? ContentLanguage.find({ _id: { $in: [...langIds].map((id) => toObjectId(id)) } })
        .select("_id code name isActive")
        .lean()
      : Promise.resolve([]),

    countryIds.size
      ? Country.find({ _id: { $in: [...countryIds].map((id) => toObjectId(id)) } })
        .select("_id countryNameEn countryNameLocal countryName name countryCode currencyCode currencyNameEn region flag")
        .lean()
      : Promise.resolve([]),

    ageIds.size
      ? AgeRange.find({ _id: { $in: [...ageIds].map((id) => toObjectId(id)) } }).select("_id range").lean()
      : Promise.resolve([]),

    prefHashtagIds.size
      ? PreferredHashtag.find({ _id: { $in: [...prefHashtagIds].map((id) => toObjectId(id)) } }).lean()
      : Promise.resolve([]),
  ]);

  const catMap = new Map(cats.map((d) => [String(d._id), d]));
  const goalMap = new Map(goals.map((d) => [String(d._id), d]));
  const tierMap = new Map(tiers.map((d) => [String(d._id), d]));
  const formatMap = new Map(formats.map((d) => [String(d._id), d]));
  const langMap = new Map(langs.map((d) => [String(d._id), d]));
  const countryMap = new Map(countries.map((d) => [String(d._id), d]));
  const ageMap = new Map(ages.map((d) => [String(d._id), d]));
  const prefMap = new Map(prefHashtags.map((d) => [String(d._id), d]));

  return items.map((c) => {
    const categoryId = oidToStr(c.categoryId);
    const cat = mongoose.Types.ObjectId.isValid(categoryId) ? catMap.get(categoryId) : null;

    const subIds = asIdArray(c.subcategoryIds);
    const subDetails =
      cat && Array.isArray(cat.subcategories)
        ? orderByIds(
          subIds,
          cat.subcategories.map((s) => ({ ...s, _id: String(s._id) }))
        ).map((s) => ({ id: String(s._id), name: s.name, tags: s.tags ?? [] }))
        : [];

    const goalDetails = asIdArray(c.campaignGoals)
      .map((id) => goalMap.get(id))
      .filter(Boolean)
      .map((g) => ({ id: String(g._id), goal: g.goal, sortOrder: g.sortOrder, isActive: g.isActive }));

    const tierDetails = asIdArray(c.influencerTierIds)
      .map((id) => tierMap.get(id))
      .filter(Boolean)
      .map((t) => ({ id: String(t._id), category: t.category, value: t.value, sortOrder: t.sortOrder }));

    const formatDetails = asIdArray(c.contentFormats)
      .map((id) => formatMap.get(id))
      .filter(Boolean)
      .map((f) => ({ id: String(f._id), ...f, _id: undefined }));

    const langDetails = asIdArray(c.contentLanguageIds)
      .map((id) => langMap.get(id))
      .filter(Boolean)
      .map((l) => ({ id: String(l._id), code: l.code, name: l.name, isActive: l.isActive }));

    const countryDetails = asIdArray(c.targetCountryIds)
      .map((id) => countryMap.get(id))
      .filter(Boolean)
      .map((x) => ({ id: String(x._id), ...x, _id: undefined }));

    const ageDetails = asIdArray(c.targetAgeRanges)
      .map((id) => ageMap.get(id))
      .filter(Boolean)
      .map((a) => ({ id: String(a._id), range: a.range }));

    const prefDetails = asIdArray(c.preferredHashtags)
      .map((id) => prefMap.get(id))
      .filter(Boolean)
      .map((h) => ({ id: String(h._id), ...h, _id: undefined }));

    return {
      ...c,
      id: String(c._id || ""),
      details: {
        category: cat ? { id: String(cat._id), name: cat.name } : null,
        subcategories: subDetails,
        campaignGoals: goalDetails,
        influencerTiers: tierDetails,
        contentFormats: formatDetails,
        contentLanguages: langDetails,
        targetCountries: countryDetails,
        targetAgeRanges: ageDetails,
        preferredHashtags: prefDetails,
      },
    };
  });
};

const buildCampaignLookupFilter = (campaignId, brandObjectId) => {
  const raw = clean(campaignId);
  if (!isOid(raw)) return null;

  const filter = { _id: toObjectId(raw) };
  if (brandObjectId) filter.brandId = brandObjectId;
  return filter;
};

const buildContractCampaignFilter = (campaignId) => {
  const raw = clean(campaignId);
  const or = [{ campaignId: raw }];
  if (isOid(raw)) or.push({ campaignId: toObjectId(raw) });
  return { $or: or };
};

const toUtcDateFromAny = (v, tz) => {
  if (!v) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const s = clean(v);
  return s ? toUtcFromLocalOrAbsolute(s, tz) : null;
};

const parseCampaignWindow = (body, tz, requestId, res, required) => {
  const startAtUtc = toUtcDateFromAny(body.startAt, tz);
  const endAtUtc = toUtcDateFromAny(body.endAt, tz);

  if (!required && !body.startAt && !body.endAt) return { ok: true, value: {} };

  if (!startAtUtc) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId) };
  }
  if (!endAtUtc) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId) };
  }

  if (startAtUtc.getTime() >= endAtUtc.getTime()) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId, "startAt must be < endAt"),
    };
  }

  const c1 = assertNotPastUtc(startAtUtc, tz, "startAt");
  if (!c1.ok) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId, c1.message) };
  }

  const c2 = assertNotPastUtc(endAtUtc, tz, "endAt");
  if (!c2.ok) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId, c2.message) };
  }

  return { ok: true, value: { startAt: startAtUtc, endAt: endAtUtc } };
};

const parseCampaignWindowForUpdate = (body, tz, requestId, res, opts = {}) => {
  const startAtUtc = toUtcDateFromAny(body.startAt, tz);
  const endAtUtc = toUtcDateFromAny(body.endAt, tz);

  if (!startAtUtc) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId),
    };
  }

  if (!endAtUtc) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId),
    };
  }

  if (startAtUtc.getTime() >= endAtUtc.getTime()) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId, "startAt must be < endAt"),
    };
  }

  if (!opts.allowPastStart) {
    const c1 = assertNotPastUtc(startAtUtc, tz, "startAt");
    if (!c1.ok) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId, c1.message),
      };
    }
  }

  const c2 = assertNotPastUtc(endAtUtc, tz, "endAt");
  if (!c2.ok) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId, c2.message),
    };
  }

  return { ok: true, value: { startAt: startAtUtc, endAt: endAtUtc } };
};

const parseSchedule = (body, tz, requestId, res) => {
  const scheduledAtStr = clean(body.scheduledAt);
  if (!scheduledAtStr) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "scheduledAt", requestId),
    };
  }

  const scheduledAtUtc = toUtcFromLocalOrAbsolute(scheduledAtStr, tz);
  if (!scheduledAtUtc) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "scheduledAt",
        requestId,
        "Invalid scheduledAt format"
      ),
    };
  }

  const chk = assertNotPastUtc(scheduledAtUtc, tz, "scheduledAt");
  if (!chk.ok) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "scheduledAt",
        requestId,
        chk.message
      ),
    };
  }

  const win = parseCampaignWindow(body, tz, requestId, res, true);
  if (!win.ok) return win;

  const startRaw = clean(body.startAt);
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(startRaw);

  const startLimitUtc = isDateOnly
    ? DateTime.fromISO(startRaw, { zone: normalizeTimezone(tz) }).endOf("day").toUTC().toJSDate()
    : win.value.startAt;

  if (scheduledAtUtc.getTime() > startLimitUtc.getTime()) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "scheduledAt",
        requestId,
        "scheduledAt must be <= startAt"
      ),
    };
  }

  return {
    ok: true,
    value: {
      scheduledAt: scheduledAtUtc,
      startAt: win.value.startAt,
      endAt: win.value.endAt,
    },
  };
};

const parseDraftWindowSoft = (body, tz) => {
  const startAtUtc = toUtcDateFromAny(body.startAt, tz);
  const endAtUtc = toUtcDateFromAny(body.endAt, tz);
  if (!startAtUtc || !endAtUtc) return {};
  if (startAtUtc.getTime() >= endAtUtc.getTime()) return {};
  return { startAt: startAtUtc, endAt: endAtUtc };
};

const inferMode = (statusRaw, scheduledAt) => {
  if (clean(scheduledAt)) return "schedule";

  const statusStr = clean(statusRaw);
  if (!statusStr) return "publish";

  const status = pickStatus(statusRaw);
  if (status === "draft") return "draft";
  if (status === "scheduled") return "schedule";
  return "publish";
};

const findBrandDocByAnyId = async (brandId) => {
  const s = clean(brandId);
  if (!s) return null;

  let brand = null;

  if (mongoose.Types.ObjectId.isValid(s)) {
    brand = await Brand.findById(s).lean();
  }

  if (!brand) {
    brand = await Brand.findOne({ brandId: s }).lean();
  }

  return brand;
};

const getCampaignDisplayName = (campaign) =>
  String(campaign?.campaignTitle || "Campaign").trim();

const toCampaignObjectIds = (ids = []) =>
  ids.map((id) => clean(String(id))).filter(isOid).map(toObjectId);

const validateForMode = async (res, requestId, mode, body, opts = {}) => {
  const brandIdR = requireObjectId(res, requestId, "brandId", body.brandId);
  if (!brandIdR.ok) return { ok: false, resp: brandIdR.resp };

  const titleR = requireString(res, requestId, "campaignTitle", body.campaignTitle);
  if (!titleR.ok) return { ok: false, resp: titleR.resp };

  if (mode === "draft") {
    return {
      ok: true,
      brandId: brandIdR.value,
      rel: null,
      normalized: {
        paymentType: clean(body.paymentType) ? normalizePaymentType(body.paymentType) : undefined,
      },
    };
  }

  const descR = requireString(res, requestId, "description", body.description);
  if (!descR.ok) return { ok: false, resp: descR.resp };

  const catR = requireObjectId(res, requestId, "categoryId", body.categoryId);
  if (!catR.ok) return { ok: false, resp: catR.resp };

  const subIds = normalizeObjectIdArray(body.subcategoryIds);
  if (!subIds.length) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "subcategoryIds", requestId) };
  }

  const rel = await resolveCategoryAndSubcategories(catR.value, subIds);
  if (rel.error) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "subcategoryIds", requestId, rel.error),
    };
  }

  const existingProductImages = toUnknownArray(opts.existingProductImages);
  const incomingProductImages = toUnknownArray(body.productImages);

  if (!incomingProductImages.length && !existingProductImages.length) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "productImages", requestId),
    };
  }

  const link = clean(body.productLink);
  if (link && !isValidHttpUrl(link)) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "productLink",
        requestId,
        "productLink must be a valid http/https URL"
      ),
    };
  }

  const minFollowersRaw = clean(body.minFollowers);
  const maxFollowersRaw = clean(body.maxFollowers);

  let minFollowers = null;

  if (minFollowersRaw) {
    const n = toInt(body.minFollowers);
    if (!Number.isFinite(n)) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "minFollowers", requestId, "Min followers must be a number."),
      };
    }
    if (n < MIN_FOLLOWERS_ALLOWED) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "minFollowers", requestId, `Min followers must be at least ${fmtInt(MIN_FOLLOWERS_ALLOWED)}.`),
      };
    }
    minFollowers = n;
  }

  if (maxFollowersRaw) {
    const n = toInt(body.maxFollowers);
    if (!Number.isFinite(n)) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "maxFollowers", requestId, "Max followers must be a number."),
      };
    }
    if (n < MIN_FOLLOWERS_ALLOWED) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "maxFollowers", requestId, `Max followers must be at least ${fmtInt(MIN_FOLLOWERS_ALLOWED)}.`),
      };
    }
    if (typeof minFollowers === "number" && n < minFollowers) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "maxFollowers", requestId, "Max followers must be greater than or equal to min followers."),
      };
    }
  }

  const videoLink = clean(body.videoLink);
  if (videoLink && !isValidHttpUrl(videoLink)) {
    return {
      ok: false,
      resp: failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "videoLink",
        requestId,
        "videoLink must be a valid http/https URL"
      ),
    };
  }

  const goalsR = requireIdArray(res, requestId, "campaignGoals", body.campaignGoals);
  if (!goalsR.ok) return { ok: false, resp: goalsR.resp };

  const tiersR = requireIdArray(res, requestId, "influencerTierIds", body.influencerTierIds);
  if (!tiersR.ok) return { ok: false, resp: tiersR.resp };

  const formatsR = requireIdArray(res, requestId, "contentFormats", body.contentFormats);
  if (!formatsR.ok) return { ok: false, resp: formatsR.resp };

  const payR = requireString(res, requestId, "paymentType", body.paymentType);
  if (!payR.ok) return { ok: false, resp: payR.resp };

  const budget = toNumber(body.campaignBudget);
  if (!Number.isFinite(budget) || budget < 0) {
    return {
      ok: false,
      resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "campaignBudget", requestId, "campaignBudget must be >= 0"),
    };
  }

  const countriesR = requireIdArray(res, requestId, "targetCountryIds", body.targetCountryIds);
  if (!countriesR.ok) return { ok: false, resp: countriesR.resp };

  const agesR = requireIdArray(res, requestId, "targetAgeRanges", body.targetAgeRanges);
  if (!agesR.ok) return { ok: false, resp: agesR.resp };

  if (!hasDateInput(body.startAt)) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "startAt", requestId) };
  }
  if (!hasDateInput(body.endAt)) {
    return { ok: false, resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "endAt", requestId) };
  }
  if (mode === "schedule") {
    if (!hasDateInput(body.scheduledAt)) {
      return {
        ok: false,
        resp: failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "scheduledAt", requestId),
      };
    }
  }

  return {
    ok: true,
    brandId: brandIdR.value,
    rel,
    normalized: {
      paymentType: normalizePaymentType(body.paymentType),
    },
  };
};

const buildCampaignDoc = (body, geo, status, byAi, timing, extra = {}) => {
  const isDraft = status === "draft";

  const oid = (v) => {
    const s = clean(v);
    return s && isOid(s) ? toObjectId(s) : undefined;
  };

  const oidArray = (v) =>
    normalizeObjectIdArray(v)
      .filter((x) => isOid(x))
      .map((x) => toObjectId(x));

  const oidArrayOrUndef = (v) => {
    const arr = oidArray(v);
    return arr.length ? arr : undefined;
  };

  const arrOrUndef = (v) => {
    const arr = toUnknownArray(v);
    return arr.length ? arr : undefined;
  };

  const strOrUndef = (v) => {
    const s = clean(v);
    return s ? s : undefined;
  };

  const budget = toNumber(body.campaignBudget);
  const numInfluencers = toInt(body.numberOfInfluencers);
  const minFollowers = toInt(body.minFollowers);
  const maxFollowers = toInt(body.maxFollowers);

  const createdLocation = {
    ip: geo?.ip,
    timezone: geo?.timezone,
    country: geo?.country,
    state: geo?.state,
    city: geo?.city,
    latitude: typeof geo?.latitude === "number" ? geo.latitude : undefined,
    longitude: typeof geo?.longitude === "number" ? geo.longitude : undefined,
    source: geo?.source,
  };

  const brandSubscriptionSnapshot = extra.brandSubscriptionSnapshot || null;
  const createdByAdmin =
    String(extra.createdBy?.role || "").toLowerCase() === "admin" ||
    String(extra.createdBy?.userModel || "").toLowerCase() === "master" ||
    String(extra.approvalMode || "").toLowerCase() === "admin_review";

  const wasFullyManaged =
    createdByAdmin || Boolean(brandSubscriptionSnapshot?.wasFullyManaged);

  const base = {
    brandId: toObjectId(body.brandId),
    brandName: clean(extra.brandName) || "",

    brandSubscriptionSnapshot,
    brandWasFullyManagedAtCreation: wasFullyManaged,
    isFullyManaged: wasFullyManaged,
    managementType: wasFullyManaged ? "fully_managed" : "self_serve",

    byAi,

    createdLocation,
    createdBy: extra.createdBy
      ? {
        role: extra.createdBy.role,
        userId: extra.createdBy.userId,
        userModel:
          extra.createdBy.userModel ||
          (extra.createdBy.role === "admin" ? "Master" : "Brand"),
        email: extra.createdBy.email || "",
        name: extra.createdBy.name || "",
        adminRole: extra.createdBy.adminRole || "",
      }
      : null,
    approvalMode: extra.approvalMode || "direct",

    status,
    campaignTimezone: clean(body.campaignTimezone) || DEFAULT_CAMPAIGN_TZ,

    campaignTitle: clean(body.campaignTitle),
    description: isDraft ? strOrUndef(body.description) : clean(body.description),
    campaignType: isDraft ? strOrUndef(body.campaignType) : clean(body.campaignType) || "",

    campaignCategory: extra.categoryName || "",
    campaignSubcategory: Array.isArray(extra.subcategoryNames) ? extra.subcategoryNames.join(", ") : "",

    categoryId: oid(body.categoryId),
    subcategoryIds: isDraft ? oidArrayOrUndef(body.subcategoryIds) : oidArray(body.subcategoryIds),

    productImages: isDraft ? arrOrUndef(body.productImages) : toUnknownArray(body.productImages),
    productLink: strOrUndef(body.productLink),
    videoLink: strOrUndef(body.videoLink),

    campaignGoals: isDraft ? oidArrayOrUndef(body.campaignGoals) : oidArray(body.campaignGoals),
    influencerTierIds: isDraft ? oidArrayOrUndef(body.influencerTierIds) : oidArray(body.influencerTierIds),
    contentFormats: isDraft ? oidArrayOrUndef(body.contentFormats) : oidArray(body.contentFormats),
    contentLanguageIds: oidArrayOrUndef(body.contentLanguageIds),
    preferredHashtags: oidArrayOrUndef(body.preferredHashtags),
    targetCountryIds: isDraft ? oidArrayOrUndef(body.targetCountryIds) : oidArray(body.targetCountryIds),
    targetAgeRanges: isDraft ? oidArrayOrUndef(body.targetAgeRanges) : oidArray(body.targetAgeRanges),

    numberOfInfluencers: Number.isFinite(numInfluencers) ? numInfluencers : 0,
    minFollowers: Number.isFinite(minFollowers) ? minFollowers : 0,
    maxFollowers: Number.isFinite(maxFollowers) ? maxFollowers : 0,

    campaignBudget: Number.isFinite(budget) ? budget : 0,
    budget: Number.isFinite(budget) ? budget : 0,
    influencerBudget: Number.isFinite(toNumber(body.influencerBudget)) ? toNumber(body.influencerBudget) : 0,

    paymentType: clean(body.paymentType) ? normalizePaymentType(body.paymentType) : "Milestone",

    additionalNotes: isDraft ? strOrUndef(body.additionalNotes) : clean(body.additionalNotes) || "",

    isDraft: status === "draft" ? 1 : 0,
    isActive: status === "active" ? 1 : 0,
    publishStatus: status === "draft" ? "draft" : "published",
    statusUpdatedAt: new Date(),

    categories: Array.isArray(extra.subcategoryNames)
      ? extra.subcategoryNames.map((subName, idx) => ({
        categoryId: String(body.categoryId || ""),
        categoryName: extra.categoryName || "",
        subcategoryId: String(normalizeObjectIdArray(body.subcategoryIds)[idx] || ""),
        subcategoryName: subName,
      }))
      : [],
  };

  if (timing?.scheduledAt) base.scheduledAt = timing.scheduledAt;
  if (timing?.startAt) base.startAt = timing.startAt;
  if (timing?.endAt) base.endAt = timing.endAt;

  if (timing?.startAt || timing?.endAt) {
    base.timeline = {
      startDate: timing?.startAt || null,
      endDate: timing?.endAt || null,
    };
  }

  if (status === "active") {
    base.publishedAt = new Date();
    base.scheduledAt = undefined;
    base.scheduledLocation = undefined;
  }

  if (status === "draft") {
    base.publishedAt = undefined;
    base.scheduledAt = undefined;
    base.scheduledLocation = undefined;
  }

  if (status === "scheduled") {
    base.publishedAt = undefined;
    base.scheduledLocation = createdLocation;
  }

  return base;
};

const buildCampaignUpdatePatch = (body, existing, status, timing, extra = {}) => {
  const budget = toNumber(body.campaignBudget);
  const numInfluencers = toInt(body.numberOfInfluencers);
  const minFollowers = toInt(body.minFollowers);
  const maxFollowers = toInt(body.maxFollowers);

  const toOidOrFallback = (value, fallback) => {
    const s = clean(value);
    return s && isOid(s) ? toObjectId(s) : fallback;
  };

  const toOidArrayOrFallback = (value, fallback = []) => {
    const arr = normalizeObjectIdArray(value).map((x) => toObjectId(x));
    return arr.length ? arr : fallback;
  };

  const patch = {
    campaignTitle: clean(body.campaignTitle) || existing.campaignTitle,
    description: clean(body.description) || existing.description,
    campaignType: clean(body.campaignType) || existing.campaignType || "",

    categoryId: toOidOrFallback(body.categoryId, existing.categoryId),
    subcategoryIds: toOidArrayOrFallback(body.subcategoryIds, existing.subcategoryIds || []),

    productImages: toUnknownArray(body.productImages).length
      ? toUnknownArray(body.productImages)
      : toUnknownArray(existing.productImages),

    productLink: clean(body.productLink) || existing.productLink || "",
    videoLink: clean(body.videoLink) || existing.videoLink || "",

    campaignGoals: toOidArrayOrFallback(body.campaignGoals, existing.campaignGoals || []),
    influencerTierIds: toOidArrayOrFallback(body.influencerTierIds, existing.influencerTierIds || []),
    contentFormats: toOidArrayOrFallback(body.contentFormats, existing.contentFormats || []),
    contentLanguageIds: toOidArrayOrFallback(body.contentLanguageIds, existing.contentLanguageIds || []),
    preferredHashtags: toOidArrayOrFallback(body.preferredHashtags, existing.preferredHashtags || []),

    targetCountryIds: toOidArrayOrFallback(body.targetCountryIds, existing.targetCountryIds || []),
    targetAgeRanges: toOidArrayOrFallback(body.targetAgeRanges, existing.targetAgeRanges || []),

    paymentType: clean(body.paymentType)
      ? normalizePaymentType(body.paymentType)
      : existing.paymentType,

    campaignBudget: Number.isFinite(budget) ? budget : existing.campaignBudget,
    budget: Number.isFinite(budget) ? budget : existing.budget,

    numberOfInfluencers: Number.isFinite(numInfluencers)
      ? numInfluencers
      : existing.numberOfInfluencers,

    minFollowers:
      Number.isFinite(minFollowers) && minFollowers >= 0
        ? minFollowers
        : existing.minFollowers,

    maxFollowers:
      Number.isFinite(maxFollowers) && maxFollowers >= 0
        ? maxFollowers
        : existing.maxFollowers,

    additionalNotes: clean(body.additionalNotes) || existing.additionalNotes || "",

    status,
    campaignTimezone: clean(body.campaignTimezone) || existing.campaignTimezone || DEFAULT_CAMPAIGN_TZ,

    isDraft: status === "draft" ? 1 : 0,
    isActive: status === "active" ? 1 : 0,
    publishStatus: status === "draft" ? "draft" : "published",
    statusUpdatedAt: new Date(),
  };

  if (extra.categoryName) {
    patch.campaignCategory = extra.categoryName;
  }

  if (Array.isArray(extra.subcategoryNames)) {
    patch.campaignSubcategory = extra.subcategoryNames.join(", ");
    patch.categories = extra.subcategoryNames.map((subName, idx) => ({
      categoryId: String(body.categoryId || existing.categoryId || ""),
      categoryName: extra.categoryName || "",
      subcategoryId: String(normalizeObjectIdArray(body.subcategoryIds)[idx] || ""),
      subcategoryName: subName,
    }));
  }

  if (timing?.startAt) patch.startAt = timing.startAt;
  if (timing?.endAt) patch.endAt = timing.endAt;

  patch.timeline = {
    startDate: timing?.startAt || existing.startAt || existing.timeline?.startDate || null,
    endDate: timing?.endAt || existing.endAt || existing.timeline?.endDate || null,
  };

  if (status === "active") {
    patch.publishedAt = existing.publishedAt || new Date();
  }

  return patch;
};

async function notifyBrandDraftReady(campaign) {
  const title = getCampaignDisplayName(campaign);
  const entityId = String(campaign._id);

  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.draft_review",
    title: "Review your new campaign draft",
    message: `Admin has drafted "${title}". Please review and confirm.`,
    entityType: "campaign",
    entityId,
    actionPath: { brand: `/brand/review-campaigns/view?id=${entityId}` },
  });
}

async function notifyBrandApproved(campaign) {
  const title = getCampaignDisplayName(campaign);
  const entityId = String(campaign._id);

  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.update_approved",
    title: "Campaign update approved",
    message: `Admin approved changes for "${title}".`,
    entityType: "campaign",
    entityId,
    actionPath: { brand: `/brand/edit-review-campaign/view?id=${entityId}` },
  });
}

async function notifyBrandRejected(campaign, note) {
  const title = getCampaignDisplayName(campaign);
  const entityId = String(campaign._id);

  return createAndEmit({
    brandId: String(campaign.brandId),
    type: "campaign.update_rejected",
    title: "Campaign update rejected",
    message: `Admin rejected changes for "${title}". ${note ? `Reason: ${note}` : ""}`,
    entityType: "campaign",
    entityId,
    actionPath: { brand: `/brand/edit-review-campaign/view?id=${entityId}` },
  });
}

async function notifyMatchingInfluencersForNewCampaign(campaignDoc, subIds = []) {
  try {
    if (!Array.isArray(subIds) || !subIds.length) return;

    const influencers = await findMatchingInfluencers({ subIds, catNumIds: [] });
    if (!Array.isArray(influencers) || !influencers.length) return;

    const entityId = String(campaignDoc._id);
    const title = getCampaignDisplayName(campaignDoc);

    await Promise.all(
      influencers.map((inf) =>
        createAndEmit({
          influencerId: String(inf.influencerId),
          type: "campaign.match",
          title: "New campaign matches your profile",
          message: `${campaignDoc.brandName || "A brand"} posted "${title}".`,
          entityType: "campaign",
          entityId,
          actionPath: `/influencer/dashboard/view-campaign?id=${entityId}`,
        }).catch(() => null)
      )
    );
  } catch (e) {
    console.warn("notifyMatchingInfluencersForNewCampaign failed:", e?.message || e);
  }
}

// ===============================
// multer
// ===============================

const storage = multer.memoryStorage();
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"]);
const DOC_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

function fileFilter(req, file, cb) {
  if (file.fieldname === "image") return cb(null, IMAGE_MIMES.has(file.mimetype));
  if (file.fieldname === "creativeBrief") return cb(null, DOC_MIMES.has(file.mimetype));
  return cb(null, false);
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
}).fields([
  { name: "image", maxCount: 10 },
  { name: "creativeBrief", maxCount: 10 },
]);

// ===============================
// unchanged utility functions
// ===============================

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
}

function sortLocations(arr = []) {
  return [...arr].sort((a, b) => String(a.countryId).localeCompare(String(b.countryId)));
}

function sortCategories(arr = []) {
  return [...arr].sort((a, b) => {
    const ak = `${a.categoryId}-${a.subcategoryId}`;
    const bk = `${b.categoryId}-${b.subcategoryId}`;
    return ak.localeCompare(bk);
  });
}

function normalizeForDiff(obj) {
  const out = { ...obj };
  if (out.targetAudience?.locations) {
    out.targetAudience = {
      ...out.targetAudience,
      locations: sortLocations(out.targetAudience.locations),
    };
  }
  if (out.categories) {
    out.categories = sortCategories(out.categories);
  }
  if (out.budget !== undefined) out.budget = Number(out.budget);
  if (out.influencerBudget !== undefined) out.influencerBudget = Number(out.influencerBudget);
  return out;
}

function diffObject(base, next) {
  if (Array.isArray(base) || Array.isArray(next)) {
    return JSON.stringify(base) === JSON.stringify(next) ? undefined : next;
  }
  if (!isPlainObject(base) || !isPlainObject(next)) {
    return base === next ? undefined : next;
  }
  const patch = {};
  for (const key of Object.keys(next)) {
    const d = diffObject(base?.[key], next[key]);
    if (d !== undefined) patch[key] = d;
  }
  return Object.keys(patch).length ? patch : undefined;
}

function isAdminRequest(req) {
  const role = String(req.user?.role || req.user?.userType || "").toLowerCase();
  const isMasterRole = ["super_admin", "revenue_head", "ime", "bme"].includes(role);


  if (
    isMasterRole ||
    role.includes("admin") ||
    req.user?.isAdmin === true ||
    req.user?.adminId ||
    req.body?.adminId ||
    req.body?.adminMongoId ||
    req.body?.adminEmail ||
    req.query?.adminId
  ) {
    return true;
  }

  if (role.includes("brand") || req.user?.brandId) {
    return false;
  }

  return false;
}

async function findAdminDoc(rawValue) {
  const v = String(rawValue || "").trim();
  if (!v) return null;

  if (mongoose.Types.ObjectId.isValid(v)) {
    const byId = await Admin.findById(v)
      .select("_id email name role status")
      .lean();
    if (byId) return byId;
  }

  const byEmail = await Admin.findOne({ email: v.toLowerCase() })
    .select("_id email name role status")
    .lean();

  if (byEmail) return byEmail;

  return null;
}
async function resolveActorFromPayload(req, fallbackBrandId = "") {
  const role = String(req.user?.role || req.user?.userType || "").toLowerCase();

  const findAdminDoc = async (rawValue) => {
    const v = String(rawValue || "").trim();
    if (!v) return null;

    // try by Mongo _id
    if (mongoose.Types.ObjectId.isValid(v)) {
      const byId = await Admin.findById(v)
        .select("_id email name role status")
        .lean();
      if (byId) return byId;
    }

    // fallback by email
    const byEmail = await Admin.findOne({ email: v.toLowerCase() })
      .select("_id email name role status")
      .lean();
    if (byEmail) return byEmail;

    return null;
  };

  const isMasterRole = ["super_admin", "revenue_head", "ime", "bme"].includes(role);

  const looksLikeAdmin =
    !req.user?.brandId &&
    (
      isMasterRole ||
      role.includes("admin") ||
      req.user?.isAdmin === true ||
      req.user?.adminId ||
      req.body?.adminId ||
      req.body?.adminMongoId ||
      req.body?.adminEmail ||
      req.user?.email
    );

  if (looksLikeAdmin) {
    const adminDoc =
      (await findAdminDoc(req.user?.adminId)) ||
      (await findAdminDoc(req.user?._id)) ||
      (await findAdminDoc(req.user?.id)) ||
      (await findAdminDoc(req.user?.email)) ||
      (await findAdminDoc(req.body?.adminMongoId)) ||
      (await findAdminDoc(req.body?.adminId)) ||
      (await findAdminDoc(req.body?.adminEmail));

    if (!adminDoc) {
      throw new Error("Admin actor detected but Admin record could not be resolved");
    }

    return {
      role: "admin",
      userId: adminDoc._id,
      userModel: "Master",
      email: adminDoc.email,
      name: adminDoc.name || "",
      adminRole: adminDoc.role,
    };
  }

  const brandDoc = await findBrandDocByAnyId(
    fallbackBrandId || req.user?.brandId || req.body?.brandId || ""
  );

  if (!brandDoc) {
    return { role: "brand", userId: null, userModel: "Brand" };
  }

  return {
    role: "brand",
    userId: brandDoc._id,
    userModel: "Brand",
  };
}

function mapCampaignForInfluencer(c) {
  if (!c) return c;
  const brandBudget = toNum(c.budget, 0);
  const infBudget = toNum(c.influencerBudget, 0);
  return {
    ...c,
    budget: infBudget > 0 ? infBudget : brandBudget,
    brandBudget,
    influencerBudget: infBudget,
  };
}

async function ensureBrandQuota(brandId, featureKey, amount = 1) {
  if (!brandId) throw new Error("brandId is required for quota checks");
  const brand = await Brand.findOne({ brandId }, "subscription").lean();
  if (!brand || !brand.subscription) throw new Error("Brand subscription not configured");
  const feature = getFeature.getFeature(brand.subscription, featureKey);
  if (!feature) return { limit: 0, used: 0, remaining: Infinity };
  const limit = readLimit(feature);
  const used = Number(feature.used || 0) || 0;
  if (limit === 0) return { limit: 0, used, remaining: Infinity };
  if (used + amount > limit) {
    const remaining = Math.max(limit - used, 0);
    const err = new Error(`Quota exceeded for feature ${featureKey}`);
    err.code = "QUOTA_EXCEEDED";
    err.meta = { limit, used, requested: amount, remaining };
    throw err;
  }
  await Brand.updateOne({ brandId, "subscription.features.key": featureKey }, { $inc: { "subscription.features.$.used": amount } });
  return { limit, used: used + amount, remaining: limit - (used + amount) };
}

function readLimit(featureRow) {
  if (!featureRow) return 0;
  const raw = featureRow.limit ?? featureRow.value ?? 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

async function ensureMonthlyWindow(influencerId, featureKey, featureRow) {
  return featureRow;
}

async function countActiveCollaborationsForInfluencer(influencerId) {
  if (!influencerId) return 0;
  return Contract.countDocuments({ influencerId: String(influencerId), isRejected: { $ne: 1 }, isAccepted: 1 });
}

function activeAcceptedFilter() {
  return {
    isAccepted: 1,
    isRejected: { $ne: 1 },
    status: { $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
  };
}

function activeAcceptedFilter2() {
  return {
    isAccepted: 1,
    isRejected: { $ne: 1 },
    status: { $in: [CONTRACT_STATUS.CONTRACT_SIGNED, CONTRACT_STATUS.MILESTONES_CREATED], $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED] },
    $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
  };
}

function computeIsActive(timeline) {
  if (!timeline || !timeline.endDate) return 1;
  const now = new Date();
  return timeline.endDate < now ? 0 : 1;
}

const toStr = (v) => (v == null ? "" : String(v));

async function milestoneSetForInfluencer(influencerId, campaignIds = []) {
  if (!campaignIds.length) return new Set();
  const docs = await Milestone.find(
    { "milestoneHistory.influencerId": influencerId, "milestoneHistory.campaignId": { $in: campaignIds } },
    "milestoneHistory.campaignId milestoneHistory.influencerId"
  ).lean();
  const set = new Set();
  docs.forEach((d) => {
    d.milestoneHistory.forEach((e) => {
      if (toStr(e.influencerId) === toStr(influencerId) && campaignIds.includes(toStr(e.campaignId))) {
        set.add(toStr(e.campaignId));
      }
    });
  });
  return set;
}

function buildSearchOr(term) {
  const or = [
    { brandName: { $regex: term, $options: "i" } },
    { campaignTitle: { $regex: term, $options: "i" } },
    { description: { $regex: term, $options: "i" } },
    { campaignCategory: { $regex: term, $options: "i" } },
    { campaignSubcategory: { $regex: term, $options: "i" } },
    { "categories.subcategoryName": { $regex: term, $options: "i" } },
    { "categories.categoryName": { $regex: term, $options: "i" } },
  ];
  const num = Number(term);
  if (!isNaN(num)) {
    or.push({ budget: { $lte: num } });
    or.push({ influencerBudget: { $lte: num } });
  }
  return or;
}

async function buildSubToParentNumMap() {
  const rows = await Category.find({}, "_id subcategories").lean();
  const subIdToParentNum = new Map();

  for (const r of rows) {
    for (const s of r.subcategories || []) {
      subIdToParentNum.set(String(s._id), String(r._id));
    }
  }

  return subIdToParentNum;
}

async function findMatchingInfluencers({ subIds = [], catNumIds = [] }) {
  if (!subIds.length && !catNumIds.length) return [];
  const or = [];
  if (subIds.length) {
    or.push(
      { "onboarding.subcategories.subcategoryId": { $in: subIds } },
      { "subcategories.subcategoryId": { $in: subIds } },
      { "categories.subcategoryId": { $in: subIds } },
      { "socialProfiles.categories.subcategoryId": { $in: subIds } },
      { categories: { $in: subIds } }
    );
  }
  if (catNumIds.length) {
    or.push({ "onboarding.categoryId": { $in: catNumIds } }, { "categories.categoryId": { $in: catNumIds } });
  }
  const filter = or.length ? { $or: or } : {};
  const influencers = await Influencer.find(filter, "influencerId name primaryPlatform handle onboarding socialProfiles").lean();
  return influencers || [];
}

function addInfluencerOpenStatusGate(filter) {
  filter.$and = filter.$and || [];
  filter.$and.push({ status: "active" });
  return filter;
}

async function resolveAdminActor(req) {
  const findAdminDoc = async (rawValue) => {
    const v = String(rawValue || "").trim();
    if (!v) return null;

    if (mongoose.Types.ObjectId.isValid(v)) {
      const byId = await Admin.findById(v)
        .select("_id email name role status")
        .lean();
      if (byId) return byId;
    }

    const byEmail = await Admin.findOne({ email: v.toLowerCase() })
      .select("_id email name role status")
      .lean();
    if (byEmail) return byEmail;

    return null;
  };

  const adminDoc =
    (await findAdminDoc(req.user?.adminId)) ||
    (await findAdminDoc(req.user?._id)) ||
    (await findAdminDoc(req.user?.id)) ||
    (await findAdminDoc(req.user?.email)) ||
    (await findAdminDoc(req.body?.adminMongoId)) ||
    (await findAdminDoc(req.body?.adminId)) ||
    (await findAdminDoc(req.body?.adminEmail));

  if (!adminDoc) return null;

  return {
    role: "admin",
    userId: adminDoc._id,
    userModel: "Master",
    email: adminDoc.email,
    name: adminDoc.name || "",
    adminRole: adminDoc.role,
    adminStatus: adminDoc.status,
  };
}
// ===============================
// CREATE CAMPAIGN
// ===============================
exports.createCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    console.time("createCampaign.total");

    console.time("detectGeoFromRequest");
    const geo = await detectGeoFromRequest(req);
    console.timeEnd("detectGeoFromRequest");

    console.time("getCampaignTimezone");
    const campaignTz = getCampaignTimezone(req.body);
    console.timeEnd("getCampaignTimezone");

    console.time("findBrandDocByAnyId");
    const brandDoc = await findBrandDocByAnyId(req.body.brandId);
    console.timeEnd("findBrandDocByAnyId");

    if (!brandDoc) {
      console.timeEnd("createCampaign.total");
      return fail(
        res,
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Brand not found",
        requestId
      );
    }

    console.time("resolveActorFromPayload");
    const actor = await resolveActorFromPayload(
      req,
      String(brandDoc.brandId || brandDoc._id || req.body.brandId || "")
    );
    console.timeEnd("resolveActorFromPayload");

    console.time("inferMode");
    const mode = inferMode(req.body.status, req.body.scheduledAt);
    console.timeEnd("inferMode");

    console.time("validateForMode");
    const v = await validateForMode(res, requestId, mode, req.body);
    console.timeEnd("validateForMode");
    if (!v.ok) {
      console.timeEnd("createCampaign.total");
      return v.resp;
    }

    const status =
      mode === "draft"
        ? "draft"
        : mode === "schedule"
          ? "scheduled"
          : "active";

    let timing = {};

    if (status === "draft") {
      console.time("parseDraftWindowSoft");
      timing = parseDraftWindowSoft(req.body, campaignTz);
      console.timeEnd("parseDraftWindowSoft");
    } else if (status === "scheduled") {
      console.time("parseSchedule");
      const sch = parseSchedule(req.body, campaignTz, requestId, res);
      console.timeEnd("parseSchedule");
      if (!sch.ok) {
        console.timeEnd("createCampaign.total");
        return sch.resp;
      }
      timing = sch.value;
    } else {
      console.time("parseCampaignWindow");
      const win = parseCampaignWindow(req.body, campaignTz, requestId, res, true);
      console.timeEnd("parseCampaignWindow");
      if (!win.ok) {
        console.timeEnd("createCampaign.total");
        return win.resp;
      }
      timing = win.value;
    }

    req.body.campaignTimezone = campaignTz;

    const brandSubscriptionSnapshot = buildBrandSubscriptionSnapshot(brandDoc);

    const docToCreate = buildCampaignDoc(req.body, geo, status, 0, timing, {
      brandName: String(brandDoc.name || brandDoc.brandName || ""),
      createdBy: actor,
      approvalMode: actor.role === "admin" ? "admin_review" : "direct",
      categoryName: v?.rel?.cat?.name || "",
      subcategoryNames: Array.isArray(v?.rel?.subs)
        ? v.rel.subs.map((s) => String(s.name || ""))
        : [],
      brandSubscriptionSnapshot,
    });
    console.timeEnd("buildCampaignDoc");

    console.time("Campaign.create");
    const created = await Campaign.create(docToCreate);
    console.timeEnd("Campaign.create");

    if (status === "draft" && actor.role === "admin") {
      console.time("notifyBrandDraftReady");
      await notifyBrandDraftReady(created).catch(console.error);
      console.timeEnd("notifyBrandDraftReady");
    }

    if (status === "active") {
      console.time("notifyMatchingInfluencersForNewCampaign");
      await notifyMatchingInfluencersForNewCampaign(
        {
          ...created.toObject(),
          brandName: String(brandDoc.name || brandDoc.brandName || ""),
        },
        normalizeObjectIdArray(req.body.subcategoryIds)
      );
      console.timeEnd("notifyMatchingInfluencersForNewCampaign");
    }

    console.time("enrichCampaigns");
    const enriched = (await enrichCampaigns([created]))[0];
    console.timeEnd("enrichCampaigns");

    console.timeEnd("createCampaign.total");

    return ApiResponse.sendOk(
      res,
      HttpStatus.CREATED,
      { doc: enriched },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "CREATE_CAMPAIGN_ERROR");
    console.timeEnd("createCampaign.total");
    return sendControllerError(res, requestId, err);
  }
};

// ===============================
// AI PREFILL
// ===============================
// ===============================
// AI PREFILL
// ===============================
const buildAIPrompt = (ui) => `
You are an expert influencer marketing campaign strategist.

The user is creating a campaign through an AI prompt box.
The frontend may send:
- description / campaignPrompt
- productLink
- uploaded productImages metadata and image URLs

Your job is to generate a COMPLETE campaign prefill that aligns 1:1 with the MANUAL campaign form and backend campaign schema.

IMPORTANT ASSET RULES:
- DO NOT invent image URLs.
- DO NOT remove, rewrite, rename, or replace productImages.
- DO NOT output productImages.
- Product images are already uploaded and will be preserved by backend.
- Use product image visual context only to infer product category, campaign title, tone, audience, YouTube content formats, and creator requirements.
- If a productLink is provided, use it as context only. Backend will preserve productLink directly.
- Never create fake links, fake video links, fake image URLs, or fake attachment URLs.

PLATFORM RULE:
- This product is now fixed to YouTube only.
- Do NOT output any platform field.
- Do NOT choose Instagram or TikTok.
- Content formats, deliverables, creator requirements, and additionalNotes should be optimized for YouTube.

STRICT OUTPUT RULES:
- Output MUST be ONLY valid JSON.
- No markdown.
- No comments.
- No explanations.
- Always include ALL output keys listed below.
- For ID fields, return ONLY IDs from allowedOptions.
- Never return labels/names where IDs are required.
- Never return objects where string IDs are required.
- If unsure, pick the closest safe default from allowedOptions.
- Prefer 1 strong category and 1-3 relevant subcategories.
- Prefer realistic campaign values that can pass manual form validation.

MANUAL CAMPAIGN FIELD ALIGNMENT:

1. Product / Service Info
- campaignTitle: short, clear, brand-facing campaign title.
- enhancedDescription: polished influencer-facing description generated from user prompt, product link, and images.
- campaignType: one of common manual types if inferable: Paid, Gifting, Affiliate, Ambassador, Event, UGC Only, Sponsored, Paid + Bonus.
- categoryId: MUST be one id from allowedOptions.categories.
- subcategoryIds: MULTI-SELECT. Pick 1 to 3 relevant ids from the selected category's subcategories.
- productLink is source context only. Backend preserves it.
- productImages are source context only. Backend preserves uploaded image objects.

2. Campaign Goals
- campaignGoals: MULTI-SELECT. Pick 1 to 3 ids from allowedOptions.campaignGoals.
- Pick goals that match the product, audience, and YouTube campaign objective.

3. Creator Requirements
- numberOfInfluencers: integer >= 1.
- influencerTierIds: MULTI-SELECT. Pick 1 to 3 ids from allowedOptions.influencerTiers.
- minFollowers and maxFollowers:
  - Use realistic values aligned with selected influencer tier.
  - If unknown, use 0 for both.
  - If provided, maxFollowers must be >= minFollowers.
  - Do not use values below backend minimum unless both are 0.
- contentFormats: MULTI-SELECT. Pick 1 to 4 ids from allowedOptions.contentFormats.
- Prefer YouTube-friendly content formats such as long-form videos, Shorts, reviews, tutorials, unboxing, product demos, integrations, or UGC where available.
- contentLanguageIds: choose ids from allowedOptions.contentLanguages when useful; otherwise [].

4. Timeline & Payments
- paymentType: MUST be one of: Milestone, Fixed, Gifting.
- campaignBudget: integer >= 0.
- If campaign is gifting-only, budget can be 0.
- If paid/sponsored, choose a realistic positive budget.
- startAt and endAt:
  - ISO local datetime WITHOUT timezone offset.
  - Format: "yyyy-MM-dd'T'HH:mm"
  - Use guidance.datetimeFormat.
  - Ensure endAt > startAt.
  - Prefer startAt tomorrow at 09:00.
  - Prefer endAt 7-14 days after startAt.

5. Audience
- targetCountryIds: MULTI-SELECT. Pick 1 to 4 ids from allowedOptions.targetCountries.
- targetAgeRanges: MULTI-SELECT. Pick 1 to 4 ids from allowedOptions.targetAgeRanges.
- preferredHashtags: choose ids from allowedOptions.preferredHashtags when available and relevant; otherwise [].

6. Additional Notes
- additionalNotes should summarize:
  - YouTube creator style direction
  - product/image observations if image context exists
  - product link/reference usage if productLink exists
  - key YouTube deliverables or campaign angle
- Keep it concise and useful for the manual campaign review screen.

CATEGORY SELECTION RULES:
- categoryId MUST be from allowedOptions.categories[*].id.
- subcategoryIds MUST be from the selected category's subcategories only.
- If the prompt or images clearly show a product type, choose the closest matching category/subcategory.
- If the product is broad/unclear, choose the safest general category available.

IMAGE REASONING RULES:
- If images are provided, infer what the product appears to be.
- Use image filenames, content types, and visual image inputs if available.
- Mention useful product/image observations only in enhancedDescription or additionalNotes.
- Do not put image URLs in additionalNotes unless directly useful.
- Do not output productImages in JSON.

PRODUCT LINK RULES:
- Use productLink to infer product/category/campaign angle when available.
- Do not output productLink in JSON; backend preserves it.
- Do not invent link summaries if link content is not accessible.

Output JSON keys:
{
  "campaignTitle": "",
  "enhancedDescription": "",
  "campaignType": "",
  "categoryId": "",
  "subcategoryIds": [],
  "targetCountryIds": [],
  "targetAgeRanges": [],
  "campaignGoals": [],
  "influencerTierIds": [],
  "contentFormats": [],
  "contentLanguageIds": [],
  "preferredHashtags": [],
  "paymentType": "",
  "campaignBudget": 0,
  "numberOfInfluencers": 1,
  "minFollowers": 0,
  "maxFollowers": 0,
  "startAt": "",
  "endAt": "",
  "additionalNotes": ""
}

INPUT:
${JSON.stringify(ui, null, 2)}
`.trim();

exports.prefillCampaignWithAI = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const geo = await detectGeoFromRequest(req);
    const tz = getCampaignTimezone(req.body);
    const nowLocal = DateTime.now().setZone(tz);

    const brandDoc = await findBrandDocByAnyId(req.body.brandId);
    if (!brandDoc) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Brand not found", requestId);
    }

    const actor = await resolveActorFromPayload(
      req,
      String(brandDoc.brandId || brandDoc._id || req.body.brandId || "")
    );

    const brandIdR = requireObjectId(res, requestId, "brandId", req.body.brandId);
    if (!brandIdR.ok) return brandIdR.resp;

    const sourceBrief =
      clean(req.body.description) ||
      clean(req.body.campaignPrompt) ||
      clean(req.body.prompt) ||
      clean(req.body.message);

    if (!sourceBrief) {
      return failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "description",
        requestId,
        "Please describe your campaign."
      );
    }

    const productLink = clean(req.body.productLink);
    if (productLink && !isValidHttpUrl(productLink)) {
      return failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "productLink",
        requestId,
        "productLink must be a valid http/https URL"
      );
    }

    const videoLink = clean(req.body.videoLink);
    if (videoLink && !isValidHttpUrl(videoLink)) {
      return failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "videoLink",
        requestId,
        "videoLink must be a valid http/https URL"
      );
    }

    const uploadedProductImages = req.body.productImages
      ? await normalizeProductImagesForDraft(req.body.productImages)
      : [];

    const [
      categories,
      goals,
      tiers,
      formats,
      langs,
      countries,
      ages,
    ] = await Promise.all([
      Category.find({})
        .select("_id name subcategories")
        .lean()
        .limit(200),

      ProductServiceGoalModel.find({ isActive: { $ne: false } })
        .select("_id goal")
        .lean()
        .limit(120),

      InfluencerTier.find({})
        .select("_id category value sortOrder")
        .lean()
        .limit(120),

      ContentFormat.find({})
        .select("_id name title type format")
        .lean()
        .limit(200),

      ContentLanguage.find({ isActive: { $ne: false } })
        .select("_id code name")
        .lean()
        .limit(200),

      Country.find({})
        .select("_id countryNameEn countryNameLocal countryName name countryCode flag")
        .lean()
        .limit(250),

      AgeRange.find({})
        .select("_id range")
        .lean()
        .limit(100),
    ]);

    const allowedCategories = (categories || [])
      .map((cat) => ({
        id: String(cat._id),
        label: String(cat.name || ""),
        subcategories: (Array.isArray(cat.subcategories) ? cat.subcategories : [])
          .map((sub) => ({
            id: String(sub._id),
            label: String(sub.name || ""),
            tags: sub.tags ?? [],
          }))
          .filter((sub) => sub.id && sub.label),
      }))
      .filter((cat) => cat.id && cat.label && cat.subcategories.length);

    const allowed = {
      categories: allowedCategories,

      campaignGoals: (goals || []).map((g) => ({
        id: String(g._id),
        label: String(g.goal ?? ""),
      })),

      influencerTiers: (tiers || []).map((t) => ({
        id: String(t._id),
        label: [t.category, t.value].filter(Boolean).join(" ").trim(),
      })),

      contentFormats: (formats || []).map((f) => ({
        id: String(f._id),
        label: String(f.name ?? f.title ?? f.type ?? f.format ?? ""),
      })),

      contentLanguages: (langs || []).map((l) => ({
        id: String(l._id),
        label: `${l.name ?? ""} ${l.code ? `(${l.code})` : ""}`.trim(),
      })),

      targetCountries: (countries || []).map((c) => ({
        id: String(c._id),
        label: String(c.countryNameEn || c.countryName || c.name || c.countryNameLocal || c.countryCode || ""),
        countryCode: String(c.countryCode || ""),
      })),

      targetAgeRanges: (ages || []).map((a) => ({
        id: String(a._id),
        label: String(a.range || ""),
      })),
    };

    const imageContext = uploadedProductImages.map((img, index) => ({
      index,
      name: String(img.name || ""),
      url: String(img.dataUrl || img.url || img.imageUrl || img.s3Url || img.location || img.Location || img.secure_url || img.src || ""),
      type: String(img.contentType || img.type || ""),
      size: Number(img.size || img.originalSize || 0) || 0,
      key: String(img.key || ""),
    }));

    const ui = {
      source: {
        description: sourceBrief,
        campaignPrompt: clean(req.body.campaignPrompt) || sourceBrief,
        productLink: productLink || null,
        videoLink: videoLink || null,

        productImages: imageContext,
        productImageCount: imageContext.length,
        hasProductImages: imageContext.length > 0,
        hasProductLink: Boolean(productLink),
      },

      manualFormSchema: {
        campaignTitle: "string",
        description: "string",
        campaignType: "string",
        categoryId: "ObjectId string",
        subcategoryIds: "ObjectId string[]",
        productImages: "preserved by backend from uploadedProductImages",
        productLink: "preserved by backend from request productLink",
        campaignGoals: "ObjectId string[]",
        influencerTierIds: "ObjectId string[]",
        contentFormats: "ObjectId string[]",
        contentLanguageIds: "ObjectId string[]",
        targetCountryIds: "ObjectId string[]",
        targetAgeRanges: "ObjectId string[]",
        preferredHashtags: "ObjectId string[]",
        numberOfInfluencers: "number",
        minFollowers: "number",
        maxFollowers: "number",
        campaignBudget: "number",
        paymentType: "Milestone | Fixed | Gifting",
        additionalNotes: "string",
        startAt: "yyyy-MM-dd'T'HH:mm",
        endAt: "yyyy-MM-dd'T'HH:mm",
      },

      manualValidationRules: {
        required: [
          "campaignTitle",
          "enhancedDescription",
          "categoryId",
          "subcategoryIds",
          "campaignGoals",
          "influencerTierIds",
          "contentFormats",
          "targetCountryIds",
          "targetAgeRanges",
          "paymentType",
          "campaignBudget",
          "numberOfInfluencers",
          "startAt",
          "endAt",
        ],
        productImages: "AI does not generate this. Backend preserves uploaded images.",
        productLink: "AI does not generate this. Backend preserves request productLink.",
        minFollowers: `0 or >= ${MIN_FOLLOWERS_ALLOWED}`,
        maxFollowers: `0 or >= ${MIN_FOLLOWERS_ALLOWED}; must be >= minFollowers when both are positive`,
        campaignBudget: ">= 0",
        numberOfInfluencers: ">= 1",
        paymentType: ["Milestone", "Fixed", "Gifting"],
      },

      allowedOptions: allowed,

      guidance: {
        timezone: tz,
        todayLocal: nowLocal.toFormat("yyyy-LL-dd"),
        datetimeFormat: "yyyy-MM-dd'T'HH:mm",
        fixedPlatform: "youtube",
        paymentTypesAllowed: ["Milestone", "Fixed", "Gifting"],
        preserveAssets: true,
      },
    };

    const warnings = [];

    const defaultStartEnd = () => {
      const start = DateTime.now()
        .setZone(tz)
        .plus({ days: 1 })
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });

      const end = start.plus({ days: 10 });

      const fmt = (d) =>
        d.toISO({
          suppressSeconds: true,
          suppressMilliseconds: true,
          includeOffset: false,
        });

      return { startAt: fmt(start), endAt: fmt(end) };
    };

    const normalizeIsoLocal = (s) => {
      const v = clean(s);
      if (!v) return "";

      const dt = DateTime.fromISO(v, { zone: tz });
      if (!dt.isValid) return "";

      return dt.toISO({
        suppressSeconds: true,
        suppressMilliseconds: true,
        includeOffset: false,
      });
    };

    const pickIds = (value, allowedIds, min = 0) => {
      const set = new Set(allowedIds);
      const picked = normalizeObjectIdArray(value).filter((id) => set.has(id));

      if (picked.length >= min) return [...new Set(picked)];

      return allowedIds.slice(0, Math.min(min, allowedIds.length));
    };

    const normalizePayment = (v) => {
      const x = normalizePaymentType(clean(v) || "Milestone");
      return ["Milestone", "Fixed", "Gifting"].includes(x) ? x : "Milestone";
    };

    const fallbackTitleFromBrief = (text) => {
      const cleanText = String(text || "")
        .replace(/\s+/g, " ")
        .trim();

      const firstSentence = cleanText.split(/[.!?]/)[0]?.trim();
      const title = firstSentence || cleanText;

      if (!title) return "AI Generated Campaign";
      return title.length > 72 ? `${title.slice(0, 69).trim()}...` : title;
    };

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    let aiJson = {};

    if (!process.env.OPENAI_API_KEY) {
      warnings.push("OPENAI_API_KEY missing: returned fallback prefill.");
    } else {
      try {
        const prompt = buildAIPrompt(ui);

        const imageInputs = imageContext
          .map((img) => img.url)
          .filter((url) => isValidHttpUrl(url))
          .slice(0, 6)
          .map((url) => ({
            type: "input_image",
            image_url: url,
          }));

        const aiResp = await openai.responses.create({
          model,
          input: [
            {
              role: "system",
              content:
                "Return JSON only. No markdown. Align every generated value with the manual campaign form schema.",
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: prompt,
                },
                ...imageInputs,
              ],
            },
          ],
          text: { format: { type: "json_object" } },
          temperature: 0.25,
          max_output_tokens: 2200,
        });

        try {
          aiJson = JSON.parse(aiResp.output_text || "{}");
        } catch {
          warnings.push("AI returned invalid JSON: fallback values were used.");
          aiJson = {};
        }
      } catch (e) {
        warnings.push(`AI call failed: ${String(e?.message || "unknown error")}. Fallback values were used.`);
        aiJson = {};
      }
    }

    const pickedCategory =
      allowed.categories.find((cat) => cat.id === clean(aiJson.categoryId)) ||
      allowed.categories[0] ||
      null;

    const categoryIdPick = pickedCategory?.id || "";
    const allowedSubIds = pickedCategory?.subcategories?.map((x) => x.id) || [];
    const subcategoryIdsPick = pickIds(aiJson.subcategoryIds, allowedSubIds, allowedSubIds.length ? 1 : 0);

    const prefHashtagsDocs = subcategoryIdsPick.length
      ? await PreferredHashtag.find({
        subcategoryId: { $in: subcategoryIdsPick.map((id) => toObjectId(id)) },
      })
        .select("_id hashtag tag name")
        .lean()
        .limit(300)
      : [];

    const allowedPreferredHashtags = prefHashtagsDocs.map((h) => ({
      id: String(h._id),
      label: String(h.hashtag ?? h.tag ?? h.name ?? ""),
    }));

    const allowedGoalIds = allowed.campaignGoals.map((x) => x.id);
    const allowedTierIds = allowed.influencerTiers.map((x) => x.id);
    const allowedFormatIds = allowed.contentFormats.map((x) => x.id);
    const allowedLangIds = allowed.contentLanguages.map((x) => x.id);
    const allowedCountryIds = allowed.targetCountries.map((x) => x.id);
    const allowedAgeIds = allowed.targetAgeRanges.map((x) => x.id);
    const allowedHashIds = allowedPreferredHashtags.map((x) => x.id);

    const goalsPick = pickIds(aiJson.campaignGoals, allowedGoalIds, 1);
    const tiersPick = pickIds(aiJson.influencerTierIds, allowedTierIds, 1);
    const formatsPick = pickIds(aiJson.contentFormats, allowedFormatIds, 1);
    const langsPick = pickIds(aiJson.contentLanguageIds, allowedLangIds, 0);
    const countriesPick = pickIds(aiJson.targetCountryIds, allowedCountryIds, 1);
    const agesPick = pickIds(aiJson.targetAgeRanges, allowedAgeIds, 1);
    const hashtagsPick = pickIds(aiJson.preferredHashtags, allowedHashIds, 0);

    const paymentPick = normalizePayment(aiJson.paymentType);
    const budgetPick = Math.max(0, Math.trunc(toNumber(aiJson.campaignBudget) || 0));
    const numInfluencersPick = clampInt(aiJson.numberOfInfluencers, 1, 1, 100000);

    const minFollowersRaw = toInt(aiJson.minFollowers);
    const maxFollowersRaw = toInt(aiJson.maxFollowers);

    let minFollowersPick = Number.isFinite(minFollowersRaw) ? Math.max(0, minFollowersRaw) : undefined;
    let maxFollowersPick = Number.isFinite(maxFollowersRaw) ? Math.max(0, maxFollowersRaw) : undefined;

    if (typeof minFollowersPick === "number" && minFollowersPick > 0 && minFollowersPick < MIN_FOLLOWERS_ALLOWED) {
      warnings.push(`AI suggested minFollowers below ${MIN_FOLLOWERS_ALLOWED}; removed.`);
      minFollowersPick = undefined;
    }

    if (typeof maxFollowersPick === "number" && maxFollowersPick > 0 && maxFollowersPick < MIN_FOLLOWERS_ALLOWED) {
      warnings.push(`AI suggested maxFollowers below ${MIN_FOLLOWERS_ALLOWED}; removed.`);
      maxFollowersPick = undefined;
    }

    let startAtPick = normalizeIsoLocal(aiJson.startAt);
    let endAtPick = normalizeIsoLocal(aiJson.endAt);

    if (!startAtPick || !endAtPick) {
      const d = defaultStartEnd();
      startAtPick = startAtPick || d.startAt;
      endAtPick = endAtPick || d.endAt;
    }

    const st = DateTime.fromISO(startAtPick, { zone: tz });
    const en = DateTime.fromISO(endAtPick, { zone: tz });

    if (!st.isValid || !en.isValid || en <= st) {
      const d = defaultStartEnd();
      startAtPick = d.startAt;
      endAtPick = d.endAt;
      warnings.push("Invalid AI startAt/endAt: replaced with safe default window.");
    }

    const rel =
      categoryIdPick && subcategoryIdsPick.length
        ? await resolveCategoryAndSubcategories(categoryIdPick, subcategoryIdsPick)
        : { cat: null, subs: [], error: "" };

    if (rel.error) {
      warnings.push(rel.error);
    }

    const enhancedTitle =
      clean(aiJson.campaignTitle) ||
      clean(aiJson.enhancedTitle) ||
      fallbackTitleFromBrief(sourceBrief);

    const enhancedDescription =
      clean(aiJson.enhancedDescription) ||
      sourceBrief;

    const prefillDetails = {
      category: rel.cat
        ? { id: String(rel.cat._id), name: String(rel.cat.name || "") }
        : pickedCategory
          ? { id: pickedCategory.id, name: pickedCategory.label }
          : null,

      subcategories: rel.subs?.length
        ? rel.subs.map((s) => ({
          id: String(s._id),
          name: String(s.name || ""),
          tags: s.tags ?? [],
        }))
        : (pickedCategory?.subcategories || [])
          .filter((sub) => subcategoryIdsPick.includes(sub.id))
          .map((sub) => ({
            id: sub.id,
            name: sub.label,
            tags: sub.tags ?? [],
          })),
    };

    const prefill = {
      brandId: brandIdR.value,

      campaignTitle: enhancedTitle,
      description: enhancedDescription,
      campaignType: clean(aiJson.campaignType) || "",

      categoryId: categoryIdPick || undefined,
      subcategoryIds: subcategoryIdsPick,

      targetCountryIds: countriesPick,
      targetAgeRanges: agesPick,

      productImages: uploadedProductImages,
      productLink: productLink || undefined,
      videoLink: videoLink || undefined,

      campaignGoals: goalsPick,
      influencerTierIds: tiersPick,
      contentFormats: formatsPick,
      contentLanguageIds: langsPick,
      preferredHashtags: hashtagsPick,
      paymentType: paymentPick,
      campaignBudget: budgetPick,
      numberOfInfluencers: numInfluencersPick,
      minFollowers: minFollowersPick,
      maxFollowers: maxFollowersPick,

      startAt: startAtPick,
      endAt: endAtPick,

      additionalNotes: clean(aiJson.additionalNotes) || "",
    };

    if (req.body.saveDraft === true) {
      const win = parseCampaignWindow(prefill, tz, requestId, res, false);
      if (!win.ok) return win.resp;

      const brandSubscriptionSnapshot = buildBrandSubscriptionSnapshot(brandDoc);

      const docToCreate = buildCampaignDoc(
        { ...prefill, status: "draft", campaignTimezone: tz },
        geo,
        "draft",
        1,
        win.value,
        {
          brandName: String(brandDoc.name || brandDoc.brandName || ""),
          createdBy: actor,
          approvalMode: actor.role === "admin" ? "admin_review" : "direct",
          categoryName: prefillDetails.category?.name || "",
          subcategoryNames: Array.isArray(prefillDetails.subcategories)
            ? prefillDetails.subcategories.map((s) => String(s.name || ""))
            : [],
          brandSubscriptionSnapshot,
        }
      );

      const savedDoc = await Campaign.create(docToCreate);

      if (actor.role === "admin") {
        await notifyBrandDraftReady(savedDoc).catch(console.error);
      }

      const enrichedSaved = (await enrichCampaigns([savedDoc]))[0];

      return ApiResponse.sendOk(
        res,
        HttpStatus.OK,
        {
          prefill,
          prefillDetails,
          savedDraft: enrichedSaved,
          meta: {
            aiUsed: !!process.env.OPENAI_API_KEY,
            warnings,
            originalSource: {
              description: sourceBrief,
              productLink: productLink || null,
              imageCount: uploadedProductImages.length,
            },
          },
        },
        requestId
      );
    }

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        prefill,
        prefillDetails,
        meta: {
          aiUsed: !!process.env.OPENAI_API_KEY,
          warnings,
          originalSource: {
            description: sourceBrief,
            productLink: productLink || null,
            imageCount: uploadedProductImages.length,
          },
        },
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "AI_PREFILL_CAMPAIGN_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

const FULLY_MANAGED_CAMPAIGN_TEXT_MARKERS = [
  /^fully[\s_-]*managed$/i,
  /^full[\s_-]*managed$/i,
  /^fullymanaged$/i,
  /^fullmanaged$/i,
  /^managed$/i,
  /^done[\s_-]*for[\s_-]*you$/i,
  /^doneforyou$/i,
];

function getAuthedBrandIdForCampaignDropdown(req = {}) {
  return clean(
    req.brand?._id ||
    req.brand?.id ||
    req.brand?.brandId ||
    req.brandId ||
    req.user?.brandId ||
    req.user?.brand?._id ||
    req.user?.brand?.id ||
    req.user?._id ||
    req.user?.id ||
    req.auth?.brandId ||
    req.query?.brandId
  );
}

// ===============================
// GET BRAND CREATED CAMPAIGNS ONLY
// Excludes campaigns created by admin
// ===============================

function getBrandIdOnlyForCampaignDropdown(req = {}) {
  return clean(req.query?.brandId || req.body?.brandId);
}

function getBrandCreatedCampaignSearchOr(search) {
  const term = clean(search);

  if (!term) return [];

  return [
    { campaignTitle: { $regex: term, $options: "i" } },
    { productOrServiceName: { $regex: term, $options: "i" } },
    { brandName: { $regex: term, $options: "i" } },
    { campaignType: { $regex: term, $options: "i" } },
    { campaignCategory: { $regex: term, $options: "i" } },
    { campaignSubcategory: { $regex: term, $options: "i" } },
    { status: { $regex: term, $options: "i" } },
  ];
}

function getAdminCreatedCampaignNor() {
  return [
    { approvalMode: "admin_review" },
    { "createdBy.role": { $regex: /^admin$/i } },
    { "createdBy.userModel": { $regex: /^Master$/i } },
  ];
}

function isUrlLikeCampaignLabel(value = "") {
  const text = clean(value);

  if (!text) return false;

  return (
    /^https?:\/\//i.test(text) ||
    /^www\./i.test(text) ||
    text.includes("localhost:") ||
    text.includes("/brand/") ||
    text.includes("/campaign/")
  );
}

function pickSafeCampaignLabel(candidates = [], fallback = "Campaign") {
  for (const candidate of candidates) {
    const text = clean(candidate);

    if (!text) continue;
    if (["undefined", "null"].includes(text.toLowerCase())) continue;
    if (isUrlLikeCampaignLabel(text)) continue;

    return text;
  }

  return fallback;
}

function serializeBrandCreatedCampaign(campaignDoc = {}) {
  const id = campaignDoc?._id ? String(campaignDoc._id) : "";

  const label = pickSafeCampaignLabel(
    [
      campaignDoc.campaignTitle,
      campaignDoc.productOrServiceName,
      campaignDoc.title,
      campaignDoc.name,
    ],
    id ? `Campaign ${id.slice(-6)}` : "Campaign"
  );

  return {
    id,
    _id: id,
    campaignId: id,
    label: label || id,

    campaignTitle: clean(campaignDoc.campaignTitle || campaignDoc.title || campaignDoc.name),
    productOrServiceName: clean(campaignDoc.productOrServiceName),
    description: clean(campaignDoc.description),

    brandId: campaignDoc.brandId ? String(campaignDoc.brandId) : "",
    brandName: clean(campaignDoc.brandName),

    status: clean(campaignDoc.status),
    publishStatus: clean(campaignDoc.publishStatus),
    approvalMode: clean(campaignDoc.approvalMode),

    isActive: campaignDoc.isActive,
    isDraft: campaignDoc.isDraft,
    byAi: campaignDoc.byAi,

    campaignType: clean(campaignDoc.campaignType),
    campaignCategory: clean(campaignDoc.campaignCategory),
    campaignSubcategory: clean(campaignDoc.campaignSubcategory),

    categoryId: campaignDoc.categoryId ? String(campaignDoc.categoryId) : "",
    subcategoryIds: Array.isArray(campaignDoc.subcategoryIds)
      ? campaignDoc.subcategoryIds.map((id) => String(id))
      : [],

    numberOfInfluencers: campaignDoc.numberOfInfluencers,
    applicantCount: campaignDoc.applicantCount,
    campaignBudget: campaignDoc.campaignBudget,
    budget: campaignDoc.budget,

    createdAt: campaignDoc.createdAt,
    updatedAt: campaignDoc.updatedAt,
    publishedAt: campaignDoc.publishedAt,
    scheduledAt: campaignDoc.scheduledAt,
    startAt: campaignDoc.startAt,
    endAt: campaignDoc.endAt,
    timeline: campaignDoc.timeline || null,

    createdBy: campaignDoc.createdBy || null,
    details: campaignDoc.details || null,

    isFullyManaged: Boolean(
      campaignDoc.isFullyManaged || campaignDoc.managementType === "fully_managed"
    ),
    managementType: campaignDoc.managementType || "",
  };
}

exports.getNonFullManagedCampaigns = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const rawBrandId = getBrandIdOnlyForCampaignDropdown(req);

    if (!rawBrandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required.",
        campaigns: [],
        data: {
          campaigns: [],
          total: 0,
        },
        pagination: {
          total: 0,
          page: 1,
          limit: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
        requestId,
      });
    }

    const brandDoc = await findBrandDocByAnyId(rawBrandId);

    const brandObjectId = brandDoc?._id
      ? String(brandDoc._id)
      : isOid(rawBrandId)
        ? rawBrandId
        : "";

    if (!brandObjectId || !isOid(brandObjectId)) {
      return res.status(404).json({
        success: false,
        message: "Brand not found.",
        campaigns: [],
        data: {
          campaigns: [],
          total: 0,
        },
        pagination: {
          total: 0,
          page: 1,
          limit: 0,
          totalPages: 0,
          hasNextPage: false,
          hasPrevPage: false,
        },
        requestId,
      });
    }

    const page = Math.max(
      parseInt(req.query.page || req.body?.page, 10) || 1,
      1
    );

    const limit = Math.max(
      Math.min(parseInt(req.query.limit || req.body?.limit, 10) || 200, 500),
      1
    );

    const skip = (page - 1) * limit;

    const search = clean(
      req.query.search ||
      req.query.q ||
      req.body?.search ||
      req.body?.q
    );

    const filter = {
      brandId: toObjectId(brandObjectId),

      // Exclude campaigns created by admin
      $nor: getAdminCreatedCampaignNor(),
    };

    const searchOr = getBrandCreatedCampaignSearchOr(search);

    if (searchOr.length) {
      filter.$and = [{ $or: searchOr }];
    }

    const sort = { updatedAt: -1, createdAt: -1 };

    const [total, docs] = await Promise.all([
      Campaign.countDocuments(filter),

      Campaign.find(filter)
        .select([
          "_id",
          "brandId",
          "brandName",
          "campaignTitle",
          "productOrServiceName",
          "description",
          "status",
          "publishStatus",
          "approvalMode",
          "isActive",
          "isDraft",
          "byAi",
          "campaignType",
          "campaignCategory",
          "campaignSubcategory",
          "categoryId",
          "subcategoryIds",
          "numberOfInfluencers",
          "applicantCount",
          "campaignBudget",
          "budget",
          "createdBy",
          "isFullyManaged",
          "managementType",
          "createdAt",
          "updatedAt",
          "publishedAt",
          "scheduledAt",
          "startAt",
          "endAt",
          "timeline",
        ].join(" "))
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    let enrichedDocs = docs;

    try {
      enrichedDocs = await enrichCampaigns(docs);
    } catch (enrichErr) {
      console.warn(
        "[getNonFullManagedCampaigns] enrichCampaigns failed:",
        enrichErr?.message || enrichErr
      );
    }

    const campaigns = enrichedDocs.map(serializeBrandCreatedCampaign);
    const totalPages = Math.ceil(total / limit);

    return res.status(200).json({
      success: true,
      message: "Brand-created campaigns fetched successfully.",
      campaigns,
      data: {
        campaigns,
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
      requestId,
    });
  } catch (err) {
    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_BRAND_CREATED_CAMPAIGNS_ERROR"
    );

    console.error("[getNonFullManagedCampaigns] Error:", err);
    return sendControllerError(res, requestId, err);
  }
};


// ===============================
// GET ALL
// ===============================
exports.getAllCampaigns = async (req, res) => {
  try {
    const filter = {};

    if (req.query.brandId && isOid(req.query.brandId)) {
      filter.brandId = toObjectId(req.query.brandId);
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit, 10) || 10, 1);
    const skip = (page - 1) * limit;

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Campaign.countDocuments(filter)
    ]);

    return res.json({
      data: campaigns,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_ALL_CAMPAIGNS_ERROR");
    return res.status(500).json({
      message: "Internal server error while fetching campaigns."
    });
  }
};

// ===============================
// GET SINGLE
// ===============================
exports.getCampaignById = async (req, res) => {


  try {

    const campaignId = clean(req.params.campaignId);



    if (!campaignId || !isOid(campaignId)) {
      return res.status(400).json({ message: "Valid campaignId is required." });
    }

    const campaign = await Campaign.findOne({
      _id: campaignId,

    }).lean();

    if (!campaign) {
      return res.status(404).json({ message: "Campaign not found." });
    }

    const actorIsAdmin = isAdminRequest(req);
    const actorBrandId = String(req.user?.brandId || "");
    const isOwnerBrand =
      !actorIsAdmin &&
      actorBrandId &&
      actorBrandId === String(campaign.brandId);

    if (
      (actorIsAdmin || isOwnerBrand) &&
      campaign.pendingUpdate?.status === "pending" &&
      campaign.pendingUpdate?.patch
    ) {
      return res.json({
        ...campaign,
        pendingApproval: 1,
        pendingPatch: campaign.pendingUpdate.patch,
      });
    }

    return res.json(campaign);
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_CAMPAIGN_BY_ID_ERROR");
    return res.status(500).json({ message: "Internal server error." });
  }
};

// ===============================
// DELETE
// ===============================
exports.deleteCampaignByCampaignId = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);

    if (!brandId || !isOid(brandId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    if (!campaignId || !isOid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const campaign = await Campaign.findOne({
      _id: toObjectId(campaignId),
      brandId: toObjectId(brandId),
    }).select("_id status campaignTitle");

    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    const contractDoc = await Contract.findOne({
      brandId: toObjectId(brandId),
      ...buildContractCampaignFilter(campaignId),
    })
      .select("_id contracts")
      .lean();

    const hasAnyContract = !!(contractDoc?.contracts?.length && contractDoc.contracts.length > 0);

    if (hasAnyContract && campaign.status !== "completed") {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Contract is sent; delete only after campaign is completed.",
        requestId
      );
    }

    await Promise.all([
      Campaign.deleteOne({
        _id: campaign._id,
        brandId: toObjectId(brandId),
      }),
      Contract.deleteMany({
        brandId: toObjectId(brandId),
        ...buildContractCampaignFilter(campaignId),
      }),
    ]);

    return ApiResponse.sendOk(
      res,
      200,
      {
        message: "Campaign deleted successfully",
        deleted: {
          campaignId: String(campaign._id),
          campaignTitle: campaign.campaignTitle,
          status: campaign.status,
          hadContracts: hasAnyContract,
        },
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "DELETE_CAMPAIGN_BY_CAMPAIGN_ID_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

// Get active campaigns for Brand
exports.getActiveCampaignsByBrand = async (req, res) => {
  try {
    const { brandId, page = 1, limit = 10, search = "", sortBy = "createdAt", sortOrder = "desc" } = req.query;
    if (!brandId) return res.status(400).json({ message: "brandId is required." });

    const acceptedIds = await Contract.distinct("campaignId", { brandId, ...activeAcceptedFilter2() });
    const acceptedSet = new Set(acceptedIds.map((id) => String(id)));
    const startOfTodayUTC = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));

    // filter ignores drafts automatically because isActive = 1
    const filter = { brandId, isActive: 1, "timeline.endDate": { $gte: startOfTodayUTC } };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const pageNum = Math.max(parseInt(page, 10), 1);
    const perPage = Math.max(parseInt(limit, 10), 1);
    const sortObj = { [sortBy]: String(sortOrder).toLowerCase() === "asc" ? 1 : -1 };

    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter).select("-description").sort(sortObj).skip((pageNum - 1) * perPage).limit(perPage).lean(),
      Campaign.countDocuments(filter),
    ]);

    return res.json({
      data: campaigns.map((c) => ({ ...c, influencerWorking: acceptedSet.has(String(c._id)) })),
      pagination: { total: totalCount, page: pageNum, limit: perPage, totalPages: Math.ceil(totalCount / perPage) }
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_ACTIVE_CAMPAIGNS_BY_BRAND_ERROR");
    return res.status(500).json({ message: "Internal server error." });
  }
};

exports.getPreviousCampaigns = async (req, res) => {
  try {
    const { brandId, page = 1, limit = 10, search = '', sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    if (!brandId) return res.status(400).json({ message: 'Query parameter brandId is required.' });

    const filter = { brandId, isActive: 0, isDraft: 0 }; // hide drafts from previous tab
    if (search) filter.$or = buildSearchOr(search);

    const sortObj = { [sortBy]: String(sortOrder).toLowerCase() === 'asc' ? 1 : -1 };
    const skip = (Math.max(parseInt(page, 10), 1) - 1) * Math.max(parseInt(limit, 10), 1);

    const [campaigns, totalCount] = await Promise.all([
      Campaign.find(filter).sort(sortObj).skip(skip).limit(Math.max(parseInt(limit, 10), 1)).lean(),
      Campaign.countDocuments(filter)
    ]);

    return res.json({ data: campaigns, pagination: { total: totalCount, page: Math.max(parseInt(page, 10), 1), limit: Math.max(parseInt(limit, 10), 1), totalPages: Math.ceil(totalCount / Math.max(parseInt(limit, 10), 1)) } });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_PREVIOUS_CAMPAIGNS_ERROR");
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

exports.getActiveCampaignsByCategories = async (req, res) => {
  try {
    let { subcategoryIds, search, page = 1, limit = 10 } = req.body;
    if (!Array.isArray(subcategoryIds) || subcategoryIds.length === 0) return res.status(400).json({ message: 'subcategoryId required' });

    const filter = addInfluencerOpenStatusGate({ isActive: 1, isDraft: { $ne: 1 }, 'categories.subcategoryId': { $in: subcategoryIds.map(String) } });
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()
    ]);
    return res.json({ meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) }, campaigns });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_ACTIVE_CAMPAIGNS_BY_CATEGORIES_ERROR");
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.checkApplied = async (req, res) => {
  const { campaignId, influencerId } = req.body;
  if (!campaignId || !influencerId) return res.status(400).json({ message: 'Missing fields' });
  try {
    if (!isOid(campaignId)) {
      return res.status(400).json({ message: 'Invalid campaignId' });
    }

    const campaign = await Campaign.findById(campaignId).lean();
    if (!campaign) return res.status(404).json({ message: 'Not found.' });
    campaign.hasApplied = await ApplyCampaign.exists({ campaignId, 'applicants.influencerId': influencerId }) ? 1 : 0;
    return res.json(campaign);
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "CHECK_APPLIED_ERROR");
    return res.status(500).json({ message: 'Internal server error' });
  }
};

exports.getCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId required" });
  }

  try {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    // ✅ support both Mongo _id and custom influencerId
    const influencerLookup = mongoose.Types.ObjectId.isValid(String(influencerId))
      ? {
        $or: [
          { _id: influencerId },
          { influencerId: String(influencerId) }
        ]
      }
      : { influencerId: String(influencerId) };

    const inf = await Influencer.findOne(influencerLookup).lean();

    if (!inf) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const publicInfluencerId = String(inf.influencerId || inf._id);

    const subIdToParentNum = await buildSubToParentNumMap();

    const selectedSubIds = new Set(
      (inf.onboarding?.subcategories || [])
        .map((s) => s?.subcategoryId)
        .filter(Boolean)
        .map(String)
    );

    const selectedCatNumIds = new Set();

    if (typeof inf.onboarding?.categoryId === "number") {
      selectedCatNumIds.add(inf.onboarding.categoryId);
    }

    for (const subId of selectedSubIds) {
      const parentNum = subIdToParentNum.get(subId);
      if (typeof parentNum === "number") {
        selectedCatNumIds.add(parentNum);
      }
    }

    if (selectedSubIds.size === 0 && selectedCatNumIds.size === 0) {
      return res.json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0,
        },
        campaigns: [],
      });
    }

    const orClauses = [];

    if (selectedSubIds.size) {
      orClauses.push({
        "categories.subcategoryId": { $in: Array.from(selectedSubIds) },
      });
    }

    if (selectedCatNumIds.size) {
      orClauses.push({
        "categories.categoryId": { $in: Array.from(selectedCatNumIds) },
      });
    }

    const filter = {
      isActive: 1,
      isDraft: { $ne: 1 },
      $or: orClauses,
    };

    if (search?.trim()) {
      filter.$and = [{ $or: buildSearchOr(search.trim()) }];
    }

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
    ]);

    let canApply = true;

    const applyF = (inf.subscription?.features || []).find(
      (f) => f.key === "apply_to_campaigns_quota"
    );

    if (applyF) {
      const fReset = await ensureMonthlyWindow(
        publicInfluencerId,
        "apply_to_campaigns_quota",
        applyF
      );

      if (
        readLimit(fReset) > 0 &&
        Number(fReset.used || 0) >= readLimit(fReset)
      ) {
        canApply = false;
      }
    }

    const cap = readLimit(
      (inf.subscription?.features || []).find(
        (f) => f.key === "active_collaborations_limit"
      )
    );

    if (
      cap > 0 &&
      (await countActiveCollaborationsForInfluencer(publicInfluencerId)) >= cap
    ) {
      canApply = false;
    }

    return res.json({
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
      campaigns: campaigns.map((c) => ({
        ...c,
        hasApplied: 0,
        hasApproved: 0,
        isContracted: 0,
        contractId: null,
        isAccepted: 0,
        canApply,
      })),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_CAMPAIGNS_BY_INFLUENCER_ERROR");
    console.error("getCampaignsByInfluencer error:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getApprovedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId required" });
  }

  try {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    const influencerIdString = String(influencerId || "").trim();

    const influencerLookup = mongoose.Types.ObjectId.isValid(influencerIdString)
      ? {
        $or: [
          { _id: new mongoose.Types.ObjectId(influencerIdString) },
          { influencerId: influencerIdString },
        ],
      }
      : { influencerId: influencerIdString };

    const influencer = await Influencer.findOne(
      influencerLookup,
      "_id influencerId name email"
    ).lean();

    if (!influencer) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const internalInfluencerId = String(influencer._id);
    const publicInfluencerId = String(influencer.influencerId || influencer._id);

    const possibleInfluencerIds = [
      influencerIdString,
      internalInfluencerId,
      publicInfluencerId,
    ].filter(Boolean);

    const possibleInfluencerObjectIds = possibleInfluencerIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const contracts = await Contract.find(
      {
        $and: [
          {
            $or: [
              { influencerId: { $in: possibleInfluencerIds } },
              { influencerId: { $in: possibleInfluencerObjectIds } },
              { "influencer._id": { $in: possibleInfluencerObjectIds } },
              { "influencer.influencerId": { $in: possibleInfluencerIds } },
            ],
          },
          {
            isRejected: { $ne: 1 },
          },
          {
            status: {
              $nin: [CONTRACT_STATUS.REJECTED, CONTRACT_STATUS.SUPERSEDED],
            },
          },
          {
            $or: [
              { isAssigned: 1 },
              { isAccepted: 1 },
              {
                status: {
                  $in: [
                    CONTRACT_STATUS.BRAND_ACCEPTED,
                    CONTRACT_STATUS.INFLUENCER_ACCEPTED,
                    CONTRACT_STATUS.READY_TO_SIGN,
                    CONTRACT_STATUS.CONTRACT_SIGNED,
                    CONTRACT_STATUS.MILESTONES_CREATED,
                  ],
                },
              },
            ],
          },
          {
            $or: [
              { supersededBy: { $exists: false } },
              { supersededBy: null },
              { supersededBy: "" },
            ],
          },
        ],
      },
      "campaignId contractId isAccepted isAssigned feeAmount status milestonesCreatedAt lastActionAt createdAt"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    if (!contracts.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0,
        },
        campaigns: [],
      });
    }

    const contractByCampaignId = new Map();

    for (const contract of contracts) {
      const campaignId = String(contract.campaignId || "").trim();

      if (!campaignId) continue;

      if (!contractByCampaignId.has(campaignId)) {
        contractByCampaignId.set(campaignId, {
          contractId: contract.contractId || String(contract._id || ""),
          feeAmount: Number(contract.feeAmount || 0),
          isAccepted: contract.isAccepted === 1 ? 1 : 0,
          isAssigned: contract.isAssigned === 1 ? 1 : 0,
          status: contract.status || null,
          milestonesCreatedAt: contract.milestonesCreatedAt || null,
        });
      }
    }

    const campaignIds = Array.from(contractByCampaignId.keys());

    const campaignObjectIds = campaignIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const campaignIdFilter = {
      $or: [
        ...(campaignObjectIds.length
          ? [{ _id: { $in: campaignObjectIds } }]
          : []),
        { campaignId: { $in: campaignIds } },
      ],
    };

    const filter =
      search && String(search).trim()
        ? {
          $and: [
            campaignIdFilter,
            { $or: buildSearchOr(String(search).trim()) },
          ],
        }
        : campaignIdFilter;

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
    ]);

    let enrichedCampaigns = rawCampaigns;

    try {
      enrichedCampaigns = await enrichCampaigns(rawCampaigns);
    } catch (enrichErr) {
      console.warn(
        "[getApprovedCampaignsByInfluencer] enrichCampaigns failed:",
        enrichErr?.message || enrichErr
      );
    }

    const milestoneIds = await milestoneSetForInfluencer(
      publicInfluencerId,
      campaignIds
    );

    const campaigns = enrichedCampaigns.map((campaign) => {
      const campaignObjectId = String(campaign._id || "");
      const campaignLegacyId = String(campaign.campaignId || "");

      const details =
        contractByCampaignId.get(campaignObjectId) ||
        contractByCampaignId.get(campaignLegacyId) ||
        {};

      return {
        ...campaign,

        id: campaignObjectId || campaignLegacyId,
        campaignId: campaignObjectId || campaignLegacyId,

        hasApplied: 1,
        hasApproved: details.isAssigned || 0,
        isApproved: details.isAssigned || 0,
        isContracted: 1,
        isAccepted: details.isAccepted || 0,

        hasMilestone:
          milestoneIds.has(campaignObjectId) ||
            milestoneIds.has(campaignLegacyId) ||
            details.status === CONTRACT_STATUS.MILESTONES_CREATED
            ? 1
            : 0,

        contractId: details.contractId || null,
        feeAmount: details.feeAmount || 0,
        contractStatus: details.status || null,
        milestonesCreatedAt: details.milestonesCreatedAt || null,
      };
    });

    return res.status(200).json({
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
      influencer: {
        _id: internalInfluencerId,
        influencerId: publicInfluencerId,
        name: influencer.name || "",
        email: influencer.email || "",
      },
      campaigns,
    });
  } catch (err) {
    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_APPROVED_CAMPAIGNS_BY_INFLUENCER_ERROR"
    );

    console.error("getApprovedCampaignsByInfluencer error:", err);

    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAppliedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId required" });
  }

  try {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    const influencerIdString = String(influencerId || "").trim();

    const influencerLookup = mongoose.Types.ObjectId.isValid(influencerIdString)
      ? {
        $or: [
          { _id: new mongoose.Types.ObjectId(influencerIdString) },
          { influencerId: influencerIdString },
        ],
      }
      : { influencerId: influencerIdString };

    const inf = await Influencer.findOne(
      influencerLookup,
      "_id influencerId name email"
    ).lean();

    if (!inf) {
      return res.status(404).json({ message: "Influencer not found" });
    }

    const internalInfluencerId = String(inf._id);
    const publicInfluencerId = String(inf.influencerId || inf._id);

    const applyRecs = await ApplyCampaign.find(
      {
        $or: [
          { "applicants.influencerId": internalInfluencerId },
          { "applicants.influencerId": publicInfluencerId },
          { "approved.influencerId": internalInfluencerId },
          { "approved.influencerId": publicInfluencerId },
        ],
      },
      "campaignId applicants approved createdAt updatedAt"
    ).lean();

    let campaignIds = [
      ...new Set(
        applyRecs
          .map((r) => String(r.campaignId || "").trim())
          .filter(Boolean)
      ),
    ];

    if (!campaignIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0,
        },
        influencer: {
          _id: internalInfluencerId,
          influencerId: publicInfluencerId,
          name: inf.name || "",
          email: inf.email || "",
        },
        campaigns: [],
      });
    }

    const campaignObjectIds = campaignIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const contracted = await Contract.find(
      {
        influencerId: { $in: [internalInfluencerId, publicInfluencerId] },
        $and: [
          {
            $or: [
              { campaignId: { $in: campaignIds } },
              ...(campaignObjectIds.length
                ? [{ campaignId: { $in: campaignObjectIds } }]
                : []),
            ],
          },
          {
            $or: [{ isAssigned: 1 }, { isAccepted: 1 }],
          },
        ],
      },
      "campaignId"
    ).lean();

    const excludedIds = new Set(
      contracted.map((c) => String(c.campaignId || "").trim()).filter(Boolean)
    );

    campaignIds = campaignIds.filter((id) => !excludedIds.has(String(id)));

    if (!campaignIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0,
        },
        influencer: {
          _id: internalInfluencerId,
          influencerId: publicInfluencerId,
          name: inf.name || "",
          email: inf.email || "",
        },
        campaigns: [],
      });
    }

    const finalCampaignObjectIds = campaignIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const campaignIdFilter = {
      $or: [
        { campaignId: { $in: campaignIds } },
        ...(finalCampaignObjectIds.length
          ? [{ _id: { $in: finalCampaignObjectIds } }]
          : []),
      ],
    };

    const filter =
      search && String(search).trim()
        ? {
          $and: [
            campaignIdFilter,
            { $or: buildSearchOr(String(search).trim()) },
          ],
        }
        : campaignIdFilter;

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
    ]);

    let enrichedCampaigns = rawCampaigns;

    try {
      enrichedCampaigns = await enrichCampaigns(rawCampaigns);
    } catch (enrichErr) {
      console.warn(
        "[getAppliedCampaignsByInfluencer] enrichCampaigns failed:",
        enrichErr?.message || enrichErr
      );
    }

    const applyByCampaignId = new Map();

    for (const doc of applyRecs) {
      const key = String(doc.campaignId || "").trim();
      if (key && !applyByCampaignId.has(key)) {
        applyByCampaignId.set(key, doc);
      }
    }

    const getCountryName = (country = {}) =>
      String(
        country.countryNameEn ||
        country.countryName ||
        country.name ||
        country.countryNameLocal ||
        country.countryCode ||
        ""
      ).trim();

    const getGoalName = (goal = {}) =>
      String(goal.goal || goal.name || goal.label || "").trim();

    const getAgeRangeName = (age = {}) =>
      String(age.range || age.name || age.label || "").trim();

    const campaigns = enrichedCampaigns.map((campaign) => {
      const campaignId = String(campaign._id || campaign.campaignId || "");

      const related =
        applyByCampaignId.get(String(campaign._id || "")) ||
        applyByCampaignId.get(String(campaign.campaignId || "")) ||
        null;

      const approvedList = Array.isArray(related?.approved)
        ? related.approved
        : [];

      const applicantsList = Array.isArray(related?.applicants)
        ? related.applicants
        : [];

      const isApproved = approvedList.some((item) =>
        [internalInfluencerId, publicInfluencerId].includes(
          String(item.influencerId || "")
        )
      );

      const isApplied = applicantsList.some((item) =>
        [internalInfluencerId, publicInfluencerId].includes(
          String(item.influencerId || "")
        )
      );

      const applicationStatus = isApproved
        ? "approved"
        : isApplied
          ? "applied"
          : "applied";

      const targetCountries = Array.isArray(campaign.details?.targetCountries)
        ? campaign.details.targetCountries
        : [];

      const targetCountryValues = targetCountries
        .map(getCountryName)
        .filter(Boolean);

      const targetCountry =
        targetCountryValues.length > 0
          ? targetCountryValues.join(", ")
          : String(campaign.targetCountry || "").trim();

      const targetAgeGroupValues = Array.isArray(
        campaign.details?.targetAgeRanges
      )
        ? campaign.details.targetAgeRanges.map(getAgeRangeName).filter(Boolean)
        : [];

      const campaignGoalValues = Array.isArray(
        campaign.details?.campaignGoals
      )
        ? campaign.details.campaignGoals.map(getGoalName).filter(Boolean)
        : [];

      return {
        ...campaign,

        id: campaignId,
        campaignId,
        campaignName: campaign.campaignTitle || "",
        name: campaign.campaignTitle || "",
        campaignTitle: campaign.campaignTitle || "",

        influencer: {
          _id: internalInfluencerId,
          influencerId: publicInfluencerId,
          name: inf.name || "",
        },

        images: campaign.productImages || campaign.images || [],

        campaignGoalValues,
        targetCountryValues,
        targetCountries,
        targetCountry,
        targetAgeGroupValues,

        applicationStatus,
        appliedDate: related?.createdAt || campaign.createdAt,

        hasApplied: 1,
        hasApproved: isApproved ? 1 : 0,
        isApproved: isApproved ? 1 : 0,
        isContracted: 0,
        contractId: null,
        contractMongoId: null,
        isAccepted: 0,
        hasMilestone: 0,
        feeAmount: 0,
        contractStatus: null,

        budget: campaign.budget || campaign.campaignBudget || 0,
        campaignBudget: campaign.campaignBudget || campaign.budget || 0,
        influencerBudget: campaign.influencerBudget || 0,

        timeline: {
          startDate: campaign.startAt || campaign.timeline?.startDate || null,
          endDate: campaign.endAt || campaign.timeline?.endDate || null,
          ...(campaign.timeline || {}),
        },
      };
    });

    return res.status(200).json({
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
      influencer: {
        _id: internalInfluencerId,
        influencerId: publicInfluencerId,
        name: inf.name || "",
        email: inf.email || "",
      },
      campaigns,
    });
  } catch (err) {
    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_APPLIED_CAMPAIGNS_BY_INFLUENCER_ERROR"
    );

    console.error("getAppliedCampaignsByInfluencer error:", err);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.getAcceptedCampaigns = async (req, res) => {
  const { brandId, search, page = 1, limit = 10 } = req.body;
  if (!brandId) return res.status(400).json({ message: "brandId required" });

  try {
    const contracts = await Contract.find({
      brandId: String(brandId), isRejected: { $ne: 1 },
      status: { $in: [CONTRACT_STATUS.CONTRACT_SIGNED, CONTRACT_STATUS.MILESTONES_CREATED] },
      $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
    }, "campaignId contractId influencerId feeAmount lastActionAt createdAt status").sort({ lastActionAt: -1, createdAt: -1 }).lean();

    const campaignIds = [...new Set(contracts.map((c) => String(c.campaignId)))];
    if (!campaignIds.length) return res.status(200).json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const contractMap = new Map(); const influencerMap = new Map(); const feeMap = new Map(); const statusMap = new Map(); const signedCountByCampaign = new Map();
    for (const c of contracts) {
      const key = String(c.campaignId);
      if (!contractMap.has(key)) {
        contractMap.set(key, c.contractId || null); influencerMap.set(key, c.influencerId || null);
        feeMap.set(key, Number(c.feeAmount || 0)); statusMap.set(key, c.status || null);
      }
      signedCountByCampaign.set(key, (signedCountByCampaign.get(key) || 0) + 1);
    }

    const filter = { _id: { $in: campaignIds } };
    if (search?.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean(),
    ]);

    return res.json({
      meta: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) },
      campaigns: campaigns.map((camp) => ({
        ...camp, contractId: contractMap.get(String(camp.campaignId)) || null,
        influencerId: influencerMap.get(String(camp.campaignId)) || null, feeAmount: feeMap.get(String(camp.campaignId)) || 0,
        contractStatus: statusMap.get(String(camp.campaignId)) || null, isAccepted: 1,
        totalAcceptedMembers: signedCountByCampaign.get(String(camp._id)) || 0, applicantCount: Math.max(0, (Number(camp.applicantCount) || 0)),
      })),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_ACCEPTED_CAMPAIGNS_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAcceptedInfluencers = async (req, res) => {
  try {
    const source = req.method === "GET" ? req.query : (req.body || {});

    const {
      campaignId,
      search = "",
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      order = "desc",
    } = source;

    if (!campaignId) {
      return res.status(400).json({ message: "campaignId required" });
    }

    const contracts = await Contract.find(
      {
        ...buildContractCampaignFilter(campaignId),
        isRejected: { $ne: 1 },
        status: {
          $in: [
            CONTRACT_STATUS.CONTRACT_SIGNED,
            CONTRACT_STATUS.MILESTONES_CREATED,
          ],
        },
        $or: [
          { supersededBy: { $exists: false } },
          { supersededBy: null },
          { supersededBy: "" },
        ],
      },
      "influencerId contractId feeAmount lastActionAt createdAt updatedAt status"
    )
      .sort({ lastActionAt: -1, createdAt: -1 })
      .lean();

    const influencerIds = contracts.map((c) => String(c.influencerId));
    if (!influencerIds.length) {
      return res.status(200).json({
        meta: {
          total: 0,
          page: Number(page),
          limit: Number(limit),
          totalPages: 0,
        },
        influencers: [],
      });
    }

    const contractMap = new Map();
    const feeMap = new Map();

    for (const c of contracts) {
      const key = String(c.influencerId);
      if (!contractMap.has(key)) {
        contractMap.set(key, c.contractId || null);
        feeMap.set(key, Number(c.feeAmount || 0));
      }
    }

    const filter = {
      influencerId: { $in: Array.from(contractMap.keys()) },
    };

    if (String(search).trim()) {
      filter.$or = [
        { name: new RegExp(String(search).trim(), "i") },
        { handle: new RegExp(String(search).trim(), "i") },
        { email: new RegExp(String(search).trim(), "i") },
      ];
    }

    const sortField =
      {
        createdAt: "createdAt",
        updatedAt: "updatedAt",
        name: "name",
        followerCount: "followerCount",
        feeAmount: "feeAmount",
      }[sortBy] || "createdAt";

    const sortDir = String(order).toLowerCase() === "asc" ? 1 : -1;
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    const [total, rawInfluencers] = await Promise.all([
      Influencer.countDocuments(filter),
      Influencer.find(filter)
        .sort(sortField === "feeAmount" ? {} : { [sortField]: sortDir })
        .skip(skip)
        .limit(safeLimit)
        .select("-passwordHash -__v")
        .lean(),
    ]);

    if (!rawInfluencers.length) {
      return res.json({
        meta: {
          total: 0,
          page: safePage,
          limit: safeLimit,
          totalPages: 0,
        },
        influencers: [],
      });
    }

    const modashProfiles = await Modash.find(
      {
        influencerId: {
          $in: rawInfluencers.map((i) => String(i.influencerId)),
        },
      },
      "influencerId username handle followers provider"
    ).lean();

    const modashByInfluencerId = new Map();
    for (const m of modashProfiles) {
      const key = String(m.influencerId);
      if (!modashByInfluencerId.has(key)) {
        modashByInfluencerId.set(key, []);
      }
      modashByInfluencerId.get(key).push(m);
    }

    function pickPrimaryProfile(influencerDoc, profilesForInfluencer) {
      if (!profilesForInfluencer?.length) return null;

      const primaryPlatform = String(
        influencerDoc.primaryPlatform || ""
      ).toLowerCase();

      if (["youtube", "instagram", "tiktok"].includes(primaryPlatform)) {
        const direct = profilesForInfluencer.find(
          (p) => String(p.provider || "").toLowerCase() === primaryPlatform
        );
        if (direct) return direct;
      }

      return profilesForInfluencer.reduce((best, current) =>
        Number(current?.followers || 0) > Number(best?.followers || 0)
          ? current
          : best
      );
    }

    let influencers = rawInfluencers.map((inf) => {
      const key = String(inf.influencerId);
      const primaryProfile = pickPrimaryProfile(
        inf,
        modashByInfluencerId.get(key) || []
      );

      return {
        ...inf,
        contractId: contractMap.get(key) || null,
        feeAmount: feeMap.get(key) || 0,
        isAccepted: 1,
        socialHandle:
          (primaryProfile &&
            (primaryProfile.username || primaryProfile.handle)) ||
          inf.handle ||
          null,
        audienceSize:
          primaryProfile && typeof primaryProfile.followers === "number"
            ? primaryProfile.followers
            : typeof inf.followerCount === "number"
              ? inf.followerCount
              : 0,
        primaryPlatform: inf.primaryPlatform || null,
        primaryProvider: primaryProfile ? primaryProfile.provider : null,
      };
    });

    if (sortField === "feeAmount") {
      influencers.sort((a, b) =>
        sortDir === 1 ? a.feeAmount - b.feeAmount : b.feeAmount - a.feeAmount
      );
    }

    return res.json({
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
      influencers,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_ACCEPTED_INFLUENCERS_ERROR");
    console.error("getAcceptedInfluencers error:", err);
    return res.status(500).json({
      message: err.message || "Internal server error",
    });
  }
};

exports.getContractedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search, page = 1, limit = 10 } = req.body;
  if (!influencerId) return res.status(400).json({ message: "influencerId is required" });

  try {
    const contracts = await Contract.find({
      influencerId: String(influencerId), isRejected: { $ne: 1 },
      status: { $in: [CONTRACT_STATUS.BRAND_SENT_DRAFT, CONTRACT_STATUS.BRAND_EDITED, CONTRACT_STATUS.INFLUENCER_EDITED, CONTRACT_STATUS.BRAND_ACCEPTED, CONTRACT_STATUS.INFLUENCER_ACCEPTED, CONTRACT_STATUS.READY_TO_SIGN, CONTRACT_STATUS.CONTRACT_SIGNED, "sent", "viewed", "negotiation", "finalize", "signing", "locked"] },
      $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: "" }],
    }, "campaignId contractId feeAmount isAccepted status lastActionAt createdAt").sort({ lastActionAt: -1, createdAt: -1 }).lean();

    if (!contracts.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const contractByCampaignId = new Map();
    for (const c of contracts) if (String(c.campaignId || "") && !contractByCampaignId.has(String(c.campaignId || ""))) contractByCampaignId.set(String(c.campaignId || ""), { contractId: c.contractId || null, feeAmount: Number(c.feeAmount || 0), isAccepted: c.isAccepted === 1 ? 1 : 0, status: c.status || null, campaignIdRaw: c.campaignId });

    let candidateCampaignIds = Array.from(contractByCampaignId.keys());
    if (!candidateCampaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const idsObj = candidateCampaignIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
    const milestoneDocs = await Milestone.find({ milestoneHistory: { $elemMatch: { influencerId: String(influencerId), campaignId: { $in: [...candidateCampaignIds, ...idsObj] } } } }, "milestoneHistory.campaignId milestoneHistory.influencerId").lean();

    const milestoneCampaignSet = new Set();
    for (const d of milestoneDocs) for (const h of d.milestoneHistory || []) if (String(h.influencerId) === String(influencerId)) milestoneCampaignSet.add(String(h.campaignId));

    for (const [campId, details] of contractByCampaignId.entries()) {
      if (details?.status === CONTRACT_STATUS.MILESTONES_CREATED || (milestoneCampaignSet.has(String(campId)) && details?.status === CONTRACT_STATUS.CONTRACT_SIGNED)) contractByCampaignId.delete(campId);
    }

    candidateCampaignIds = Array.from(contractByCampaignId.keys());
    if (!candidateCampaignIds.length) return res.json({ meta: { total: 0, page: +page, limit: +limit, totalPages: 0 }, campaigns: [] });

    const uuidIds = [];
    const oIds = [];

    for (const id of candidateCampaignIds) {
      const idStr = String(id || "").trim();

      if (!idStr) continue;

      uuidIds.push(idStr);

      if (
        mongoose.Types.ObjectId.isValid(idStr) &&
        String(new mongoose.Types.ObjectId(idStr)) === idStr
      ) {
        oIds.push(new mongoose.Types.ObjectId(idStr));
      }
    }

    const baseFilter = {
      $or: [
        ...(oIds.length ? [{ _id: { $in: oIds } }] : []),
        ...(uuidIds.length ? [{ campaignId: { $in: uuidIds } }] : []),
      ],
    };

    const filter =
      search && String(search).trim()
        ? {
          $and: [
            baseFilter,
            { $or: buildSearchOr(String(search).trim()) },
          ],
        }
        : baseFilter;

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    const [total, rawCampaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),
    ]);

    let enrichedCampaigns = rawCampaigns;

    try {
      enrichedCampaigns = await enrichCampaigns(rawCampaigns);
    } catch (enrichErr) {
      console.warn(
        "[getContractedCampaignsByInfluencer] enrichCampaigns failed:",
        enrichErr?.message || enrichErr
      );
    }

    return res.json({
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
      campaigns: enrichedCampaigns.map((c) => {
        const details =
          contractByCampaignId.get(String(c._id || "")) ||
          contractByCampaignId.get(String(c.campaignId || "")) ||
          {};

        const targetCountries = Array.isArray(c.details?.targetCountries)
          ? c.details.targetCountries
          : [];

        const targetCountry = targetCountries
          .map((country) =>
            String(
              country.countryNameEn ||
              country.countryName ||
              country.name ||
              country.countryNameLocal ||
              ""
            ).trim()
          )
          .filter(Boolean)
          .join(", ");

        return {
          ...c,

          // useful for frontend
          targetCountry,
          targetCountries,

          hasApplied: 1,
          isContracted: 1,
          isAccepted: details.isAccepted || 0,
          hasMilestone:
            milestoneCampaignSet.has(String(c._id || "")) ||
              milestoneCampaignSet.has(String(c.campaignId || ""))
              ? 1
              : 0,
          contractId: details.contractId ?? null,
          feeAmount: details.feeAmount ?? 0,
          contractStatus: details.status ?? null,
        };
      }),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_CONTRACTED_CAMPAIGNS_BY_INFLUENCER_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getCampaignsByFilter = async (req, res) => {
  try {
    const { subcategoryIds = [], categoryIds = [], gender, minAge, maxAge, ageMode = 'containment', countryId, goal, minBudget, maxBudget, search = '', page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = req.body;
    const filter = addInfluencerOpenStatusGate({ isActive: 1, isDraft: { $ne: 1 } }); // hide drafts

    if (Array.isArray(subcategoryIds) && subcategoryIds.length) filter['categories.subcategoryId'] = { $in: subcategoryIds.map(String) };
    if (Array.isArray(categoryIds) && categoryIds.length) {
      const maybeObjIds = categoryIds.filter(
        (v) => typeof v === "string" && mongoose.Types.ObjectId.isValid(v)
      );

      if (maybeObjIds.length) {
        filter["categoryId"] = { $in: maybeObjIds.map((id) => new mongoose.Types.ObjectId(id)) };
      }
    }

    if ([0, 1].includes(Number(gender))) filter['targetAudience.gender'] = Number(gender);
    const minA = Number(minAge); const maxA = Number(maxAge);
    if (!isNaN(minA) || !isNaN(maxA)) {
      if (ageMode === 'containment') {
        if (!isNaN(minA)) filter['targetAudience.age.MinAge'] = { $gte: minA };
        if (!isNaN(maxA)) filter['targetAudience.age.MaxAge'] = { $lte: maxA };
      } else {
        if (!isNaN(maxA)) filter['targetAudience.age.MinAge'] = { $lte: maxA };
        if (!isNaN(minA)) filter['targetAudience.age.MaxAge'] = { $gte: minA };
      }
    }

    if (Array.isArray(countryId) && countryId.length) {
      const validIds = countryId.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
      if (validIds.length) filter['targetAudience.locations'] = { $elemMatch: { countryId: { $in: validIds } } };
    } else if (countryId && mongoose.Types.ObjectId.isValid(countryId)) {
      filter['targetAudience.locations'] = { $elemMatch: { countryId: new mongoose.Types.ObjectId(countryId) } };
    }

    if (goal && ['Brand Awareness', 'Sales', 'Engagement'].includes(goal)) filter.goal = goal;
    const minB = Number(minBudget); const maxB = Number(maxBudget);
    if (!isNaN(minB) || !isNaN(maxB)) {
      filter.budget = {};
      if (!isNaN(minB)) filter.budget.$gte = minB;
      if (!isNaN(maxB)) filter.budget.$lte = maxB;
    }
    if (typeof search === 'string' && search.trim()) filter.$or = buildSearchOr(search.trim());

    const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const sortObj = { [['createdAt', 'budget', 'goal', 'brandName'].includes(sortBy) ? sortBy : 'createdAt']: sortOrder === 'asc' ? 1 : -1 };

    const [total, campaigns] = await Promise.all([Campaign.countDocuments(filter), Campaign.find(filter).sort(sortObj).skip(skip).limit(Math.max(1, parseInt(limit, 10))).lean()]);
    return res.json({ data: campaigns, pagination: { total, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(total / Math.max(1, parseInt(limit, 10))) } });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_CAMPAIGNS_BY_FILTER_ERROR");
    return res.status(500).json({ message: 'Internal server error while filtering campaigns.' });
  }
};

exports.getRejectedCampaignsByInfluencer = async (req, res) => {
  const { influencerId, search = '', page = 1, limit = 10 } = req.body || {};
  if (!influencerId) return res.status(400).json({ message: 'influencerId is required' });

  try {
    const candidates = await Contract.find({ influencerId: String(influencerId), $or: [{ status: 'rejected' }, { isRejected: 1 }], $and: [{ $or: [{ supersededBy: { $exists: false } }, { supersededBy: null }, { supersededBy: '' }] }] }, 'contractId campaignId feeAmount createdAt audit supersededBy').lean();
    if (!candidates.length) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const children = await Contract.find({ resendOf: { $in: candidates.map(c => String(c.contractId)) } }, 'resendOf').lean();
    const parentsWithChildren = new Set(children.map(ch => String(ch.resendOf)));
    const finalRejected = candidates.filter(c => !parentsWithChildren.has(String(c.contractId)));
    if (!finalRejected.length) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, campaigns: [] });

    const latestByCampaign = new Map();
    for (const c of finalRejected) {
      const key = String(c.campaignId);
      const prev = latestByCampaign.get(key);
      if (!prev || new Date(c.createdAt) > new Date(prev.createdAt)) latestByCampaign.set(key, c);
    }

    const campFilter = { campaignId: { $in: Array.from(latestByCampaign.keys()) } };
    if (typeof search === 'string' && search.trim()) campFilter.$or = buildSearchOr(search.trim());

    const allMatched = await Campaign.find(campFilter).sort({ createdAt: -1 }).lean();
    const start = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    const slice = allMatched.slice(start, start + Math.max(1, parseInt(limit, 10)));

    return res.json({
      meta: { total: allMatched.length, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(allMatched.length / Math.max(1, parseInt(limit, 10))) },
      campaigns: slice.map((camp) => {
        const parent = latestByCampaign.get(String(camp.campaignId)) || {};
        let rejectedAt = parent.createdAt || null; let reason = '';
        if (Array.isArray(parent.audit)) {
          const rejEvents = parent.audit.filter(e => e?.type === 'REJECTED');
          if (rejEvents.length) {
            rejEvents.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
            rejectedAt = rejEvents[rejEvents.length - 1].at || rejectedAt;
            reason = (rejEvents[rejEvents.length - 1].details && rejEvents[rejEvents.length - 1].details.reason) || '';
          }
        }
        return { ...camp, hasApplied: 1, isContracted: 0, isAccepted: 0, isRejected: 1, contractId: parent.contractId || null, feeAmount: Number(parent.feeAmount || 0), rejectedAt, rejectionReason: reason };
      })
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_REJECTED_CAMPAIGNS_BY_INFLUENCER_ERROR");
    return res.status(500).json({ message: 'Internal server error while fetching rejected campaigns.' });
  }
};

exports.getCampaignSummary = async (req, res) => {
  try {
    const campaignId = req.query.id || req.params?.id;
    if (!campaignId) return res.status(400).json({ message: "Query parameter id is required." });
    if (!isOid(campaignId)) {
      return res.status(400).json({ message: "Valid campaign id is required." });
    }

    const campaign = await Campaign.findById(campaignId, "campaignTitle campaignBudget budget timeline paymentType").lean();
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });

    return res.json({
      campaignName: campaign.campaignTitle,
      budget: campaign.campaignBudget ?? campaign.budget ?? 0,
      timeline: campaign.timeline || {},
      paymentType: campaign.paymentType
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_CAMPAIGN_SUMMARY_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getDraftCampaignByBrand = async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId || !isOid(brandId)) return res.status(400).json({ message: "brandId is required as a query param." });
    const draft = await Campaign.findOne({ brandId: toObjectId(brandId), isDraft: 1 }).sort({ updatedAt: -1 }).lean();
    if (!draft) return res.status(201).json({ message: "No draft found for this brand." });
    return res.status(200).json(draft);
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_DRAFT_CAMPAIGN_BY_BRAND_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};


exports.getCampaignHistoryByBrand = async (req, res) => {
  try {
    const {
      brandId,
      page = 1,
      limit = 10,
      search = "",
      sortBy = "createdAt",
      sortOrder = "desc",
      includeDescription = 1,

      campaignStatus,
      timelineState,
      goal,
      minBudget,
      maxBudget,

      campaignType,
      creatorStatus,
      categoryIds,
      aiCreated,

      quickFilter,
      allDatesOption,
      startDate,
      endDate,
    } = req.body || {};

    if (!brandId) {
      return res.status(400).json({ message: "brandId is required." });
    }

    const filter = {
      brandId,
      isDraft: { $ne: 1 },
    };

    const andClauses = [];

    if (search && String(search).trim()) {
      andClauses.push({
        $or: buildSearchOr(String(search).trim()),
      });
    }

    if (
      campaignStatus &&
      ["open", "paused"].includes(String(campaignStatus).toLowerCase().trim())
    ) {
      filter.campaignStatus = String(campaignStatus).toLowerCase().trim();
    }

    if (goal) {
      filter.goal = String(goal);
    }

    if (campaignType && String(campaignType).trim() && String(campaignType) !== "all") {
      andClauses.push({
        $or: [
          { campaignType: String(campaignType).trim() },
          { type: String(campaignType).trim() },
        ],
      });
    }

    if (Array.isArray(categoryIds) && categoryIds.length > 0) {
      const cleanCategoryIds = categoryIds.map(String).filter(Boolean);

      andClauses.push({
        $or: [
          { categoryId: { $in: cleanCategoryIds } },
          { campaignCategoryId: { $in: cleanCategoryIds } },
          { "categories.categoryId": { $in: cleanCategoryIds } },
          { "categories._id": { $in: cleanCategoryIds } },
        ],
      });
    }

    if (aiCreated === true || aiCreated === 1 || aiCreated === "true") {
      andClauses.push({
        $or: [
          { aiCreated: true },
          { isAiCreated: true },
          { createdByAI: true },
        ],
      });
    }

    if (minBudget !== undefined || maxBudget !== undefined) {
      filter.budget = {};

      if (
        minBudget !== undefined &&
        minBudget !== null &&
        String(minBudget).trim() !== "" &&
        Number.isFinite(Number(minBudget))
      ) {
        filter.budget.$gte = Number(minBudget);
      }

      if (
        maxBudget !== undefined &&
        maxBudget !== null &&
        String(maxBudget).trim() !== "" &&
        Number.isFinite(Number(maxBudget))
      ) {
        filter.budget.$lte = Number(maxBudget);
      }

      if (!Object.keys(filter.budget).length) {
        delete filter.budget;
      }
    }

    const now = new Date();

    function startOfDayUTC(date) {
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    }

    function endOfDayUTC(date) {
      return new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999)
      );
    }

    function addDaysUTC(date, days) {
      const d = new Date(date);
      d.setUTCDate(d.getUTCDate() + days);
      return d;
    }

    function startOfWeekUTC(date) {
      const d = startOfDayUTC(date);
      const day = d.getUTCDay();
      const diff = day === 0 ? -6 : 1 - day;
      return addDaysUTC(d, diff);
    }

    function endOfWeekUTC(date) {
      return endOfDayUTC(addDaysUTC(startOfWeekUTC(date), 6));
    }

    function startOfMonthUTC(date) {
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    }

    function endOfMonthUTC(date) {
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    }

    function parseDateInput(v, endOfDay = false) {
      if (!v) return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return null;
      return endOfDay ? endOfDayUTC(d) : startOfDayUTC(d);
    }

    const startOfToday = startOfDayUTC(now);

    if (timelineState) {
      const state = String(timelineState).toLowerCase().trim();

      if (state === "none") {
        andClauses.push({
          $and: [
            {
              $or: [
                { "timeline.startDate": { $exists: false } },
                { "timeline.startDate": null },
              ],
            },
            {
              $or: [
                { "timeline.endDate": { $exists: false } },
                { "timeline.endDate": null },
              ],
            },
          ],
        });
      } else if (state === "expired") {
        andClauses.push({
          "timeline.endDate": { $exists: true, $ne: null, $lt: startOfToday },
        });
      } else if (state === "running") {
        andClauses.push({
          $and: [
            {
              $or: [
                { "timeline.startDate": { $exists: true, $ne: null } },
                { "timeline.endDate": { $exists: true, $ne: null } },
              ],
            },
            {
              $or: [
                { "timeline.endDate": { $exists: false } },
                { "timeline.endDate": null },
                { "timeline.endDate": { $gte: startOfToday } },
              ],
            },
          ],
        });
      }
    }

    if (quickFilter) {
      const qf = String(quickFilter).trim();

      if (qf === "recently_edited") {
        andClauses.push({
          updatedAt: { $gte: addDaysUTC(startOfToday, -7) },
        });
      } else if (qf === "launching_soon") {
        andClauses.push({
          "timeline.startDate": {
            $gte: startOfToday,
            $lte: endOfDayUTC(addDaysUTC(startOfToday, 14)),
          },
        });
      } else if (qf === "today") {
        andClauses.push({
          createdAt: {
            $gte: startOfToday,
            $lte: endOfDayUTC(startOfToday),
          },
        });
      } else if (qf === "this_week") {
        andClauses.push({
          createdAt: {
            $gte: startOfWeekUTC(now),
            $lte: endOfWeekUTC(now),
          },
        });
      } else if (qf === "this_month") {
        andClauses.push({
          createdAt: {
            $gte: startOfMonthUTC(now),
            $lte: endOfMonthUTC(now),
          },
        });
      }
    } else if (allDatesOption && String(allDatesOption) !== "all") {
      let rangeStart = null;
      let rangeEnd = endOfDayUTC(now);
      const opt = String(allDatesOption).trim();

      if (opt === "last_7") rangeStart = addDaysUTC(startOfToday, -7);
      if (opt === "last_15") rangeStart = addDaysUTC(startOfToday, -15);
      if (opt === "last_30") rangeStart = addDaysUTC(startOfToday, -30);
      if (opt === "last_90") rangeStart = addDaysUTC(startOfToday, -90);
      if (opt === "last_365") rangeStart = addDaysUTC(startOfToday, -365);

      if (opt === "last_month") {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        rangeStart = startOfMonthUTC(d);
        rangeEnd = endOfMonthUTC(d);
      }

      if (opt === "last_quarter") {
        const currentQuarter = Math.floor(now.getUTCMonth() / 3);
        const lastQuarterEndMonth = currentQuarter * 3 - 1;
        const year = lastQuarterEndMonth < 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
        const normalizedEndMonth = lastQuarterEndMonth < 0 ? 11 : lastQuarterEndMonth;
        const startMonth = normalizedEndMonth - 2;

        rangeStart = new Date(Date.UTC(year, startMonth, 1));
        rangeEnd = new Date(Date.UTC(year, normalizedEndMonth + 1, 0, 23, 59, 59, 999));
      }

      if (rangeStart && rangeEnd) {
        andClauses.push({
          createdAt: {
            $gte: rangeStart,
            $lte: rangeEnd,
          },
        });
      }
    } else if (startDate || endDate) {
      const range = {};
      const parsedStart = parseDateInput(startDate, false);
      const parsedEnd = parseDateInput(endDate, true);

      if (parsedStart) range.$gte = parsedStart;
      if (parsedEnd) range.$lte = parsedEnd;

      if (Object.keys(range).length) {
        andClauses.push({
          createdAt: range,
        });
      }
    }

    if (creatorStatus && String(creatorStatus).trim() && String(creatorStatus) !== "all") {
      const cs = String(creatorStatus).trim().toLowerCase();

      let contractFilter = { brandId };

      if (cs === "invited") {
        contractFilter = {
          ...contractFilter,
          $or: [
            { status: "invited" },
            { creatorStatus: "invited" },
            { applicationStatus: "invited" },
          ],
        };
      } else if (cs === "applied") {
        contractFilter = {
          ...contractFilter,
          $or: [
            { status: "applied" },
            { creatorStatus: "applied" },
            { applicationStatus: "applied" },
          ],
        };
      } else if (cs === "approved") {
        contractFilter = {
          ...contractFilter,
          $or: [
            { status: "approved" },
            { status: "accepted" },
            { creatorStatus: "approved" },
            { applicationStatus: "approved" },
            activeAcceptedFilter(),
          ],
        };
      }

      const matchedCampaignIds = await Contract.distinct("campaignId", contractFilter);
      const cleanMatchedCampaignIds = matchedCampaignIds.map(String).filter(Boolean);

      if (!cleanMatchedCampaignIds.length) {
        return res.json({
          data: [],
          pagination: {
            total: 0,
            page: Math.max(parseInt(page, 10) || 1, 1),
            limit: Math.max(parseInt(limit, 10) || 10, 1),
            totalPages: 0,
          },
        });
      }

      filter.$expr = {
        $in: [{ $toString: "$_id" }, cleanMatchedCampaignIds],
      };
    }

    if (andClauses.length) {
      filter.$and = andClauses;
    }

    const sortFieldMap = {
      createdAt: "createdAt",
      budget: "budget",
      applicantCount: "applicantCount",
      campaignStatus: "campaignStatus",
      statusUpdatedAt: "statusUpdatedAt",
      productOrServiceName: "productOrServiceName",
      isActive: "isActive",
    };

    const sortObj = {
      [sortFieldMap[sortBy] || "createdAt"]:
        String(sortOrder).toLowerCase() === "asc" ? 1 : -1,
    };

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.max(parseInt(limit, 10) || 10, 1);
    const skip = (safePage - 1) * safeLimit;

    const [rows, total] = await Promise.all([
      Campaign.find(
        filter,
        Number(includeDescription) === 1 ? undefined : "-description"
      )
        .sort(sortObj)
        .skip(skip)
        .limit(safeLimit)
        .lean(),

      Campaign.countDocuments(filter),
    ]);

    const workingIds = await Contract.distinct("campaignId", {
      brandId,
      campaignId: { $in: rows.map((c) => String(c._id)) },
      ...activeAcceptedFilter(),
    });

    const workingSet = new Set(workingIds.map(String));

    return res.json({
      data: rows.map((c) => {
        const tl = c.timeline || {};
        const state =
          !tl.startDate && !tl.endDate
            ? "none"
            : tl.endDate && new Date(tl.endDate) < startOfToday
              ? "expired"
              : "running";

        return {
          ...c,
          computedIsActive: computeIsActive(c.timeline),
          timelineState: state,
          hasTimeline: state !== "none",
          influencerWorking:
            workingSet.has(String(c._id)) || workingSet.has(String(String(c._id) || "")),
        };
      }),
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_CAMPAIGN_HISTORY_BY_BRAND_ERROR");
    console.error("getCampaignHistoryByBrand error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};


exports.listApplicants = async (req, res) => {
  const { campaignId, page = 1, limit = 10, search = "", sortField = "createdAt", sortOrder = 1, audienceBucket = "all" } = req.body || {};
  if (!campaignId) return res.status(400).json({ message: "campaignId is required" });

  try {
    const record = await ApplyCampaign.findOne({ campaignId }).lean();
    const influencerIds = (record?.applicants || []).map((a) => a?.influencerId).filter(Boolean).map(String);
    if (!influencerIds.length) return res.json({ meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 }, applicantCount: 0, influencers: [] });

    const [influencersRaw, modashProfiles, contracts, milestoneDocs] = await Promise.all([
      Influencer.find({ influencerId: { $in: influencerIds } }, "influencerId name primaryPlatform onboarding.categoryName onboarding.subcategories").lean(),
      Modash.find({ influencerId: { $in: influencerIds } }, "influencerId provider handle username fullname followers").lean(),
      Contract.find({ campaignId: String(campaignId), influencerId: { $in: influencerIds } }, "influencerId contractId feeAmount isAccepted isAssigned isRejected rejectedReason status").lean(),
      Milestone.find({ milestoneHistory: { $elemMatch: { campaignId: String(campaignId), influencerId: { $in: influencerIds } } } }, "milestoneHistory").lean()
    ]);

    const modashByInf = new Map();
    for (const p of modashProfiles) if (String(p.influencerId || "")) { if (!modashByInf.has(String(p.influencerId))) modashByInf.set(String(p.influencerId), []); modashByInf.get(String(p.influencerId)).push(p); }

    const contractByInf = new Map(contracts.map((c) => [String(c.influencerId), c]));
    const milestoneInfSet = new Set();
    for (const doc of milestoneDocs) for (const h of doc.milestoneHistory || []) if (String(h.campaignId) === String(campaignId)) milestoneInfSet.add(String(h.influencerId));

    let rows = (influencersRaw || []).map((inf) => {
      const infId = String(inf.influencerId);
      const profiles = modashByInf.get(infId) || [];
      const chosen = profiles.find((p) => String(p.provider).toLowerCase() === String(inf.primaryPlatform).toLowerCase()) || profiles.slice().sort((a, b) => (Number(b.followers) || 0) - (Number(a.followers) || 0))[0] || null;
      let handle = (chosen && (chosen.handle || chosen.username || chosen.fullname || "").trim()) || null;
      if (handle && !handle.startsWith("@")) handle = "@" + handle;
      const c = contractByInf.get(infId);
      const isRejected = c?.isRejected === 1 ? 1 : 0;
      return {
        _id: inf._id || "", influencerId: infId, name: inf.name || "", handle, categoryName: inf?.onboarding?.categoryName || "—",
        audienceSize: profiles.reduce((sum, p) => sum + (Number(p?.followers) || 0), 0), createdAt: record.createdAt || record._id?.getTimestamp?.() || null,
        isRejected, rejectedReason: c?.rejectedReason || null, isAssigned: isRejected ? 0 : (c?.isAssigned === 1 ? 1 : 0), isAccepted: isRejected ? 0 : (c?.isAccepted === 1 ? 1 : 0),
        isContracted: c ? 1 : 0, contractId: c?.contractId || null, hasMilestone: milestoneInfSet.has(infId) ? 1 : 0,
      };
    });

    const term = String(search || "").trim().toLowerCase();
    if (term) rows = rows.filter((r) => String(r.name || "").toLowerCase().includes(term) || String(r.handle || "").toLowerCase().includes(term) || String(r.categoryName || "").toLowerCase().includes(term));
    if (audienceBucket === "k") rows = rows.filter((r) => Number(r.audienceSize) >= 1000 && Number(r.audienceSize) < 1_000_000);
    else if (audienceBucket === "m") rows = rows.filter((r) => Number(r.audienceSize) >= 1_000_000);

    const dir = sortOrder === 1 ? -1 : 1;
    if (new Set(["name", "handle", "categoryName", "audienceSize", "createdAt"]).has(sortField)) {
      rows.sort((a, b) => {
        if (sortField === "createdAt") return dir * ((a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0));
        if (sortField === "audienceSize") return dir * ((Number(a.audienceSize) || 0) - (Number(b.audienceSize) || 0));
        return dir * String(a[sortField] ?? "").localeCompare(String(b[sortField] ?? ""));
      });
    }

    const start = (Math.max(1, parseInt(page, 10)) - 1) * Math.max(1, parseInt(limit, 10));
    return res.json({ meta: { total: rows.length, page: Math.max(1, parseInt(page, 10)), limit: Math.max(1, parseInt(limit, 10)), totalPages: Math.ceil(rows.length / Math.max(1, parseInt(limit, 10))) }, applicantCount: record.applicants?.length || 0, influencers: rows.slice(start, start + Math.max(1, parseInt(limit, 10))) });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "LIST_APPLICANTS_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.approveCampaignPendingUpdate = async (req, res) => {
  try {
    const actor = await resolveActorFromPayload(req);
    if (actor.role !== "admin") return res.status(403).json({ message: "Forbidden" });

    const campaignId = clean(req.query.id);
    if (!campaignId || !isOid(campaignId)) {
      return res.status(400).json({ message: "Valid campaign id is required." });
    }

    const campaign = await Campaign.findById(campaignId);
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });

    if (campaign.pendingUpdate?.status !== "pending" || !campaign.pendingUpdate?.patch) {
      return res.status(400).json({ message: "No pending update to approve." });
    }
    const reviewer = await resolveAdminActor(req);
    Object.assign(campaign, campaign.pendingUpdate.patch);
    campaign.pendingUpdate = {
      status: "approved",
      patch: null,
      updatedBy: campaign.pendingUpdate.updatedBy,
      updatedAt: campaign.pendingUpdate.updatedAt,
      reviewedBy: reviewer,
      reviewedAt: new Date(),
      reviewNote: String(req.body?.note || ""),
    };
    await campaign.save();
    await notifyBrandApproved(campaign);

    return res.json({ message: "Approved and published.", campaign });
  } catch (e) {
    await saveErrorLog(req, e, e?.statusCode || e?.status || 500, "APPROVE_CAMPAIGN_PENDING_UPDATE_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.rejectCampaignPendingUpdate = async (req, res) => {
  try {
    if (!isAdminRequest(req)) return res.status(403).json({ message: "Forbidden" });

    const note = String(req.body?.note || "Rejected");
    const campaignId = clean(req.query.id);
    if (!campaignId || !isOid(campaignId)) {
      return res.status(400).json({ message: "Valid campaign id is required." });
    }

    const campaign = await Campaign.findById(campaignId);
    if (!campaign) return res.status(404).json({ message: "Campaign not found." });

    if (campaign.pendingUpdate?.status !== "pending") return res.status(400).json({ message: "No pending update to reject." });
    const reviewer = await resolveAdminActor(req);
    campaign.pendingUpdate = {
      status: "rejected",
      patch: null,
      updatedBy: campaign.pendingUpdate.updatedBy,
      updatedAt: campaign.pendingUpdate.updatedAt,
      reviewedBy: reviewer,
      reviewedAt: new Date(),
      reviewNote: note,
    };
    await campaign.save();
    await notifyBrandRejected(campaign, note);

    return res.json({ message: "Rejected.", campaign });
  } catch (e) {
    await saveErrorLog(req, e, e?.statusCode || e?.status || 500, "REJECT_CAMPAIGN_PENDING_UPDATE_ERROR");
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.getAdminCampaigns = async (req, res) => {
  try {
    const { brandId } = req.params;

    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const skip = (page - 1) * limit;

    const includeDrafts = String(req.query.includeDrafts || "0") === "1";

    const filter = {
      ...(brandId && isOid(brandId) ? { brandId: toObjectId(brandId) } : {}),
      $or: [
        { "createdBy.role": "admin" },
        { "createdBy.role": { $regex: /^admin$/i } },
        { approvalMode: "admin_review" },
      ],
      ...(includeDrafts ? {} : { isDraft: { $ne: 1 } }),
    };

    const [data, total] = await Promise.all([
      Campaign.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Campaign.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_ADMIN_CAMPAIGNS_ERROR");
    return res.status(500).json({
      success: false,
      message: err.message || "Server error",
    });
  }
};



exports.getCategories = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const search = clean(req.query.search);
    const filter = {};

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      filter.$or = [
        { name: regex },
        { globalTags: regex },
        { "subcategories.name": regex },
        { "subcategories.tags": regex },
      ];
    }

    const data = await Category.find(filter).sort({ name: 1 }).lean();

    return ApiResponse.sendOk(res, HttpStatus.OK, data, requestId);
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_CATEGORIES_ERROR");
    return sendControllerError(res, requestId, err);
  }
};


exports.getSubcategories = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const categoryId = clean(req.query.categoryId);
    const search = clean(req.query.search);
    const rx = search ? new RegExp(escapeRegex(search), "i") : null;

    const normalizeTags = (obj) => {
      const t = obj?.tag ?? obj?.tags ?? [];
      return Array.isArray(t) ? t : t ? [t] : [];
    };

    const normalizeGlobalTags = (cat) => {
      const gt = cat?.globalTags ?? cat?.tags ?? [];
      return Array.isArray(gt) ? gt : gt ? [gt] : [];
    };

    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "categoryId",
          requestId,
          "Invalid categoryId"
        );
      }

      const cat = await Category.findById(categoryId)
        .select("_id name subcategories globalTags tags")
        .lean();

      if (!cat) {
        return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Category not found", requestId);
      }

      const subs = cat.subcategories ?? [];
      const filtered = rx ? subs.filter((s) => rx.test(String(s.name ?? ""))) : subs;

      const globalTags = normalizeGlobalTags(cat);

      const data = filtered
        .map((s) => ({
          _id: s._id,
          name: s.name,
          tags: normalizeTags(s),
          globalTags,
          categoryId: cat._id,
          categoryName: cat.name,
        }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));

      return ApiResponse.sendOk(res, HttpStatus.OK, data, requestId);
    }

    const pipeline = [{ $unwind: "$subcategories" }];

    if (rx) {
      pipeline.push({ $match: { "subcategories.name": { $regex: rx } } });
    }

    pipeline.push(
      {
        $project: {
          _id: "$subcategories._id",
          name: "$subcategories.name",
          tags: { $ifNull: ["$subcategories.tag", "$subcategories.tags"] },
          globalTags: { $ifNull: ["$globalTags", "$tags"] },
          categoryId: "$_id",
          categoryName: "$name",
        },
      },
      { $sort: { name: 1 } },
      { $limit: 1000 }
    );

    const data = await Category.aggregate(pipeline);
    return ApiResponse.sendOk(res, HttpStatus.OK, data, requestId);
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_SUBCATEGORIES_ERROR");
    return sendControllerError(res, requestId, err);
  }
};


exports.viewCampaignByIdForBrand = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const user = req.user || {};

    const tokenBrandRaw = String(
      user.brandId || user.id || user._id || user.userId || ""
    ).trim();

    if (!tokenBrandRaw) {
      return fail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Invalid brand token",
        requestId
      );
    }

    const tokenBrandDoc = await findBrandDocByAnyId(tokenBrandRaw);

    if (!tokenBrandDoc) {
      return fail(
        res,
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Brand not found from token",
        requestId
      );
    }

    const campaignId = clean(req.body.campaignId);

    if (!campaignId || !isOid(campaignId)) {
      return fail(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "Valid campaignId is required",
        requestId
      );
    }

    const filter = buildCampaignLookupFilter(campaignId, tokenBrandDoc._id);

    if (!filter) {
      return fail(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "Valid campaignId is required",
        requestId
      );
    }

    const campaign = await Campaign.findOne(filter).lean();

    if (!campaign) {
      return fail(
        res,
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Campaign not found",
        requestId
      );
    }

    const applyCampaign = await ApplyCampaign.findOne({
      campaignId: campaignId,
    }).lean();

    const count = applyCampaign?.applicants?.length || 0;

    campaign.count = count;

    const enriched = (await enrichCampaigns([campaign]))[0];

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      { doc: enriched },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VIEW_CAMPAIGN_BY_ID_FOR_BRAND_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

exports.getRecommendedInfluencersByCampaignId = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandIdRaw = clean(req.body.brandId);
    if (!brandIdRaw || !Types.ObjectId.isValid(brandIdRaw)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const campaignIdRaw = clean(req.body.campaignId);
    if (!campaignIdRaw) {
      return fail(res, 400, "VALIDATION_ERROR", "campaignId is required", requestId);
    }

    const page = clampInt(req.body.page, 1, 1, 1000000);
    const limit = clampInt(req.body.limit, 20, 1, 100);
    const skip = (page - 1) * limit;

    const brandObjectId = new Types.ObjectId(brandIdRaw);

    const campaignOr = [];

    // support Mongo _id
    if (Types.ObjectId.isValid(campaignIdRaw)) {
      campaignOr.push({ _id: new Types.ObjectId(campaignIdRaw) });
    }
    campaignOr.push({ campaignId: campaignIdRaw });

    const campaign = await Campaign.findOne({
      $and: [
        { $or: campaignOr },
        {
          $or: [
            { brandId: brandObjectId },   // if stored as ObjectId
            { brandId: brandIdRaw },      // if stored as string
          ],
        },
      ],
    })
      .select("_id campaignId brandId categoryId status")
      .lean();

    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found for this brand", requestId);
    }

    const categoryId = String(campaign.categoryId || "").trim();
    if (!categoryId || !Types.ObjectId.isValid(categoryId)) {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        "Campaign categoryId is missing. Please select at least one category.",
        requestId
      );
    }

    const catOid = new Types.ObjectId(categoryId);

    const match = {
      $or: [
        { "categories._id": catOid },
        { categories: catOid },
        { categoryId: catOid },
        { categoryIds: { $in: [catOid] } },
      ],
    };

    const [items, total] = await Promise.all([
      Influencer.find(match)
        .select("-password")
        .skip(skip)
        .limit(limit)
        .lean(),
      Influencer.countDocuments(match),
    ]);

    const out = (items || []).map((inf) => ({
      ...inf,
      _id: String(inf._id),
      influencerId: String(inf._id),
    }));

    return ApiResponse.sendOk(
      res,
      200,
      {
        campaignId: String(campaign._id),
        items: out,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_RECOMMENDED_INFLUENCERS_BY_CAMPAIGN_ID_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

exports.updateStatus = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);
    const statusRaw = clean(req.body.status);

    if (!brandId || !isOid(brandId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    if (!campaignId || !isOid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const allowedStatuses = ["draft", "scheduled", "active", "paused", "completed", "archived"];

    if (!statusRaw || !allowedStatuses.includes(statusRaw)) {
      return fail(
        res,
        400,
        "VALIDATION_ERROR",
        `status must be one of: ${allowedStatuses.join(", ")}`,
        requestId
      );
    }

    const existing = await Campaign.findById(campaignId).select(
      "_id status brandId publishedAt endAt scheduledAt scheduledLocation endedAt isActive isDraft publishStatus statusUpdatedAt pausedAt"
    );

    if (!existing) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    if (String(existing.brandId) !== String(brandId)) {
      return fail(res, 404, "NOT_FOUND", "Campaign does not belong to this brand", requestId);
    }

    const currentStatus = existing.status;
    const newStatus = statusRaw;

    if (currentStatus === newStatus) {
      return fail(res, 400, "VALIDATION_ERROR", `Campaign is already in '${newStatus}' status`, requestId);
    }

    if (currentStatus === "completed") {
      return fail(res, 400, "VALIDATION_ERROR", "Completed campaign status cannot be changed", requestId);
    }

    if (currentStatus === "archived") {
      return fail(res, 400, "VALIDATION_ERROR", "Archived campaign status cannot be changed", requestId);
    }


    if (newStatus === "scheduled" && currentStatus !== "draft") {
      return fail(res, 400, "VALIDATION_ERROR", "Only draft campaigns can be moved to scheduled", requestId);
    }

    if (newStatus === "draft" && currentStatus !== "scheduled") {
      return fail(res, 400, "VALIDATION_ERROR", "Only scheduled campaigns can be reverted to draft", requestId);
    }

    existing.status = newStatus;
    existing.statusUpdatedAt = new Date();

    existing.isDraft = newStatus === "draft" ? 1 : 0;
    existing.isActive = newStatus === "active" ? 1 : 0;

    if (newStatus === "draft") {
      existing.publishStatus = "draft";
      existing.publishedAt = null;
      existing.scheduledAt = null;
      existing.scheduledLocation = null;
      existing.pausedAt = null;
    }

    if (newStatus === "scheduled") {
      existing.publishStatus = "published";
      existing.publishedAt = null;
      existing.isActive = 0;
      existing.pausedAt = null;
    }

    if (newStatus === "active") {
      existing.publishStatus = "published";
      existing.publishedAt = existing.publishedAt || new Date();
      existing.scheduledAt = null;
      existing.scheduledLocation = null;
      existing.pausedAt = null;
    }

    if (newStatus === "paused") {
      existing.publishStatus = "published";
      existing.pausedAt = new Date();
    }

    if (newStatus === "completed") {
      existing.publishStatus = "published";
      existing.isActive = 0;
      existing.endedAt = existing.endedAt || new Date();
      existing.pausedAt = existing.pausedAt || new Date();
    }

    if (newStatus === "archived") {
      existing.publishStatus = "published";
      existing.isActive = 0;
      existing.pausedAt = existing.pausedAt || new Date();
    }

    await existing.save();

    return ApiResponse.sendOk(res, 200, { message: "Status updated successfully" }, requestId);
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_STATUS_ERROR");
    return sendControllerError(res, requestId, err);
  }
};


exports.updateManualCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const bodyBrandId = clean(req.body.brandId);
    if (!bodyBrandId) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "brandId", requestId);
    }

    const brandDoc = await findBrandDocByAnyId(bodyBrandId);
    if (!brandDoc) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Brand not found", requestId);
    }

    const campaignId = clean(req.body.campaignId);
    if (!campaignId) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "campaignId", requestId);
    }
    if (!isOid(campaignId)) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "campaignId", requestId, "Valid campaignId is required");
    }

    const filter = buildCampaignLookupFilter(campaignId, brandDoc._id);
    const existingCampaign = await Campaign.findOne(filter);

    if (!existingCampaign) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Campaign not found", requestId);
    }

    const campaignTz = getCampaignTimezone(req.body, existingCampaign.campaignTimezone);
    req.body.campaignTimezone = campaignTz;

    const status = pickStatus(req.body.status || existingCampaign.status || "active");
    const mode = status === "draft" ? "draft" : "publish";

    const v = await validateForMode(res, requestId, mode, req.body, {
      existingProductImages: existingCampaign.productImages || [],
    });
    if (!v.ok) return v.resp;

    let timing = {};

    if (status === "draft") {
      timing = parseDraftWindowSoft(req.body, campaignTz);
    } else {
      const win = parseCampaignWindowForUpdate(req.body, campaignTz, requestId, res, {
        allowPastStart: true,
      });
      if (!win.ok) return win.resp;
      timing = win.value;
    }

    const rel = await resolveCategoryAndSubcategories(clean(req.body.categoryId), normalizeObjectIdArray(req.body.subcategoryIds));
    if (rel.error) {
      return failField(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "subcategoryIds", requestId, rel.error);
    }

    let normalizedProductImages = existingCampaign.productImages || [];

    if (req.body.productImages !== undefined) {
      normalizedProductImages = await normalizeAndUploadProductImages(
        req.body.productImages
      );
    }

    const mergedBody = {
      ...req.body,
      productImages: normalizedProductImages,
    };

    const patch = buildCampaignUpdatePatch(mergedBody, existingCampaign, status, timing, {
      categoryName: rel?.cat?.name || "",
      subcategoryNames: Array.isArray(rel?.subs) ? rel.subs.map((s) => String(s.name || "")) : [],
    });

    Object.assign(existingCampaign, patch);
    await existingCampaign.save();

    const enriched = (await enrichCampaigns([existingCampaign]))[0];

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message: "Campaign updated successfully.",
        doc: enriched,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "UPDATE_MANUAL_CAMPAIGN_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

function buildCampaignLookupForInfluencerView(campaignId) {
  const raw = clean(campaignId);
  if (!isOid(raw)) return null;
  return { _id: toObjectId(raw) };
}

exports.viewCampaignByIdForInfluencer = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const influencerIdRaw = clean(req.body.influencerId);
    if (!influencerIdRaw) {
      return fail(res, 400, "VALIDATION_ERROR", "influencerId is required", requestId);
    }

    // support both Mongo _id and custom influencerId
    const influencerLookup = mongoose.Types.ObjectId.isValid(influencerIdRaw)
      ? {
        $or: [
          { _id: influencerIdRaw },
          { influencerId: influencerIdRaw }
        ]
      }
      : { influencerId: influencerIdRaw };

    const influencerDoc = await Influencer.findOne(influencerLookup)
      .select("_id influencerId name")
      .lean();

    if (!influencerDoc) {
      return fail(res, 404, "NOT_FOUND", "Influencer not found", requestId);
    }

    const internalInfluencerId = String(influencerDoc._id);
    const publicInfluencerId = String(influencerDoc.influencerId || influencerDoc._id);

    const campaignId = clean(req.body.campaignId);
    if (!campaignId) {
      return fail(res, 400, "VALIDATION_ERROR", "campaignId is required", requestId);
    }

    if (!isOid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const filter = buildCampaignLookupForInfluencerView(campaignId);
    if (!filter) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const campaign = await Campaign.findOne(filter).lean();
    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    const campaignObjectId = String(campaign._id);
    const campaignLegacyId = campaign.campaignId
      ? String(campaign.campaignId).trim()
      : "";

    const hasApplied = await ApplyCampaign.exists({
      $and: [
        {
          $or: [
            { campaignId: campaignObjectId },
            ...(campaignLegacyId ? [{ campaignId: campaignLegacyId }] : [])
          ]
        },
        {
          $or: [
            { "applicants.influencerId": internalInfluencerId },
            { "applicants.influencerId": publicInfluencerId }
          ]
        }
      ]
    });

    const contract = await Contract.findOne(
      {
        $and: [
          {
            $or: [
              { campaignId: campaignObjectId },
              ...(campaignLegacyId ? [{ campaignId: campaignLegacyId }] : [])
            ]
          },
          {
            influencerId: { $in: [internalInfluencerId, publicInfluencerId] }
          }
        ]
      },
      "contractId isAccepted isAssigned status"
    ).lean();

    const enriched = (await enrichCampaigns([campaign]))[0];

    const doc = {
      ...enriched,
      hasApplied: hasApplied ? 1 : 0,
      hasApproved: contract?.isAssigned === 1 ? 1 : 0,
      isContracted: contract ? 1 : 0,
      isAccepted: contract?.isAccepted === 1 ? 1 : 0,
      contractId: contract?.contractId || null
    };

    return ApiResponse.sendOk(res, 200, { doc }, requestId);
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "VIEW_CAMPAIGN_BY_ID_FOR_INFLUENCER_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

exports.getAllActiveCampaignsForInfluencer = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const { influencerId, page = 1, limit = 10, search = "" } = req.body || {};

    if (!influencerId) {
      return fail(res, 400, "VALIDATION_ERROR", "influencerId is required", requestId);
    }

    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, parseInt(limit, 10) || 10);
    const skip = (safePage - 1) * safeLimit;

    const influencerLookup = mongoose.Types.ObjectId.isValid(String(influencerId))
      ? {
        $or: [
          { _id: influencerId },
          { influencerId: String(influencerId) }
        ]
      }
      : { influencerId: String(influencerId) };

    const influencer = await Influencer.findOne(
      influencerLookup,
      "_id influencerId"
    ).lean();

    if (!influencer) {
      return fail(res, 404, "NOT_FOUND", "Influencer not found", requestId);
    }

    const internalInfluencerId = String(influencer._id);
    const publicInfluencerId = String(influencer.influencerId || influencer._id);

    const appliedDocs = await ApplyCampaign.find(
      {
        $or: [
          { "applicants.influencerId": internalInfluencerId },
          { "applicants.influencerId": publicInfluencerId }
        ]
      },
      "campaignId"
    ).lean();

    const appliedCampaignIds = [
      ...new Set(
        appliedDocs
          .map((doc) => String(doc.campaignId || "").trim())
          .filter(Boolean)
      )
    ];

    const appliedObjectIds = appliedCampaignIds.filter((id) =>
      mongoose.Types.ObjectId.isValid(id)
    );

    const filter = {
      status: "active",
      isActive: 1,
      isDraft: { $ne: 1 }
    };

    if (appliedCampaignIds.length) {
      filter.$and = [
        {
          $nor: [
            { campaignId: { $in: appliedCampaignIds } },
            ...(appliedObjectIds.length ? [{ _id: { $in: appliedObjectIds } }] : [])
          ]
        }
      ];
    }

    if (search && String(search).trim()) {
      const searchClause = { $or: buildSearchOr(String(search).trim()) };

      if (filter.$and) {
        filter.$and.push(searchClause);
      } else {
        filter.$and = [searchClause];
      }
    }

    const [total, campaigns] = await Promise.all([
      Campaign.countDocuments(filter),
      Campaign.find(filter)
        .populate({
          path: "campaignGoals",
          select: "_id goal"
        })
        .populate({
          path: "targetCountryIds",
          select: "_id name countryName code isoCode flag"
        })
        .populate({
          path: "targetAgeRanges",
          select: "_id range"
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean()
    ]);

    return ApiResponse.sendOk(
      res,
      200,
      {
        items: campaigns,
        pagination: {
          total,
          page: safePage,
          limit: safeLimit,
          totalPages: Math.ceil(total / safeLimit)
        }
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_ALL_ACTIVE_CAMPAIGNS_FOR_INFLUENCER_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

async function activateDueScheduledCampaignsForBrand(brandObjectId) {
  const now = new Date();

  await Campaign.updateMany(
    {
      brandId: brandObjectId,
      status: "scheduled",
      scheduledAt: { $lte: now },
      isDraft: { $ne: 1 },
    },
    {
      $set: {
        status: "active",
        isActive: 1,
        isDraft: 0,
        publishStatus: "published",
        publishedAt: now,
        statusUpdatedAt: now,
      },
      $unset: {
        scheduledLocation: "",
      },
    }
  );
}

exports.getCampaignsByBrandId = async (req, res) => {
  try {
    const {
      brandId,
      page = 1,
      limit = 1000,
      search = "",
      status = "active",
    } = req.body || {};

    if (!brandId) {
      return res.status(400).json({
        success: false,
        message: "brandId is required.",
      });
    }

    const brandObjectId = getSafeObjectId(brandId);

    if (!brandObjectId) {
      return res.status(400).json({
        success: false,
        message: "Invalid brandId.",
      });
    }

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.max(parseInt(limit, 10) || 1000, 1);
    const skip = (safePage - 1) * safeLimit;

    await activateDueScheduledCampaignsForBrand(brandObjectId);
    const now = new Date();
    const normalizedStatus = String(status || "").trim().toLowerCase();

    const validStatuses = new Set([
      "draft",
      "scheduled",
      "active",
      "paused",
      "completed",
      "archived",
    ]);

    const andFilters = [
      { brandId: brandObjectId },
    ];

    if (normalizedStatus && normalizedStatus !== "all") {
      if (!validStatuses.has(normalizedStatus)) {
        return res.status(400).json({
          success: false,
          message: "Invalid campaign status.",
        });
      }

      if (normalizedStatus === "draft") {
        andFilters.push({
          $or: [
            { status: "draft" },
            { isDraft: 1 },
            { publishStatus: "draft" },
          ],
        });
      } else if (normalizedStatus === "scheduled") {
        andFilters.push({
          status: "scheduled",
          scheduledAt: { $gt: now },
          isActive: { $ne: 1 },
          isDraft: { $ne: 1 },
        });
      } else if (normalizedStatus === "active") {
        andFilters.push({
          $or: [
            { status: "active" },
            {
              isActive: 1,
              isDraft: { $ne: 1 },
            },
          ],
        });
      } else {
        andFilters.push({
          status: normalizedStatus,
        });
      }
    }

    const searchOr = buildDisputeCampaignSearchOr(search);

    if (searchOr.length) {
      andFilters.push({ $or: searchOr });
    }

    const filter = {
      $and: andFilters,
    };

    const [items, total] = await Promise.all([
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),

      Campaign.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        items: items.map(mapCampaignForDisputeDropdown),
        meta: {
          total,
          page: safePage,
          limit: safeLimit,
          totalPages: Math.ceil(total / safeLimit),
        },
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_CAMPAIGNS_BY_BRAND_ID_ERROR");
    console.error("getCampaignsByBrandId error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.getCampaignsByInfluencerId = async (req, res) => {
  try {
    const {
      influencerId,
      page = 1,
      limit = 1000,
      search = "",
      status = "active",
    } = req.body || {};

    if (!influencerId) {
      return res.status(400).json({
        success: false,
        message: "influencerId is required.",
      });
    }

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.max(parseInt(limit, 10) || 1000, 1);
    const skip = (safePage - 1) * safeLimit;

    const influencerIdString = String(influencerId).trim();
    const influencerObjectId = getSafeObjectId(influencerIdString);

    const influencerLookup = influencerObjectId
      ? {
        $or: [
          { _id: influencerObjectId },
          { influencerId: influencerIdString },
          { email: influencerIdString },
        ],
      }
      : {
        $or: [
          { influencerId: influencerIdString },
          { email: influencerIdString },
        ],
      };

    const influencer = await Influencer.findOne(
      influencerLookup,
      "_id influencerId email name fullName handle"
    ).lean();

    const possibleInfluencerIds = [
      influencerIdString,
      influencer?._id ? String(influencer._id) : "",
      influencer?.influencerId ? String(influencer.influencerId) : "",
      influencer?.email ? String(influencer.email) : "",
    ].filter(Boolean);

    const possibleInfluencerObjectIds = possibleInfluencerIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const appliedDocs = await ApplyCampaign.find(
      {
        "applicants.influencerId": { $in: possibleInfluencerIds },
      },
      "campaignId applicants"
    ).lean();

    const contractDocs = await Contract.find(
      {
        $or: [
          { influencerId: { $in: possibleInfluencerIds } },
          { influencerId: { $in: possibleInfluencerObjectIds } },
          { "influencer._id": { $in: possibleInfluencerObjectIds } },
          { "influencer.influencerId": { $in: possibleInfluencerIds } },
        ],
      },
      "campaignId"
    ).lean();

    const campaignIds = [
      ...new Set(
        [...appliedDocs, ...contractDocs]
          .map((doc) => String(doc.campaignId || "").trim())
          .filter(Boolean)
      ),
    ];

    const campaignObjectIds = campaignIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (!campaignIds.length && !campaignObjectIds.length) {
      return res.status(200).json({
        success: true,
        data: {
          items: [],
          meta: {
            total: 0,
            page: safePage,
            limit: safeLimit,
            totalPages: 0,
          },
        },
      });
    }

    const andFilters = [
      {
        $or: [
          { _id: { $in: campaignObjectIds } },
          { campaignId: { $in: campaignIds } },
        ],
      },
      { isActive: 1 },
      { isDraft: { $ne: 1 } },
    ];

    if (status) {
      andFilters.push({
        status: String(status).trim().toLowerCase(),
      });
    }

    const searchOr = buildDisputeCampaignSearchOr(search);

    if (searchOr.length) {
      andFilters.push({ $or: searchOr });
    }

    const filter = {
      $and: andFilters,
    };

    const [items, total] = await Promise.all([
      Campaign.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),

      Campaign.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        items: items.map(mapCampaignForDisputeDropdown),
        meta: {
          total,
          page: safePage,
          limit: safeLimit,
          totalPages: Math.ceil(total / safeLimit),
        },
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_CAMPAIGNS_BY_INFLUENCER_ID_ERROR");
    console.error("getCampaignsByInfluencerId error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};
//edit draft campaign - only allows updating certain fields, and only if campaign is still in draft mode

function cleanImageString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function getImageKeyFromUrl(url) {
  const s = cleanImageString(url);
  if (!s) return "";
  return s.split("/campaign-images/")[1] || s.split("/").pop() || "";
}

function isBase64Image(value) {
  const s = cleanImageString(value);
  return /^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(s);
}

function normalizeAlreadyUploadedProductImage(item) {
  if (!item) return null;

  if (typeof item === "string") {
    const url = cleanImageString(item);
    if (!url) return null;

    if (isValidHttpUrl(url)) {
      const key = getImageKeyFromUrl(url);
      return {
        dataUrl: url,
        key,
        name: key || "Campaign image",
        type: "image/jpeg",
        contentType: "image/jpeg",
        originalSize: 0,
        size: 0,
      };
    }

    return null;
  }

  if (typeof item !== "object") return null;

  const url = cleanImageString(
    item.dataUrl ||
    item.url ||
    item.Location ||
    item.location ||
    item.secure_url ||
    item.s3Url
  );

  if (!url || !isValidHttpUrl(url)) return null;

  const key = cleanImageString(item.key) || getImageKeyFromUrl(url);
  const contentType = cleanImageString(item.contentType || item.type) || "image/jpeg";
  const size = Number(item.size || item.originalSize || 0) || 0;

  return {
    dataUrl: url,
    key,
    name: cleanImageString(item.name) || key || "Campaign image",
    type: cleanImageString(item.type) || contentType,
    contentType,
    originalSize: Number(item.originalSize || item.size || 0) || size,
    size,
  };
}

async function normalizeProductImagesForDraft(productImages) {
  const list = Array.isArray(productImages)
    ? productImages
    : productImages
      ? [productImages]
      : [];

  const alreadyUploaded = [];
  const base64Images = [];

  for (const item of list) {
    const raw =
      typeof item === "string"
        ? cleanImageString(item)
        : item && typeof item === "object"
          ? cleanImageString(
            item.dataUrl ||
            item.url ||
            item.Location ||
            item.location ||
            item.secure_url ||
            item.s3Url
          )
          : "";

    if (!raw) continue;

    if (isBase64Image(raw)) {
      base64Images.push(raw);
      continue;
    }

    const normalized = normalizeAlreadyUploadedProductImage(item);
    if (normalized) alreadyUploaded.push(normalized);
  }

  let uploadedFromBase64 = [];
  if (base64Images.length) {
    uploadedFromBase64 = await normalizeAndUploadProductImages(base64Images);
  }

  return [...alreadyUploaded, ...uploadedFromBase64];
}

exports.editDraftCampaign = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    const campaignId = clean(req.body.campaignId);

    if (!brandId || !isOid(brandId)) {
      return fail(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    if (!campaignId || !isOid(campaignId)) {
      return fail(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    const existing = await Campaign.findOne({
      _id: toObjectId(campaignId),
      brandId: toObjectId(brandId),
      status: "draft",
      isDraft: 1,
    });

    if (!existing) {
      return fail(res, HttpStatus.NOT_FOUND, "NOT_FOUND", "Draft campaign not found (or not editable)", requestId);
    }

    const campaignTz = getCampaignTimezone(req.body, existing.campaignTimezone);
    const geo = await detectGeoFromRequest(req);

    const update = { $set: {}, $unset: {} };
    const validateView = {}; // keep string/plain values for validateForMode

    const cleanAny = (value) => {
      if (value === undefined || value === null) return "";
      return String(value).trim();
    };

    const setOrUnsetString = (key, value) => {
      if (value === undefined) return;
      const s = cleanAny(value);
      if (!s) {
        update.$unset[key] = 1;
        validateView[key] = undefined;
      } else {
        update.$set[key] = s;
        validateView[key] = s;
      }
    };

    const setOrUnsetIdArray = (key, value) => {
      if (value === undefined) return;
      const ids = normalizeObjectIdArray(value);
      if (!ids.length) {
        update.$unset[key] = 1;
        validateView[key] = [];
      } else {
        update.$set[key] = ids.map((id) => toObjectId(id));
        validateView[key] = ids;
      }
    };

    const setOrUnsetDateField = (key, value, tz) => {
      if (value === undefined) return;

      const raw = cleanAny(value);
      if (!raw) {
        update.$unset[key] = 1;
        validateView[key] = undefined;
        return;
      }

      const parsed = toUtcDateFromAny(raw, tz);
      if (!parsed) throw new Error(`Invalid ${key}`);

      update.$set[key] = parsed;
      validateView[key] = parsed;
    };

    // campaignTitle
    if (req.body.campaignTitle !== undefined) {
      const s = cleanAny(req.body.campaignTitle);
      if (!s) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "campaignTitle",
          requestId
        );
      }
      update.$set.campaignTitle = s;
      validateView.campaignTitle = s;
    }

    // optional strings
    setOrUnsetString("description", req.body.description);
    setOrUnsetString("campaignType", req.body.campaignType);
    setOrUnsetString("additionalNotes", req.body.additionalNotes);

    // product images
    // Frontend already uploads files to S3 first and sends productImages as
    // objects like { dataUrl: "https://...s3...", name, type, key, size }.
    // Do not re-upload or reject these objects here. Save the S3 URL metadata directly.
    if (req.body.productImages !== undefined) {
      const imgs = await normalizeProductImagesForDraft(req.body.productImages);

      if (!imgs.length) {
        update.$unset.productImages = 1;
        validateView.productImages = [];
      } else {
        update.$set.productImages = imgs;
        validateView.productImages = imgs;
      }
    }

    // productLink
    if (req.body.productLink !== undefined) {
      const link = cleanAny(req.body.productLink);
      if (link && !isValidHttpUrl(link)) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "productLink",
          requestId,
          "productLink must be a valid http/https URL"
        );
      }
      if (!link) {
        update.$unset.productLink = 1;
        validateView.productLink = undefined;
      } else {
        update.$set.productLink = link;
        validateView.productLink = link;
      }
    }

    // videoLink
    if (req.body.videoLink !== undefined) {
      const link = cleanAny(req.body.videoLink);
      if (link && !isValidHttpUrl(link)) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "videoLink",
          requestId,
          "videoLink must be a valid http/https URL"
        );
      }
      if (!link) {
        update.$unset.videoLink = 1;
        validateView.videoLink = undefined;
      } else {
        update.$set.videoLink = link;
        validateView.videoLink = link;
      }
    }

    // categoryId
    if (req.body.categoryId !== undefined) {
      const s = cleanAny(req.body.categoryId);

      if (!s) {
        update.$unset.categoryId = 1;
        update.$unset.subcategoryIds = 1;
        update.$unset.campaignCategory = 1;
        update.$unset.campaignSubcategory = 1;
        update.$unset.categories = 1;

        validateView.categoryId = undefined;
        validateView.subcategoryIds = [];
      } else {
        if (!isOid(s)) {
          return failField(
            res,
            HttpStatus.BAD_REQUEST,
            "VALIDATION_ERROR",
            "categoryId",
            requestId,
            "Invalid categoryId"
          );
        }

        update.$set.categoryId = toObjectId(s);   // DB value
        validateView.categoryId = s;              // validation value
      }
    }

    // subcategoryIds
    if (req.body.subcategoryIds !== undefined) {
      const ids = normalizeObjectIdArray(req.body.subcategoryIds);

      if (!ids.length) {
        update.$unset.subcategoryIds = 1;
        update.$unset.campaignSubcategory = 1;
        update.$unset.categories = 1;
        validateView.subcategoryIds = [];
      } else {
        update.$set.subcategoryIds = ids.map((id) => toObjectId(id)); // DB value
        validateView.subcategoryIds = ids;                            // validation value
      }
    }

    // object-id arrays
    setOrUnsetIdArray("campaignGoals", req.body.campaignGoals);
    setOrUnsetIdArray("influencerTierIds", req.body.influencerTierIds);
    setOrUnsetIdArray("contentFormats", req.body.contentFormats);
    setOrUnsetIdArray("contentLanguageIds", req.body.contentLanguageIds);
    setOrUnsetIdArray("targetCountryIds", req.body.targetCountryIds);
    setOrUnsetIdArray("targetAgeRanges", req.body.targetAgeRanges);
    setOrUnsetIdArray("preferredHashtags", req.body.preferredHashtags);

    // paymentType
    if (req.body.paymentType !== undefined) {
      const p = cleanAny(req.body.paymentType);
      if (!p) {
        update.$unset.paymentType = 1;
        validateView.paymentType = undefined;
      } else {
        const normalized = normalizePaymentType(p);
        update.$set.paymentType = normalized;
        validateView.paymentType = normalized;
      }
    }

    // campaignBudget / budget
    if (req.body.campaignBudget !== undefined) {
      const raw = cleanAny(req.body.campaignBudget);

      if (!raw) {
        update.$unset.campaignBudget = 1;
        update.$unset.budget = 1;
        validateView.campaignBudget = undefined;
      } else {
        const n = Number(raw);

        if (!Number.isFinite(n) || n < 0) {
          return failField(
            res,
            HttpStatus.BAD_REQUEST,
            "VALIDATION_ERROR",
            "campaignBudget",
            requestId,
            "campaignBudget must be >= 0"
          );
        }

        update.$set.campaignBudget = n;
        update.$set.budget = n;
        validateView.campaignBudget = n;
      }
    }

    // influencerBudget
    if (req.body.influencerBudget !== undefined) {
      const raw = cleanAny(req.body.influencerBudget);

      if (!raw) {
        update.$unset.influencerBudget = 1;
        validateView.influencerBudget = undefined;
      } else {
        const n = Number(raw);

        if (!Number.isFinite(n) || n < 0) {
          return failField(
            res,
            HttpStatus.BAD_REQUEST,
            "VALIDATION_ERROR",
            "influencerBudget",
            requestId,
            "influencerBudget must be >= 0"
          );
        }

        update.$set.influencerBudget = n;
        validateView.influencerBudget = n;
      }
    }

    // numeric fields
    const numericFields = ["numberOfInfluencers", "minFollowers", "maxFollowers"];
    for (const field of numericFields) {
      if (req.body[field] === undefined) continue;

      const raw = cleanAny(req.body[field]);

      if (!raw) {
        update.$unset[field] = 1;
        validateView[field] = undefined;
        continue;
      }

      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          field,
          requestId,
          `${field} must be a valid non-negative number`
        );
      }

      update.$set[field] = Math.trunc(n);
      validateView[field] = Math.trunc(n);
    }

    // dates
    try {
      setOrUnsetDateField("startAt", req.body.startAt, campaignTz);
      setOrUnsetDateField("endAt", req.body.endAt, campaignTz);

      if (req.body.campaignTimezone !== undefined) {
        update.$set.campaignTimezone = campaignTz;
        validateView.campaignTimezone = campaignTz;
      }
    } catch (e) {
      return fail(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        e.message || "Invalid date",
        requestId
      );
    }

    // keep category display fields in sync
    const mergedCategoryId =
      validateView.categoryId !== undefined
        ? String(validateView.categoryId)
        : update.$unset.categoryId
          ? ""
          : existing.categoryId
            ? String(existing.categoryId)
            : "";

    const mergedSubIds =
      validateView.subcategoryIds !== undefined
        ? validateView.subcategoryIds.map((x) => String(x))
        : update.$unset.subcategoryIds
          ? []
          : Array.isArray(existing.subcategoryIds)
            ? existing.subcategoryIds.map((x) => String(x))
            : [];

    if (mergedCategoryId && mergedSubIds.length) {
      const rel = await resolveCategoryAndSubcategories(mergedCategoryId, mergedSubIds);

      if (rel.error) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "subcategoryIds",
          requestId,
          rel.error
        );
      }

      update.$set.campaignCategory = rel?.cat?.name || "";
      update.$set.campaignSubcategory = Array.isArray(rel?.subs)
        ? rel.subs.map((s) => String(s.name || "")).join(", ")
        : "";

      update.$set.categories = Array.isArray(rel?.subs)
        ? rel.subs.map((sub, idx) => ({
          categoryId: mergedCategoryId,
          categoryName: rel?.cat?.name || "",
          subcategoryId: String(mergedSubIds[idx] || ""),
          subcategoryName: String(sub.name || ""),
        }))
        : [];
    } else if (update.$unset.categoryId || update.$unset.subcategoryIds) {
      update.$unset.campaignCategory = 1;
      update.$unset.campaignSubcategory = 1;
      update.$unset.categories = 1;
    }

    // timeline sync
    const mergedStartAt =
      update.$set.startAt !== undefined
        ? update.$set.startAt
        : update.$unset.startAt
          ? null
          : existing.startAt || null;

    const mergedEndAt =
      update.$set.endAt !== undefined
        ? update.$set.endAt
        : update.$unset.endAt
          ? null
          : existing.endAt || null;

    if (mergedStartAt && mergedEndAt) {
      update.$set.timeline = {
        startDate: mergedStartAt,
        endDate: mergedEndAt,
      };
    } else if (update.$unset.startAt || update.$unset.endAt) {
      update.$unset.timeline = 1;
    }

    const hasSetBeforeStatus = Object.keys(update.$set).length > 0;
    const hasUnsetBeforeStatus = Object.keys(update.$unset).length > 0;

    const requestedStatus = req.body.status ? pickStatus(req.body.status) : "draft";

    if (requestedStatus === "active") {
      const merged = {
        ...existing.toObject(),
        ...validateView, // <-- use plain/string values for validator
        productImages:
          validateView.productImages !== undefined
            ? validateView.productImages
            : existing.productImages || [],
        categoryId:
          validateView.categoryId !== undefined
            ? validateView.categoryId
            : existing.categoryId
              ? String(existing.categoryId)
              : undefined,
        subcategoryIds:
          validateView.subcategoryIds !== undefined
            ? validateView.subcategoryIds
            : Array.isArray(existing.subcategoryIds)
              ? existing.subcategoryIds.map((x) => String(x))
              : [],
        status: "active",
        brandId,
      };

      const v = await validateForMode(res, requestId, "publish", merged, {
        existingProductImages: merged.productImages || [],
      });
      if (!v.ok) return v.resp;

      const win = parseCampaignWindow(
        {
          ...existing.toObject(),
          ...update.$set,
          ...validateView,
          status: "active",
          brandId,
        },
        campaignTz,
        requestId,
        res,
        true
      );

      if (!win.ok) return win.resp;

      update.$set.status = "active";
      update.$set.startAt = win.value.startAt;
      update.$set.endAt = win.value.endAt;
      update.$set.timeline = {
        startDate: win.value.startAt,
        endDate: win.value.endAt,
      };
      update.$set.publishedAt = existing.publishedAt || new Date();
      update.$set.publishStatus = "published";
      update.$set.isDraft = 0;
      update.$set.isActive = 1;
      update.$set.statusUpdatedAt = new Date();
      update.$set.campaignTimezone = campaignTz;
      update.$set.createdLocation = {
        ip: geo?.ip,
        timezone: geo?.timezone,
        country: geo?.country,
        state: geo?.state,
        city: geo?.city,
        latitude: typeof geo?.latitude === "number" ? geo.latitude : undefined,
        longitude: typeof geo?.longitude === "number" ? geo.longitude : undefined,
        source: geo?.source,
      };
    } else {
      update.$set.status = "draft";
      update.$set.publishStatus = "draft";
      update.$set.isDraft = 1;
      update.$set.isActive = 0;
      update.$set.statusUpdatedAt = new Date();
      update.$unset.publishedAt = 1;
    }

    if (!hasSetBeforeStatus && !hasUnsetBeforeStatus && !req.body.status) {
      const enriched = (await enrichCampaigns([existing]))[0];
      return ApiResponse.sendOk(res, HttpStatus.OK, { doc: enriched }, requestId);
    }

    if (Object.keys(update.$set).length === 0) delete update.$set;
    if (Object.keys(update.$unset).length === 0) delete update.$unset;

    const updated = await Campaign.findOneAndUpdate(
      {
        _id: toObjectId(campaignId),
        brandId: toObjectId(brandId),
        status: "draft",
        isDraft: 1,
      },
      update,
      { new: true }
    );

    if (!updated) {
      return fail(
        res,
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Draft campaign not found after update",
        requestId
      );
    }

    const enriched = (await enrichCampaigns([updated]))[0];

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        message:
          requestedStatus === "active"
            ? "Draft campaign published successfully."
            : "Draft campaign updated successfully.",
        doc: enriched,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "EDIT_DRAFT_CAMPAIGN_ERROR");
    return sendControllerError(res, requestId, err);
  }
};
exports.getDraftCampaigns = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const brandId = clean(req.body.brandId);
    if (!brandId || !isOid(brandId)) {
      return fail(res, HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const page = clampInt(req.body.page, 1, 1, 1000000);
    const limit = clampInt(req.body.limit, 10, 1, 100);
    const skip = (page - 1) * limit;

    const normalizeDateField = (value) => {
      const raw = clean(value);
      const allowed = ["createdAt", "updatedAt", "startAt", "endAt", "publishedAt"];
      return allowed.includes(raw) ? raw : "updatedAt";
    };

    const normalizeDatePreset = (value) => {
      const raw = clean(value).toLowerCase();
      const map = {
        today: "today",
        last7days: "last7days",
        last_7_days: "last7days",
        last30days: "last30days",
        last_30_days: "last30days",
        thisweek: "thisweek",
        this_week: "thisweek",
        thismonth: "thismonth",
        this_month: "thismonth",
      };
      return map[raw] || "";
    };

    const parseClientDateToUtc = (raw, timezone, boundary = "start") => {
      const s = clean(raw);
      if (!s) return null;

      const ddmmyyyy = /^(\d{2})\/(\d{2})\/(\d{4})$/;
      const m = s.match(ddmmyyyy);
      if (m) {
        const [, dd, mm, yyyy] = m;
        const dt = DateTime.fromObject(
          {
            year: Number(yyyy),
            month: Number(mm),
            day: Number(dd),
            hour: boundary === "end" ? 23 : 0,
            minute: boundary === "end" ? 59 : 0,
            second: boundary === "end" ? 59 : 0,
            millisecond: boundary === "end" ? 999 : 0,
          },
          { zone: timezone }
        );
        return dt.isValid ? dt.toUTC().toJSDate() : null;
      }

      const isoDate = /^\d{4}-\d{2}-\d{2}$/;
      if (isoDate.test(s)) {
        const dt = DateTime.fromISO(s, { zone: timezone }).set({
          hour: boundary === "end" ? 23 : 0,
          minute: boundary === "end" ? 59 : 0,
          second: boundary === "end" ? 59 : 0,
          millisecond: boundary === "end" ? 999 : 0,
        });
        return dt.isValid ? dt.toUTC().toJSDate() : null;
      }

      const abs = toUtcFromLocalOrAbsolute(s, timezone);
      return abs || null;
    };

    const buildUtcRangeFromPreset = (preset, timezone) => {
      const now = DateTime.now().setZone(timezone);

      if (preset === "today") {
        return {
          from: now.startOf("day").toUTC().toJSDate(),
          to: now.endOf("day").toUTC().toJSDate(),
        };
      }

      if (preset === "last7days") {
        return {
          from: now.minus({ days: 6 }).startOf("day").toUTC().toJSDate(),
          to: now.endOf("day").toUTC().toJSDate(),
        };
      }

      if (preset === "last30days") {
        return {
          from: now.minus({ days: 29 }).startOf("day").toUTC().toJSDate(),
          to: now.endOf("day").toUTC().toJSDate(),
        };
      }

      if (preset === "thisweek") {
        return {
          from: now.startOf("week").toUTC().toJSDate(),
          to: now.endOf("week").toUTC().toJSDate(),
        };
      }

      if (preset === "thismonth") {
        return {
          from: now.startOf("month").toUTC().toJSDate(),
          to: now.endOf("month").toUTC().toJSDate(),
        };
      }

      return null;
    };

    const buildSortLocal = (sortByRaw, sortOrderRaw, fallback = { updatedAt: -1 }) => {
      const allowed = [
        "createdAt",
        "updatedAt",
        "startAt",
        "endAt",
        "publishedAt",
        "campaignTitle",
        "campaignBudget",
        "numberOfInfluencers",
        "status",
      ];

      const sortBy = clean(sortByRaw);
      const sortOrder = String(sortOrderRaw || "desc").toLowerCase() === "asc" ? 1 : -1;

      if (!allowed.includes(sortBy)) return fallback;
      return { [sortBy]: sortOrder };
    };

    const tz = getCampaignTimezone(req.body);

    // ---------------- Build filter ----------------
    const filter = {
      brandId: toObjectId(brandId),
      status: "draft",
      isDraft: 1,
    };

    // search
    const search = clean(req.body.search);
    if (search) {
      filter.$or = buildSearchOr(search);
    }

    // byAi
    if (req.body.byAi === 0 || req.body.byAi === 1 || req.body.byAi === "0" || req.body.byAi === "1") {
      filter.byAi = Number(req.body.byAi);
    }

    // campaignType
    if (clean(req.body.campaignType)) {
      filter.campaignType = {
        $regex: new RegExp(escapeRegex(clean(req.body.campaignType)), "i"),
      };
    }

    // categoryIds / categoryId
    const catIds = normalizeObjectIdArray(req.body.categoryIds ?? req.body.categoryId);
    if (catIds.length) {
      filter.categoryId = { $in: catIds.map((id) => toObjectId(id)) };
    }

    // subcategoryIds / subcategoryId
    const subIds = normalizeObjectIdArray(req.body.subcategoryIds ?? req.body.subcategoryId);
    if (subIds.length) {
      filter.subcategoryIds = { $in: subIds.map((id) => toObjectId(id)) };
    }

    // date filters
    const dateField = normalizeDateField(req.body.dateField);
    const preset = normalizeDatePreset(req.body.datePreset);

    if (preset) {
      const range = buildUtcRangeFromPreset(preset, tz);
      if (range) {
        filter[dateField] = { $gte: range.from, $lte: range.to };
      }
    } else {
      const hasFrom = !!clean(req.body.dateFrom);
      const hasTo = !!clean(req.body.dateTo);

      const fromUtc = hasFrom ? parseClientDateToUtc(req.body.dateFrom, tz, "start") : null;
      const toUtc = hasTo ? parseClientDateToUtc(req.body.dateTo, tz, "end") : null;

      if (hasFrom && !fromUtc) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "dateFrom",
          requestId,
          "Invalid dateFrom. Use dd/mm/yyyy, yyyy-mm-dd, or ISO."
        );
      }

      if (hasTo && !toUtc) {
        return failField(
          res,
          HttpStatus.BAD_REQUEST,
          "VALIDATION_ERROR",
          "dateTo",
          requestId,
          "Invalid dateTo. Use dd/mm/yyyy, yyyy-mm-dd, or ISO."
        );
      }

      if (fromUtc || toUtc) {
        if (fromUtc && toUtc && fromUtc.getTime() > toUtc.getTime()) {
          return fail(
            res,
            HttpStatus.BAD_REQUEST,
            "VALIDATION_ERROR",
            "dateFrom must be <= dateTo",
            requestId
          );
        }

        filter[dateField] = {};
        if (fromUtc) filter[dateField].$gte = fromUtc;
        if (toUtc) filter[dateField].$lte = toUtc;
      }
    }

    const sort = buildSortLocal(req.body.sortBy, req.body.sortOrder, { updatedAt: -1 });

    const [items, total] = await Promise.all([
      Campaign.find(filter).sort(sort).skip(skip).limit(limit),
      Campaign.countDocuments(filter),
    ]);

    const enrichedItems = await enrichCampaigns(items);

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        items: enrichedItems,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_DRAFT_CAMPAIGNS_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

exports.rejectedCampaign = async (req, res) => {
  try {
    const { influencerId } = req.params;

    if (!influencerId) {
      return res.status(400).json({
        success: false,
        message: "influencerId is required",
      });
    }

    const rejectedCampaigns = await Contract.aggregate([
      {
        $match: {
          influencerId: influencerId,
          status: "REJECTED",
        },
      },
      {
        $project: {
          _id: 1,
          campaignId: 1,
          status: 1,
        },
      },
      {
        $addFields: {
          campaignObjectId: { $toObjectId: "$campaignId" },
        },
      },
      {
        $lookup: {
          from: "campaigns",
          localField: "campaignObjectId",
          foreignField: "_id",
          as: "campaignData",
        },
      },
      {
        $unwind: {
          path: "$campaignData",
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          _id: 1,
          campaignId: 1,
          status: 1,
          campaignData: 1,
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      count: rejectedCampaigns.length,
      data: rejectedCampaigns,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "REJECTED_CAMPAIGN_ERROR");
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.enableCampaignShare = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const { campaignId, brandId } = req.body;

    if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    if (!brandId || !mongoose.Types.ObjectId.isValid(brandId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const campaign = await Campaign.findOne({
      _id: campaignId,
      brandId: brandId,
    });

    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    if (!campaign.publicShareToken) {
      const crypto = require("crypto");
      campaign.publicShareToken = crypto.randomBytes(16).toString("hex");
    }

    campaign.isPublic = true;
    await campaign.save();

    const ALLOWED_FRONTEND_ORIGINS = [
      "https://collabglam.com",
      "http://localhost:3000",
      "http://192.168.1.57:3000",
    ];

    const requestOrigin = String(req.headers.origin || "").trim();

    const frontendBase = ALLOWED_FRONTEND_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : "https://collabglam.com";

    const shareUrl = `${frontendBase}/campaign/share/${campaign.publicShareToken}`;

    return ApiResponse.sendOk(
      res,
      200,
      {
        message: "Public share link enabled",
        shareUrl,
        publicShareToken: campaign.publicShareToken,
        isPublic: true,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "ENABLE_CAMPAIGN_SHARE_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

exports.disableCampaignShare = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const { campaignId, brandId } = req.body;

    if (!campaignId || !mongoose.Types.ObjectId.isValid(campaignId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid campaignId is required", requestId);
    }

    if (!brandId || !mongoose.Types.ObjectId.isValid(brandId)) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid brandId is required", requestId);
    }

    const campaign = await Campaign.findOne({
      _id: campaignId,
      brandId: brandId,
    });

    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found", requestId);
    }

    campaign.isPublic = false;
    await campaign.save();

    return ApiResponse.sendOk(
      res,
      200,
      {
        message: "Public share link disabled",
        isPublic: false,
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "DISABLE_CAMPAIGN_SHARE_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

exports.getPublicCampaignByToken = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const { token } = req.params;

    if (!token || !String(token).trim()) {
      return fail(res, 400, "VALIDATION_ERROR", "Valid token is required", requestId);
    }

    const campaign = await Campaign.findOne({
      publicShareToken: token,
      isPublic: true,
    }).lean();

    if (!campaign) {
      return fail(res, 404, "NOT_FOUND", "Campaign not found or not public", requestId);
    }

    return ApiResponse.sendOk(
      res,
      200,
      {
        doc: {
          _id: campaign._id,
          campaignTitle: campaign.campaignTitle,
          description: campaign.description,
          campaignType: campaign.campaignType,
          campaignBudget: campaign.campaignBudget,
          budget: campaign.budget,
          paymentType: campaign.paymentType,
          targetCountryIds: campaign.targetCountryIds || [],
          targetAgeRanges: campaign.targetAgeRanges || [],
          productImages: campaign.productImages || [],
          productLink: campaign.productLink || "",
          videoLink: campaign.videoLink || "",
          additionalNotes: campaign.additionalNotes || "",
          startAt: campaign.startAt,
          endAt: campaign.endAt,
          status: campaign.status,
          brandName: campaign.brandName || "",
          categoryId: campaign.categoryId || null,
          subcategoryIds: campaign.subcategoryIds || [],
          contentFormats: campaign.contentFormats || [],
          contentLanguageIds: campaign.contentLanguageIds || [],
          preferredHashtags: campaign.preferredHashtags || [],
          campaignGoals: campaign.campaignGoals || [],
        },
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_PUBLIC_CAMPAIGN_BY_TOKEN_ERROR");
    return sendControllerError(res, requestId, err);
  }
};

exports.getBrandListByCampaignId = async (req, res) => {
  try {
    const { campaignId, influencerId } = req.body || {};

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        message: "campaignId is required.",
      });
    }

    const campaign = await Campaign.findOne(
      getCampaignIdMatchFilterForDispute(campaignId)
    ).lean();

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: "Campaign not found.",
      });
    }

    const brandIdString = String(campaign.brandId || "").trim();
    const brandObjectId = getSafeObjectId(brandIdString);

    const brandQuery = brandObjectId
      ? {
        $or: [
          { _id: brandObjectId },
          { brandId: brandIdString },
        ],
      }
      : {
        brandId: brandIdString,
      };

    const brand = await Brand.findOne(brandQuery).lean();

    return res.status(200).json({
      success: true,
      message: "Brand fetched successfully",
      brand: {
        _id: brand?._id ? String(brand._id) : brandIdString,
        brandId: brand?._id ? String(brand._id) : brandIdString,
        brandName:
          brand?.brandName ||
          brand?.name ||
          campaign.brandName ||
          "Brand",
        name:
          brand?.name ||
          brand?.brandName ||
          campaign.brandName ||
          "Brand",
        email: brand?.email || "",
        proxyEmail: brand?.proxyEmail || "",
        industry: brand?.industry || "",
        companySize: brand?.companySize || "",
        profilePic: brand?.profilePic || "",
        createdAt: brand?.createdAt,
        updatedAt: brand?.updatedAt,
      },
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_BRAND_LIST_BY_CAMPAIGN_ID_ERROR");
    console.error("getBrandListByCampaignId error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.getInfluencerListByCampaignId = async (req, res) => {
  try {
    const { campaignId, brandId } = req.body || {};

    if (!campaignId) {
      return res.status(400).json({
        success: false,
        message: "campaignId is required.",
      });
    }

    const campaign = await Campaign.findOne(
      getCampaignIdMatchFilterForDispute(campaignId)
    ).lean();

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: "Campaign not found.",
      });
    }

    if (brandId && String(campaign.brandId) !== String(brandId)) {
      return res.status(403).json({
        success: false,
        message: "This campaign does not belong to this brand.",
      });
    }

    const campaignIdValues = [
      String(campaignId || "").trim(),
      String(campaign._id),
      campaign.campaignId ? String(campaign.campaignId) : "",
    ].filter(Boolean);

    const appliedDocs = await ApplyCampaign.find(
      {
        campaignId: { $in: campaignIdValues },
      },
      "applicants"
    ).lean();

    const influencerMap = new Map();

    for (const doc of appliedDocs) {
      for (const applicant of doc.applicants || []) {
        const id = String(applicant.influencerId || "").trim();

        if (!id) continue;

        influencerMap.set(id, {
          influencerId: id,
          name:
            applicant.name ||
            applicant.fullName ||
            applicant.email ||
            id,
          handle: applicant.handle || null,
          status: applicant.status || "",
        });
      }
    }

    const contractDocs = await Contract.find(
      {
        campaignId: { $in: campaignIdValues },
      },
      "influencerId influencer influencerName name handle status"
    ).lean();

    for (const contract of contractDocs) {
      const id = String(
        contract.influencerId ||
        contract.influencer?._id ||
        contract.influencer?.influencerId ||
        ""
      ).trim();

      if (!id) continue;

      influencerMap.set(id, {
        influencerId: id,
        name:
          contract.influencerName ||
          contract.name ||
          contract.influencer?.name ||
          contract.influencer?.fullName ||
          id,
        handle: contract.handle || contract.influencer?.handle || null,
        status: contract.status || "",
      });
    }

    const influencerIds = Array.from(influencerMap.keys());

    const influencerObjectIds = influencerIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const influencerDocs = await Influencer.find(
      {
        $or: [
          { influencerId: { $in: influencerIds } },
          { email: { $in: influencerIds } },
          { _id: { $in: influencerObjectIds } },
        ],
      },
      "_id influencerId name fullName email handle"
    ).lean();

    for (const influencer of influencerDocs) {
      const keys = [
        influencer._id ? String(influencer._id) : "",
        influencer.influencerId ? String(influencer.influencerId) : "",
        influencer.email ? String(influencer.email) : "",
      ].filter(Boolean);

      for (const key of keys) {
        if (!influencerMap.has(key)) continue;

        influencerMap.set(key, {
          influencerId: String(influencer.influencerId || influencer._id),
          name:
            influencer.name ||
            influencer.fullName ||
            influencer.email ||
            String(influencer.influencerId || influencer._id),
          handle: influencer.handle || null,
          email: influencer.email || "",
          _id: String(influencer._id),
          status: influencerMap.get(key)?.status || "",
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Influencers fetched successfully",
      influencers: Array.from(influencerMap.values()),
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "GET_INFLUENCER_LIST_BY_CAMPAIGN_ID_ERROR");
    console.error("getInfluencerListByCampaignId error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.uploadImagesToS3 = async (req, res) => {
  try {
    const imageFiles = Array.isArray(req.files)
      ? req.files
      : Array.isArray(req.files?.image)
        ? req.files.image
        : [];

    if (!imageFiles.length) {
      return res.status(400).json({
        success: false,
        message: "At least one image is required",
      });
    }

    const uploadedImages = await uploadMultipleFilesToS3(
      imageFiles,
      "campaign-images"
    );

    return res.status(200).json({
      success: true,
      message: "Images uploaded successfully",
      count: uploadedImages.length,
      urls: uploadedImages.map((item) => item.url || item.dataUrl),
      images: uploadedImages,
    });
  } catch (error) {
    await saveErrorLog(req, error, error?.statusCode || error?.status || 500, "UPLOAD_IMAGES_TO_S3_ERROR");
    console.error("uploadImagesToS3 error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to upload images",
    });
  }
};



exports.getInfluencerMatchScore = async (req, res) => {
  const requestId = getRequestId(req);

  try {
    const campaignId = clean(req.body?.campaignId);
    const influencerId = clean(req.body?.influencerId);

    if (!campaignId) {
      return failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "campaignId",
        requestId
      );
    }

    if (!influencerId) {
      return failField(
        res,
        HttpStatus.BAD_REQUEST,
        "VALIDATION_ERROR",
        "influencerId",
        requestId
      );
    }

    const campaignOr = [{ campaignId: campaignId }];

    if (isOid(campaignId)) {
      campaignOr.push({ _id: toObjectId(campaignId) });
    }

    const influencerOr = [{ influencerId: String(influencerId) }];

    if (isOid(influencerId)) {
      influencerOr.push({ _id: toObjectId(influencerId) });
    }

    const [campaign, influencer] = await Promise.all([
      Campaign.findOne({ $or: campaignOr }).lean(),
      Influencer.findOne({ $or: influencerOr }).lean(),
    ]);

    if (!campaign) {
      return fail(
        res,
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Campaign not found",
        requestId
      );
    }

    if (!influencer) {
      return fail(
        res,
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Influencer not found",
        requestId
      );
    }

    const normalizeText = (value) =>
      String(value || "")
        .trim()
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const normalizePlatform = (value) => {
      const text = normalizeText(value);

      if (text.includes("instagram")) return "instagram";
      if (text.includes("youtube")) return "youtube";
      if (text.includes("tiktok") || text.includes("tik tok")) return "tiktok";

      return text;
    };

    const toArray = (value) => {
      if (Array.isArray(value)) return value;
      if (value === undefined || value === null || value === "") return [];
      return [value];
    };

    const uniq = (arr) =>
      [...new Set(arr.map((x) => String(x || "").trim()).filter(Boolean))];

    const addText = (target, value) => {
      const text = String(value || "").trim();
      if (text) target.push(text);
    };

    const addId = (target, value) => {
      const id = String(value || "").trim();
      if (id) target.push(id);
    };

    const scoreTextMatch = (campaignTexts = [], influencerTexts = []) => {
      const cTexts = uniq(campaignTexts.map(normalizeText).filter(Boolean));
      const iTexts = uniq(influencerTexts.map(normalizeText).filter(Boolean));

      if (!cTexts.length) return null;
      if (!iTexts.length) return 0;

      const exactMatches = cTexts.filter((c) => iTexts.includes(c));
      if (exactMatches.length) {
        return Math.round((exactMatches.length / cTexts.length) * 100);
      }

      const campaignTokens = new Set(cTexts.join(" ").split(" ").filter(Boolean));
      const influencerTokens = new Set(iTexts.join(" ").split(" ").filter(Boolean));

      if (!campaignTokens.size || !influencerTokens.size) return 0;

      const matchedTokens = [...campaignTokens].filter((token) =>
        influencerTokens.has(token)
      );

      return Math.round((matchedTokens.length / campaignTokens.size) * 70);
    };

    const scoreIdOrTextMatch = ({
      campaignIds = [],
      influencerIds = [],
      campaignTexts = [],
      influencerTexts = [],
    }) => {
      const cIds = uniq(campaignIds);
      const iIds = uniq(influencerIds);

      if (!cIds.length && !campaignTexts.length) return null;

      if (cIds.length && iIds.length) {
        const idMatches = cIds.filter((id) => iIds.includes(id));

        if (idMatches.length) {
          return Math.round((idMatches.length / cIds.length) * 100);
        }
      }

      return scoreTextMatch(campaignTexts, influencerTexts);
    };

    const getEngagementPercent = (value) => {
      const n = Number(value);

      if (!Number.isFinite(n)) return null;

      return n <= 1 ? n * 100 : n;
    };

    const scoreEngagement = (value) => {
      const engagement = getEngagementPercent(value);

      if (!Number.isFinite(engagement)) return null;

      if (engagement >= 5) return 100;
      if (engagement >= 3) return 85;
      if (engagement >= 1.5) return 70;
      if (engagement >= 1) return 55;

      return 35;
    };

    const scoreFollowers = ({ followers, minFollowers, maxFollowers }) => {
      const f = Number(followers || 0);
      const min = Number(minFollowers || 0);
      const max = Number(maxFollowers || 0);

      if (!min && !max) return null;
      if (!Number.isFinite(f) || f <= 0) return 0;

      if (min && f < min) {
        return Math.max(0, Math.round((f / min) * 100));
      }

      if (max && f > max) {
        return Math.max(50, Math.round((max / f) * 100));
      }

      return 100;
    };

    const campaignCategoryIds = [];
    const campaignCategoryNames = [];
    const campaignSubcategoryIds = [];
    const campaignSubcategoryNames = [];
    const campaignSubcategoryTags = [];

    addId(campaignCategoryIds, campaign.categoryId);
    addText(campaignCategoryNames, campaign.campaignCategory);

    toArray(campaign.categories).forEach((item) => {
      addId(campaignCategoryIds, item?.categoryId);
      addText(campaignCategoryNames, item?.categoryName);
      addId(campaignSubcategoryIds, item?.subcategoryId);
      addText(campaignSubcategoryNames, item?.subcategoryName);
    });

    toArray(campaign.subcategoryIds).forEach((id) => {
      addId(campaignSubcategoryIds, id);
    });

    if (campaign.categoryId && isOid(String(campaign.categoryId))) {
      const categoryDoc = await Category.findById(campaign.categoryId)
        .select("_id name subcategories")
        .lean();

      if (categoryDoc) {
        addText(campaignCategoryNames, categoryDoc.name);

        const subMap = new Map(
          toArray(categoryDoc.subcategories).map((sub) => [
            String(sub?._id),
            sub,
          ])
        );

        campaignSubcategoryIds.forEach((subId) => {
          const sub = subMap.get(String(subId));

          if (sub) {
            addText(campaignSubcategoryNames, sub.name);
            toArray(sub.tags).forEach((tag) => addText(campaignSubcategoryTags, tag));
          }
        });
      }
    }

    const page1List = toArray(influencer.page1);
    const page1Primary =
      page1List.find((item) => item?.isPrimary) ||
      page1List[0] ||
      {};

    const page1Data = page1Primary?.data || {};
    const page1Profile = page1Data?.profile || {};
    const providerRaw = page1Data?.providerRaw || {};
    const providerRawProfileRoot = providerRaw?.profile || {};
    const providerRawProfile =
      providerRawProfileRoot?.profile ||
      providerRaw?.profile ||
      {};

    const influencerCategoryIds = [];
    const influencerCategoryNames = [];
    const influencerSubcategoryIds = [];
    const influencerSubcategoryNames = [];
    const influencerInterestNames = [];

    toArray(influencer.categories).forEach((item) => {
      if (typeof item === "string") {
        addText(influencerCategoryNames, item);
        addId(influencerCategoryIds, item);
        return;
      }

      addId(influencerCategoryIds, item?.categoryId || item?._id || item?.id);
      addText(influencerCategoryNames, item?.categoryName || item?.name || item?.title);

      addId(influencerSubcategoryIds, item?.subcategoryId);
      addText(influencerSubcategoryNames, item?.subcategoryName);
    });

    toArray(influencer.categoryIds).forEach((id) => {
      addId(influencerCategoryIds, id);
    });

    toArray(influencer?.onboarding?.subcategories).forEach((item) => {
      addId(influencerSubcategoryIds, item?.subcategoryId || item?._id || item?.id);
      addText(influencerSubcategoryNames, item?.subcategoryName || item?.name || item?.title);
    });

    if (influencer?.onboarding?.categoryId) {
      addId(influencerCategoryIds, influencer.onboarding.categoryId);
    }

    toArray(page1Data.categories).forEach((item) => {
      addId(influencerCategoryIds, item?.categoryId || item?._id || item?.id);
      addText(influencerCategoryNames, item?.categoryName || item?.name || item?.title);

      addId(influencerSubcategoryIds, item?.subcategoryId);
      addText(influencerSubcategoryNames, item?.subcategoryName);
    });

    toArray(providerRawProfileRoot.interests).forEach((item) => {
      addText(influencerInterestNames, item?.name || item?.title || item);
    });

    toArray(page1Data.hashtags).forEach((item) => {
      addText(influencerInterestNames, item?.name || item?.tag || item?.hashtag || item);
    });

    const socialProfiles = influencer.socialProfiles;

    if (Array.isArray(socialProfiles)) {
      socialProfiles.forEach((profile) => {
        toArray(profile?.categories).forEach((item) => {
          addId(influencerCategoryIds, item?.categoryId || item?._id || item?.id);
          addText(influencerCategoryNames, item?.categoryName || item?.name || item?.title);

          addId(influencerSubcategoryIds, item?.subcategoryId);
          addText(influencerSubcategoryNames, item?.subcategoryName);
        });
      });
    } else if (socialProfiles && typeof socialProfiles === "object") {
      Object.values(socialProfiles).forEach((profile) => {
        toArray(profile?.categories).forEach((item) => {
          addId(influencerCategoryIds, item?.categoryId || item?._id || item?.id);
          addText(influencerCategoryNames, item?.categoryName || item?.name || item?.title);

          addId(influencerSubcategoryIds, item?.subcategoryId);
          addText(influencerSubcategoryNames, item?.subcategoryName);
        });
      });
    }

    const categoryScore = scoreIdOrTextMatch({
      campaignIds: campaignCategoryIds,
      influencerIds: influencerCategoryIds,
      campaignTexts: campaignCategoryNames,
      influencerTexts: [
        ...influencerCategoryNames,
        ...influencerInterestNames,
      ],
    });

    const subcategoryScore = scoreIdOrTextMatch({
      campaignIds: campaignSubcategoryIds,
      influencerIds: influencerSubcategoryIds,
      campaignTexts: [
        ...campaignSubcategoryNames,
        ...campaignSubcategoryTags,
      ],
      influencerTexts: [
        ...influencerSubcategoryNames,
        ...influencerInterestNames,
        ...influencerCategoryNames,
      ],
    });

    const fixedCampaignPlatform = "youtube";

    const influencerPlatforms = uniq(
      [
        page1Primary?.platform,
        page1Data?.provider,
        page1Data?.platform,
        influencer.primaryPlatform,
        influencer.primaryProvider,
        ...(Array.isArray(socialProfiles)
          ? socialProfiles.map((item) => item?.provider || item?.platform)
          : socialProfiles && typeof socialProfiles === "object"
            ? Object.values(socialProfiles).map((item) => item?.provider || item?.platform)
            : []),
      ]
        .map(normalizePlatform)
        .filter(Boolean)
    );

    const platformScore =
      influencerPlatforms.length > 0
        ? influencerPlatforms.includes(fixedCampaignPlatform)
          ? 100
          : 0
        : null;

    const campaignCountryIds = uniq(
      toArray(campaign.targetCountryIds).map((id) => String(id || "").trim())
    );

    const campaignCountryDocs = campaignCountryIds.length
      ? await Country.find({
        _id: {
          $in: campaignCountryIds
            .filter((id) => isOid(id))
            .map((id) => toObjectId(id)),
        },
      })
        .select("_id countryNameEn countryNameLocal countryName name countryCode")
        .lean()
      : [];

    const campaignCountries = uniq(
      campaignCountryDocs.flatMap((country) => [
        country.countryNameEn,
        country.countryNameLocal,
        country.countryName,
        country.name,
        country.countryCode,
      ])
    );

    const influencerCountries = uniq([
      influencer.countryName,
      influencer.country?.name,
      influencer.country?.countryName,
      influencer.country?.countryNameEn,
      influencer.country?.countryCode,
      page1Data.country,
      providerRawProfileRoot.country,
      providerRawProfile.country,
    ]);

    const countryScore =
      campaignCountryIds.length || campaignCountries.length
        ? scoreTextMatch(campaignCountries, influencerCountries)
        : null;

    const campaignLanguageIds = uniq(
      toArray(campaign.contentLanguageIds).map((id) => String(id || "").trim())
    );

    const campaignLanguageDocs = campaignLanguageIds.length
      ? await ContentLanguage.find({
        _id: {
          $in: campaignLanguageIds
            .filter((id) => isOid(id))
            .map((id) => toObjectId(id)),
        },
      })
        .select("_id code name")
        .lean()
      : [];

    const campaignLanguages = uniq(
      campaignLanguageDocs.flatMap((lang) => [lang.name, lang.code])
    );

    const influencerLanguages = uniq([
      page1Data.language?.name,
      page1Data.language,
      providerRawProfileRoot.language?.name,
      providerRawProfileRoot.language,
      ...(Array.isArray(influencer.languages)
        ? influencer.languages.map((item) => item?.name || item?.code || item)
        : []),
      ...toArray(influencer.languageIds),
    ]);

    const languageScore =
      campaignLanguageIds.length || campaignLanguages.length
        ? scoreTextMatch(campaignLanguages, influencerLanguages)
        : null;

    const followers =
      Number(page1Profile.followers) ||
      Number(providerRawProfile.followers) ||
      Number(page1Data?.stats?.followers?.value) ||
      Number(influencer.followerCount) ||
      Number(influencer.audienceSize) ||
      0;

    const followerScore = scoreFollowers({
      followers,
      minFollowers: campaign.minFollowers,
      maxFollowers: campaign.maxFollowers,
    });

    const engagementRate =
      page1Profile.engagementRate ??
      providerRawProfile.engagementRate ??
      page1Data?.statsByContentType?.all?.engagementRate ??
      page1Data?.statsByContentType?.reels?.engagementRate ??
      influencer.engagementRate;

    const engagementScore = scoreEngagement(engagementRate);

    const criteria = [
      {
        key: "category",
        label: "Category Match",
        weight: 25,
        score: categoryScore,
        campaignValues: uniq(campaignCategoryNames),
        influencerValues: uniq([...influencerCategoryNames, ...influencerInterestNames]),
      },
      {
        key: "subcategory",
        label: "Subcategory Match",
        weight: 25,
        score: subcategoryScore,
        campaignValues: uniq([...campaignSubcategoryNames, ...campaignSubcategoryTags]),
        influencerValues: uniq([...influencerSubcategoryNames, ...influencerInterestNames]),
      },
      {
        key: "platform",
        label: "Platform Match",
        weight: 15,
        score: platformScore,
        campaignValues: campaignPlatforms,
        influencerValues: influencerPlatforms,
      },
      {
        key: "country",
        label: "Country Match",
        weight: 10,
        score: countryScore,
        campaignValues: campaignCountries,
        influencerValues: influencerCountries,
      },
      {
        key: "language",
        label: "Language Match",
        weight: 10,
        score: languageScore,
        campaignValues: campaignLanguages,
        influencerValues: influencerLanguages,
      },
      {
        key: "followers",
        label: "Follower Range Match",
        weight: 10,
        score: followerScore,
        campaignValues: [
          campaign.minFollowers ? `Min ${campaign.minFollowers}` : "",
          campaign.maxFollowers ? `Max ${campaign.maxFollowers}` : "",
        ].filter(Boolean),
        influencerValues: followers ? [`${followers}`] : [],
      },
      {
        key: "engagement",
        label: "Engagement Quality",
        weight: 5,
        score: engagementScore,
        campaignValues: ["Profile quality"],
        influencerValues: [
          Number.isFinite(getEngagementPercent(engagementRate))
            ? `${getEngagementPercent(engagementRate).toFixed(2)}%`
            : "",
        ].filter(Boolean),
      },
    ];

    const usedCriteria = criteria.filter((item) => item.score !== null);

    const totalWeight = usedCriteria.reduce(
      (sum, item) => sum + Number(item.weight || 0),
      0
    );

    const weightedScore = usedCriteria.reduce(
      (sum, item) => sum + Number(item.score || 0) * Number(item.weight || 0),
      0
    );

    const finalScore =
      totalWeight > 0 ? Math.round(weightedScore / totalWeight) : 0;

    const label =
      finalScore >= 80
        ? "High"
        : finalScore >= 60
          ? "Good"
          : finalScore >= 40
            ? "Average"
            : "Low";

    const breakdown = usedCriteria.reduce((acc, item) => {
      acc[item.key] = {
        label: item.label,
        weight: item.weight,
        score: item.score,
        weightedScore: Math.round((item.score * item.weight) / 100),
        campaignValues: item.campaignValues,
        influencerValues: item.influencerValues,
      };

      return acc;
    }, {});

    return ApiResponse.sendOk(
      res,
      HttpStatus.OK,
      {
        matchScore: finalScore,
        matchPercent: `${finalScore}%`,
        label,
        breakdown,
        criteria: usedCriteria,
        matched: {
          category:
            categoryScore > 0
              ? uniq(campaignCategoryNames).filter((item) =>
                scoreTextMatch([item], [...influencerCategoryNames, ...influencerInterestNames])
              )
              : [],
          subcategory:
            subcategoryScore > 0
              ? uniq(campaignSubcategoryNames).filter((item) =>
                scoreTextMatch([item], [...influencerSubcategoryNames, ...influencerInterestNames])
              )
              : [],
          platform: campaignPlatforms.filter((item) =>
            influencerPlatforms.includes(item)
          ),
        },
        source: {
          campaign: {
            id: String(campaign._id),
            campaignTitle: campaign.campaignTitle,
            categoryId: campaign.categoryId ? String(campaign.categoryId) : "",
            subcategoryIds: campaignSubcategoryIds,
            categoryNames: uniq(campaignCategoryNames),
            subcategoryNames: uniq(campaignSubcategoryNames),
            platforms: campaignPlatforms,
          },
          influencer: {
            id: String(influencer._id),
            influencerId: String(influencer.influencerId || influencer._id),
            name: influencer.name || page1Profile.fullname || "",
            handle: page1Primary.handle || page1Profile.username || "",
            categoryNames: uniq(influencerCategoryNames),
            subcategoryNames: uniq(influencerSubcategoryNames),
            interests: uniq(influencerInterestNames),
            platforms: influencerPlatforms,
            followers,
            engagementRate: Number.isFinite(getEngagementPercent(engagementRate))
              ? `${getEngagementPercent(engagementRate).toFixed(2)}%`
              : "N/A",
          },
        },
      },
      requestId
    );
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_INFLUENCER_MATCH_SCORE_ERROR");
    console.error("[getInfluencerMatchScore] Error:", err);
    return sendControllerError(res, requestId, err);
  }
};