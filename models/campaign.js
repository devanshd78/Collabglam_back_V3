const mongoose = require("mongoose");

const { Schema } = mongoose;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const LIFECYCLE_SYNC_INTERVAL_MS = 30 * 1000;

let lifecycleSyncPromise = null;
let lastLifecycleSyncAt = 0;

const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "active",
  "paused",
  "completed",
  "archived",
];

const FINAL_OR_MANUAL_STATUSES = new Set([
  "draft",
  "paused",
  "completed",
  "archived",
]);

const normalizePaymentType = (v) => {
  const s = String(v ?? "").trim().toLowerCase();

  if (s === "milestone") return "Milestone";
  if (s === "fixed") return "Fixed";
  if (s === "gifting") return "Gifting";

  return "Milestone";
};

const getValidDate = (value) => {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const getNested = (obj, path) => {
  return String(path)
    .split(".")
    .reduce((acc, key) => (acc ? acc[key] : undefined), obj);
};

const getCampaignStartDate = (campaign = {}) => {
  return (
    getValidDate(campaign.startAt) ||
    getValidDate(campaign.timeline?.startDate)
  );
};

const getCampaignEndDate = (campaign = {}) => {
  return (
    getValidDate(campaign.endAt) ||
    getValidDate(campaign.timeline?.endDate)
  );
};

const getCampaignActivationDate = (campaign = {}) => {
  return (
    getValidDate(campaign.scheduledAt) ||
    getCampaignStartDate(campaign)
  );
};

const getLifecycleStatus = (campaign = {}, now = new Date()) => {
  const currentStatus = String(campaign.status || "draft");

  if (!CAMPAIGN_STATUSES.includes(currentStatus)) {
    return "draft";
  }

  if (FINAL_OR_MANUAL_STATUSES.has(currentStatus)) {
    return currentStatus;
  }

  const endDate = getCampaignEndDate(campaign);

  if (endDate && endDate.getTime() <= now.getTime()) {
    return "completed";
  }

  if (currentStatus === "scheduled") {
    const activationDate = getCampaignActivationDate(campaign);

    if (activationDate && activationDate.getTime() <= now.getTime()) {
      return "active";
    }

    return "scheduled";
  }

  return currentStatus;
};

const applyLifecycleFields = (campaign, now = new Date()) => {
  const previousStatus = String(campaign.status || "");
  const nextStatus = getLifecycleStatus(campaign, now);

  campaign.status = nextStatus;
  campaign.isDraft = nextStatus === "draft" ? 1 : 0;
  campaign.isActive = nextStatus === "active" ? 1 : 0;
  campaign.publishStatus = nextStatus === "draft" ? "draft" : "published";

  if (previousStatus !== nextStatus || !campaign.statusUpdatedAt) {
    campaign.statusUpdatedAt = now;
  }

  if (nextStatus === "completed" && !campaign.endedAt) {
    campaign.endedAt = now;
  }

  if (nextStatus === "active" && !campaign.publishedAt) {
    campaign.publishedAt = now;
  }

  if (nextStatus === "active") {
    campaign.scheduledAt = undefined;
    campaign.scheduledLocation = undefined;
  }

  return campaign;
};

const getUpdateValue = (update = {}, key) => {
  if (Object.prototype.hasOwnProperty.call(update, key)) {
    return update[key];
  }

  if (Object.prototype.hasOwnProperty.call(update.$set || {}, key)) {
    return update.$set[key];
  }

  const nestedFromRoot = getNested(update, key);
  if (nestedFromRoot !== undefined) return nestedFromRoot;

  const nestedFromSet = getNested(update.$set || {}, key);
  if (nestedFromSet !== undefined) return nestedFromSet;

  return undefined;
};

const moveDirectUpdateFieldToSet = (update, key) => {
  if (!Object.prototype.hasOwnProperty.call(update, key)) return;

  update.$set = update.$set || {};
  update.$set[key] = update[key];
  delete update[key];
};

const actorSchema = new Schema(
  {
    role: {
      type: String,
      enum: ["brand", "admin"],
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      refPath: "userModel",
    },
    userModel: {
      type: String,
      enum: ["Brand", "Master"],
      required: true,
    },
    email: { type: String, default: "" },
    name: { type: String, default: "" },
    adminRole: { type: String, default: "" },
  },
  { _id: false }
);

actorSchema.pre("validate", function (next) {
  if (this.role === "brand") {
    this.userModel = "Brand";
    this.email = undefined;
    this.name = undefined;
    this.adminRole = undefined;
  }

  if (this.role === "admin") {
    this.userModel = "Master";
  }

  next();
});

const pendingUpdateSchema = new Schema(
  {
    status: {
      type: String,
      enum: ["none", "pending", "approved", "rejected"],
      default: "none",
      index: true,
    },
    patch: { type: Schema.Types.Mixed, default: null },
    updatedBy: { type: actorSchema, default: null },
    updatedAt: { type: Date, default: null },
    reviewedBy: { type: actorSchema, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: "" },
  },
  { _id: false }
);

const locationSchema = new Schema(
  {
    ip: { type: String, trim: true, default: "" },
    timezone: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    source: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const timelineSchema = new Schema(
  {
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
  },
  { _id: false }
);

const categoryPairSchema = new Schema(
  {
    categoryId: { type: String, default: "" },
    categoryName: { type: String, default: "" },
    subcategoryId: { type: String, default: "" },
    subcategoryName: { type: String, default: "" },
  },
  { _id: false }
);

const CampaignSchema = new Schema(
  {
    brandId: {
      type: Schema.Types.ObjectId,
      ref: "Brand",
      required: true,
      index: true,
    },
    brandName: { type: String, trim: true, default: "" },

    brandSubscriptionSnapshot: {
      planId: { type: String, trim: true, default: "" },
      planName: { type: String, trim: true, default: "" },
      status: { type: String, trim: true, default: "" },
      startedAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      wasFullyManaged: { type: Boolean, default: false, index: true },
    },

    brandWasFullyManagedAtCreation: {
      type: Boolean,
      default: false,
      index: true,
    },

    isFullyManaged: {
      type: Boolean,
      default: false,
      index: true,
    },

    managementType: {
      type: String,
      enum: ["self_serve", "fully_managed"],
      default: "self_serve",
      index: true,
    },

    campaignTitle: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    campaignType: { type: String, trim: true, default: "" },

    campaignCategory: { type: String, trim: true, default: "" },
    campaignSubcategory: { type: String, trim: true, default: "" },

    categoryId: {
      type: Schema.Types.ObjectId,
      ref: "Category",
      default: null,
      index: true,
    },
    subcategoryIds: [{ type: Schema.Types.ObjectId }],

    productImages: { type: [Schema.Types.Mixed], default: [] },
    productLink: { type: String, trim: true, default: "" },
    videoLink: { type: String, trim: true, default: "" },
    productServiceInfo: { type: [Schema.Types.Mixed], default: [] },

    campaignGoals: [{ type: Schema.Types.ObjectId, ref: "ProductServiceGoal" }],
    influencerTierIds: [{ type: Schema.Types.ObjectId, ref: "InfluencerTier" }],
    contentFormats: [{ type: Schema.Types.ObjectId, ref: "ContentFormat" }],
    contentLanguageIds: [{ type: Schema.Types.ObjectId, ref: "ContentLanguage" }],
    preferredHashtags: [{ type: Schema.Types.ObjectId, ref: "PreferredHashtag" }],
    targetCountryIds: [{ type: Schema.Types.ObjectId, ref: "Country" }],
    targetAgeRanges: [{ type: Schema.Types.ObjectId, ref: "AgeRange" }],

    numberOfInfluencers: { type: Number, default: 1, min: 1 },
    influencerTier: { type: String, trim: true, default: "" },

    minFollowers: { type: Number, default: 0, min: 0 },
    maxFollowers: { type: Number, default: 0, min: 0 },

    creatorContentLanguage: { type: String, trim: true, default: "" },
    audienceContentLanguage: { type: String, trim: true, default: "" },
    targetCountry: { type: String, trim: true, default: "" },

    campaignBudget: { type: Number, default: 0, min: 0 },
    budget: { type: Number, default: 0, min: 0 },
    influencerBudget: { type: Number, default: 0, min: 0 },

    paymentType: {
      type: String,
      trim: true,
      enum: ["Milestone", "Fixed", "Gifting"],
      default: "Milestone",
      set: normalizePaymentType,
    },

    additionalNotes: { type: String, trim: true, default: "" },
    hashtags: { type: [String], default: [] },

    campaignTimezone: { type: String, trim: true, default: "UTC" },

    scheduledAt: { type: Date, default: null, index: true },
    startAt: { type: Date, default: null, index: true },
    endAt: { type: Date, default: null, index: true },
    publishedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },

    createdLocation: { type: locationSchema, default: null },
    scheduledLocation: { type: locationSchema, default: null },

    draftExpiresAt: { type: Date, default: null, index: true },

    timeline: { type: timelineSchema, default: () => ({}) },
    categories: { type: [categoryPairSchema], default: [] },

    status: {
      type: String,
      enum: CAMPAIGN_STATUSES,
      default: "draft",
      index: true,
    },

    publishStatus: {
      type: String,
      enum: ["draft", "published"],
      default: "draft",
      index: true,
    },

    approvalMode: {
      type: String,
      enum: ["direct", "admin_review"],
      default: "direct",
      index: true,
    },

    statusUpdatedAt: { type: Date, default: Date.now },
    pausedAt: { type: Date, default: null },

    isActive: { type: Number, enum: [0, 1], default: 0, index: true },
    applicantCount: { type: Number, default: 0 },
    hasApplied: { type: Number, enum: [0, 1], default: 0 },
    isDraft: { type: Number, enum: [0, 1], default: 0, index: true },
    byAi: { type: Number, enum: [0, 1], default: 0, index: true },

    createdBy: { type: actorSchema, default: null },
    pendingUpdate: {
      type: pendingUpdateSchema,
      default: () => ({ status: "none" }),
    },

    isPublic: { type: Boolean, default: false },

    publicShareToken: {
      type: String,
      default: null,
      unique: true,
      sparse: true,
      index: true,
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

CampaignSchema.path("maxFollowers").validate(function (v) {
  return (
    Number.isFinite(v) &&
    Number.isFinite(this.minFollowers) &&
    v >= this.minFollowers
  );
}, "maxFollowers must be >= minFollowers");

CampaignSchema.index({ draftExpiresAt: 1 }, { expireAfterSeconds: 0 });

CampaignSchema.index({ brandId: 1, createdAt: -1 });
CampaignSchema.index({ brandId: 1, status: 1 });
CampaignSchema.index({ brandId: 1, isDraft: 1, isActive: 1, createdAt: -1 });
CampaignSchema.index({ "pendingUpdate.status": 1, updatedAt: -1 });
CampaignSchema.index({ categoryId: 1, subcategoryIds: 1 });
CampaignSchema.index({ publishStatus: 1 });
CampaignSchema.index({ status: 1, isDraft: 1, isActive: 1 });

CampaignSchema.index({ status: 1, scheduledAt: 1 });
CampaignSchema.index({ status: 1, startAt: 1 });
CampaignSchema.index({ status: 1, endAt: 1 });
CampaignSchema.index({ status: 1, "timeline.startDate": 1 });
CampaignSchema.index({ status: 1, "timeline.endDate": 1 });

CampaignSchema.index({ brandId: 1, byAi: 1, createdAt: -1 });
CampaignSchema.index({ categoryId: 1, createdAt: -1 });

CampaignSchema.statics.syncLifecycleStatuses = async function syncLifecycleStatuses() {
  const now = new Date();

  const expiredResult = await this.updateMany(
    {
      status: { $in: ["active", "scheduled"] },
      $or: [
        { endAt: { $lte: now } },
        { "timeline.endDate": { $lte: now } },
      ],
    },
    {
      $set: {
        status: "completed",
        isActive: 0,
        isDraft: 0,
        publishStatus: "published",
        endedAt: now,
        statusUpdatedAt: now,
      },
    },
    {
      skipLifecycleMiddleware: true,
      skipLifecycleSync: true,
    }
  );

  const activateResult = await this.updateMany(
    {
      status: "scheduled",
      $or: [
        { scheduledAt: { $lte: now } },
        { startAt: { $lte: now } },
        { "timeline.startDate": { $lte: now } },
      ],
      $and: [
        {
          $or: [
            { endAt: { $exists: false } },
            { endAt: null },
            { endAt: { $gt: now } },
            { "timeline.endDate": { $gt: now } },
          ],
        },
      ],
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
        scheduledAt: 1,
        scheduledLocation: 1,
        draftExpiresAt: 1,
      },
    },
    {
      skipLifecycleMiddleware: true,
      skipLifecycleSync: true,
    }
  );

  return {
    expiredModified:
      expiredResult.modifiedCount ?? expiredResult.nModified ?? 0,
    activatedModified:
      activateResult.modifiedCount ?? activateResult.nModified ?? 0,
  };
};

CampaignSchema.statics.maybeSyncLifecycleStatuses =
  async function maybeSyncLifecycleStatuses(options = {}) {
    const force = Boolean(options.force);
    const nowMs = Date.now();

    if (
      !force &&
      nowMs - lastLifecycleSyncAt < LIFECYCLE_SYNC_INTERVAL_MS
    ) {
      return null;
    }

    if (lifecycleSyncPromise) {
      return lifecycleSyncPromise;
    }

    lifecycleSyncPromise = this.syncLifecycleStatuses()
      .then((result) => {
        lastLifecycleSyncAt = Date.now();
        return result;
      })
      .finally(() => {
        lifecycleSyncPromise = null;
      });

    return lifecycleSyncPromise;
  };

CampaignSchema.pre("save", function preSaveCampaign(next) {
  const now = new Date();

  applyLifecycleFields(this, now);

  if (this.status === "draft") {
    this.draftExpiresAt = new Date(now.getTime() + THIRTY_DAYS_MS);
  } else {
    this.draftExpiresAt = undefined;
  }

  next();
});

CampaignSchema.pre(
  ["findOneAndUpdate", "updateOne", "updateMany"],
  function preUpdateCampaign(next) {
    const options = this.getOptions?.() || {};

    if (options.skipLifecycleMiddleware) {
      return next();
    }

    const update = this.getUpdate() || {};
    const now = new Date();

    update.$set = update.$set || {};

    [
      "status",
      "scheduledAt",
      "startAt",
      "endAt",
      "publishedAt",
      "endedAt",
      "draftExpiresAt",
      "timeline",
      "timeline.startDate",
      "timeline.endDate",
    ].forEach((key) => moveDirectUpdateFieldToSet(update, key));

    const candidate = {
      status: getUpdateValue(update, "status"),
      scheduledAt: getUpdateValue(update, "scheduledAt"),
      startAt: getUpdateValue(update, "startAt"),
      endAt: getUpdateValue(update, "endAt"),
      timeline: {
        startDate: getUpdateValue(update, "timeline.startDate"),
        endDate: getUpdateValue(update, "timeline.endDate"),
      },
    };

    const hasStatusInUpdate = candidate.status !== undefined;
    const hasTimingInUpdate =
      candidate.scheduledAt !== undefined ||
      candidate.startAt !== undefined ||
      candidate.endAt !== undefined ||
      candidate.timeline.startDate !== undefined ||
      candidate.timeline.endDate !== undefined;

    if (hasStatusInUpdate) {
      const finalStatus = getLifecycleStatus(candidate, now);

      update.$set.status = finalStatus;
      update.$set.isDraft = finalStatus === "draft" ? 1 : 0;
      update.$set.isActive = finalStatus === "active" ? 1 : 0;
      update.$set.publishStatus =
        finalStatus === "draft" ? "draft" : "published";
      update.$set.statusUpdatedAt = now;

      if (finalStatus === "completed") {
        update.$set.endedAt = update.$set.endedAt || now;
      }

      if (finalStatus === "active") {
        update.$set.publishedAt = update.$set.publishedAt || now;

        update.$unset = update.$unset || {};
        update.$unset.scheduledAt = 1;
        update.$unset.scheduledLocation = 1;
      }

      if (finalStatus === "draft") {
        update.$set.draftExpiresAt = new Date(
          now.getTime() + THIRTY_DAYS_MS
        );
      } else {
        update.$unset = update.$unset || {};
        update.$unset.draftExpiresAt = 1;
      }
    } else if (hasTimingInUpdate) {
      const endDate = getCampaignEndDate(candidate);

      if (endDate && endDate.getTime() <= now.getTime()) {
        update.$set.status = "completed";
        update.$set.isActive = 0;
        update.$set.isDraft = 0;
        update.$set.publishStatus = "published";
        update.$set.endedAt = update.$set.endedAt || now;
        update.$set.statusUpdatedAt = now;

        update.$unset = update.$unset || {};
        update.$unset.draftExpiresAt = 1;
      }
    }

    if (!Object.keys(update.$set).length) {
      delete update.$set;
    }

    if (update.$unset && !Object.keys(update.$unset).length) {
      delete update.$unset;
    }

    this.setUpdate(update);
    return next();
  }
);

CampaignSchema.pre(/^find/, async function preFindCampaign(next) {
  const options = this.getOptions?.() || {};

  if (options.skipLifecycleSync) {
    return next();
  }

  try {
    await this.model.maybeSyncLifecycleStatuses();
    return next();
  } catch (err) {
    return next(err);
  }
});

module.exports =
  mongoose.models.Campaign || mongoose.model("Campaign", CampaignSchema);