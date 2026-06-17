const mongoose = require("mongoose");
const { Schema } = mongoose;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const normalizePaymentType = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "milestone") return "Milestone";
  if (s === "fixed") return "Fixed";
  if (s === "gifting") return "Gifting";
  return "Milestone";
};

const actorSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["brand", "admin"],
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
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
    brandId: { type: Schema.Types.ObjectId, ref: "Brand", required: true, index: true },
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

    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null, index: true },
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

    // scheduling fields
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
      enum: ["draft", "scheduled", "active", "paused", "completed", "archived"],
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

    isActive: { type: Number, enum: [0, 1], default: 1, index: true },
    applicantCount: { type: Number, default: 0 },
    hasApplied: { type: Number, enum: [0, 1], default: 0 },
    isDraft: { type: Number, enum: [0, 1], default: 0, index: true },
    byAi: { type: Number, enum: [0, 1], default: 0, index: true },

    createdBy: { type: actorSchema, default: null },
    pendingUpdate: { type: pendingUpdateSchema, default: () => ({ status: "none" }) },
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

// validation: maxFollowers must be >= minFollowers
CampaignSchema.path("maxFollowers").validate(function (v) {
  return Number.isFinite(v) && Number.isFinite(this.minFollowers) && v >= this.minFollowers;
}, "maxFollowers must be >= minFollowers");

// TTL index: delete only when draftExpiresAt time is reached
CampaignSchema.index({ draftExpiresAt: 1 }, { expireAfterSeconds: 0 });

// existing indexes
CampaignSchema.index({ brandId: 1, createdAt: -1 });
CampaignSchema.index({ brandId: 1, status: 1 });
CampaignSchema.index({ brandId: 1, isDraft: 1, isActive: 1, createdAt: -1 });
CampaignSchema.index({ "pendingUpdate.status": 1, updatedAt: -1 });
CampaignSchema.index({ categoryId: 1, subcategoryIds: 1 });
CampaignSchema.index({ publishStatus: 1 });
CampaignSchema.index({ status: 1, isDraft: 1, isActive: 1 });

// schedule-related indexes
CampaignSchema.index({ status: 1, scheduledAt: 1 });
CampaignSchema.index({ status: 1, startAt: 1 });
CampaignSchema.index({ status: 1, endAt: 1 });
CampaignSchema.index({ brandId: 1, byAi: 1, createdAt: -1 });
CampaignSchema.index({ categoryId: 1, createdAt: -1 });

// auto set / unset draft expiry
CampaignSchema.pre("save", function (next) {
  if (this.status === "draft") {
    this.draftExpiresAt = new Date(Date.now() + THIRTY_DAYS_MS);
  } else {
    this.draftExpiresAt = undefined;
  }
  next();
});

CampaignSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate() || {};
  const status = update.status ?? (update.$set && update.$set.status);

  if (status === "draft") {
    update.$set = update.$set || {};
    update.$set.draftExpiresAt = new Date(Date.now() + THIRTY_DAYS_MS);
  } else if (status) {
    update.$unset = update.$unset || {};
    update.$unset.draftExpiresAt = 1;
  }

  this.setUpdate(update);
  next();
});

module.exports =
  mongoose.models.Campaign || mongoose.model("Campaign", CampaignSchema);