"use strict";

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const {
  CONTRACT_STATUS,
  CONTRACT_STATUS_ENUM,
  PAYMENT_TYPE,
  PAYMENT_TYPE_VALUES,
  SIGNER_ROLES,
  normalizeContractStatus,
  normalizePaymentType,
} = require("../constants/contract");

const { Schema } = mongoose;
const WORKFLOW_SIGNERS = Object.freeze(["brand", "influencer"]);

const ContractAcceptanceSchema = new Schema(
  {
    accepted: { type: Boolean, default: false },
    acceptedVersion: { type: Number, default: 0 },
    at: { type: Date, default: null },
    byUserId: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const ContractSchema = new Schema(
  {
    contractId: {
      type: String,
      unique: true,
      index: true,
      trim: true,
      immutable: true,
    },

    brandId: { type: String, required: true, index: true, trim: true },
    influencerId: { type: String, required: true, index: true, trim: true },
    campaignId: { type: String, required: true, index: true, trim: true },

    brandPoc: { type: String, default: "", trim: true },
    brandPocDesignation: { type: String, default: "", trim: true },

    contractSource: {
      type: String,
      enum: ["template", "uploaded"],
      default: "template",
      index: true,
    },

    paymentType: {
      type: String,
      enum: PAYMENT_TYPE_VALUES,
      default: PAYMENT_TYPE.FIXED,
      index: true,
    },

    status: {
      type: String,
      enum: CONTRACT_STATUS_ENUM,
      default: CONTRACT_STATUS.DRAFT,
      index: true,
    },

    awaitingRole: {
      type: String,
      enum: ["brand", "influencer", "collabglam", "admin", "system", null],
      default: "influencer",
      index: true,
    },

    requiredSigners: {
      type: [String],
      default: () => [...WORKFLOW_SIGNERS],
    },

    version: { type: Number, default: 0, min: 0 },

    acceptances: {
      brand: { type: ContractAcceptanceSchema, default: () => ({}) },
      influencer: { type: ContractAcceptanceSchema, default: () => ({}) },
    },

    requestedEffectiveDate: { type: Date, default: null },
    requestedEffectiveDateTimezone: {
      type: String,
      default: "America/Los_Angeles",
      trim: true,
    },
    effectiveDate: { type: Date, default: null },
    effectiveDateOverride: { type: Date, default: null },
    effectiveDateTimezone: { type: String, default: "", trim: true },

    brandName: { type: String, default: "", trim: true },
    brandAddress: { type: String, default: "", trim: true },
    influencerName: { type: String, default: "", trim: true },
    influencerAddress: { type: String, default: "", trim: true },
    influencerHandle: { type: String, default: "", trim: true },

    feeAmount: { type: Number, default: 0 },
    currency: { type: String, default: "USD", trim: true },

    lastSentAt: { type: Date, default: null },
    lastViewedByBrandAt: { type: Date, default: null },
    lastViewedByInfluencerAt: { type: Date, default: null },

    editsLockedAt: { type: Date, default: null },
    lockedAt: { type: Date, default: null },

    lastActionAt: { type: Date, default: null },
    lastActionByRole: { type: String, default: "", trim: true },

    resendIteration: { type: Number, default: 0 },
    resendOf: { type: String, default: null, index: true },
    supersededBy: { type: String, default: null, index: true },
    resentAt: { type: Date, default: null },

    milestonesCreatedAt: { type: Date, default: null },

    isAssigned: { type: Number, default: 1 },
    isAccepted: { type: Number, default: 0 },
    isRejected: { type: Number, default: 0 },
    isFinalUpdate: { type: Boolean, default: false },

    statusFlags: {
      awaitingCollabglam: { type: Boolean, default: false },
      isRejected: { type: Boolean, default: false },
      isSuperseded: { type: Boolean, default: false },
    },
  },
  { timestamps: true, minimize: false }
);

ContractSchema.index({
  brandId: 1,
  influencerId: 1,
  campaignId: 1,
  createdAt: -1,
});
ContractSchema.index({ brandId: 1, status: 1, updatedAt: -1 });
ContractSchema.index({ influencerId: 1, status: 1, updatedAt: -1 });
ContractSchema.index({ campaignId: 1, status: 1 });
ContractSchema.index({ awaitingRole: 1, status: 1, updatedAt: -1 });

ContractSchema.pre("validate", function contractPreValidate(next) {
  if (!this.contractId) {
    this.contractId = uuidv4().replace(/-/g, "").slice(0, 16).toUpperCase();
  }

  this.status = normalizeContractStatus(this.status);
  this.paymentType = normalizePaymentType(this.paymentType);

  const roles = Array.isArray(this.requiredSigners) ? this.requiredSigners : [];

  this.requiredSigners = [
    ...new Set(
      roles
        .map((role) => String(role || "").trim().toLowerCase())
        .filter((role) => SIGNER_ROLES.includes(role))
    ),
  ];

  if (!this.requiredSigners.length) {
    this.requiredSigners = [...WORKFLOW_SIGNERS];
  }

  if (!this.currency) this.currency = "USD";

  next();
});

ContractSchema.methods.isLocked = function isLocked() {
  return Boolean(
    this.lockedAt ||
      this.status === CONTRACT_STATUS.CONTRACT_SIGNED ||
      this.status === CONTRACT_STATUS.MILESTONES_CREATED
  );
};

ContractSchema.statics.normalizeStatus = normalizeContractStatus;
ContractSchema.statics.normalizePaymentType = normalizePaymentType;
ContractSchema.statics.WORKFLOW_SIGNERS = WORKFLOW_SIGNERS;

module.exports =
  mongoose.models.Contract || mongoose.model("Contract", ContractSchema);