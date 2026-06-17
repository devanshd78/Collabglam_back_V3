"use strict";

const mongoose = require("mongoose");
const { Schema } = mongoose;

const ContractDocumentSchema = new Schema(
  {
    contractId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    timezone: { type: String, default: "America/Los_Angeles", trim: true },
    jurisdiction: { type: String, default: "USA", trim: true },
    arbitrationSeat: { type: String, default: "San Francisco, CA", trim: true },
    fxSource: { type: String, default: "ECB", trim: true },
    extraRevisionFee: { type: Number, default: 0 },
    escrowAMLFlags: { type: String, default: "", trim: true },
    collabglamSignatoryName: { type: String, default: "", trim: true },
    collabglamSignatoryEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    legalTemplateVersion: { type: Number, default: 1 },
    legalTemplateText: { type: String, default: "" },
    legalTemplateHistory: {
      type: [
        new Schema(
          {
            version: Number,
            text: String,
            updatedAt: Date,
            updatedBy: String,
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    documentSource: {
      type: String,
      enum: ["template", "uploaded"],
      default: "template",
      index: true,
    },

    uploadedContract: {
      originalName: { type: String, default: "", trim: true },

      bucket: {
        type: String,
        default: "collabglam-campaign",
        trim: true,
      },

      folder: {
        type: String,
        default: "collabglam-contract",
        trim: true,
      },

      key: { type: String, default: "", trim: true },

      mimeType: { type: String, default: "application/pdf", trim: true },
      sizeBytes: { type: Number, default: 0 },

      uploadedBy: { type: String, default: "", trim: true },
      uploadedAt: { type: Date, default: null },
    },

    acknowledgement: {
      version: { type: Number, default: 1 },
      title: {
        type: String,
        default: "CollabGlam Uploaded Contract Acknowledgement",
        trim: true,
      },
      text: { type: String, default: "" },
      appliesToUploadedContract: { type: Boolean, default: false },
    },

    templateTokensSnapshot: { type: Schema.Types.Mixed, default: null },
    renderedTextSnapshot: { type: String, default: "" },
    renderedHtmlSnapshot: { type: String, default: "" },

    pdfUrl: { type: String, default: "", trim: true },

    frozenAt: { type: Date, default: null },
    frozenByRole: { type: String, default: "system", trim: true },
  },
  { timestamps: true, minimize: false }
);

ContractDocumentSchema.methods.toLegacyAdmin = function toLegacyAdmin() {
  return {
    timezone: this.timezone,
    jurisdiction: this.jurisdiction,
    arbitrationSeat: this.arbitrationSeat,
    fxSource: this.fxSource,
    extraRevisionFee: this.extraRevisionFee,
    escrowAMLFlags: this.escrowAMLFlags,
    collabglamSignatoryName: this.collabglamSignatoryName,
    collabglamSignatoryEmail: this.collabglamSignatoryEmail,
    legalTemplateVersion: this.legalTemplateVersion,
    legalTemplateText: this.legalTemplateText,
    legalTemplateHistory: this.legalTemplateHistory || [],

    documentSource: this.documentSource,

    uploadedContract:
      this.documentSource === "uploaded"
        ? {
            originalName: this.uploadedContract?.originalName || "",
            bucket: this.uploadedContract?.bucket || "",
            folder: this.uploadedContract?.folder || "",
            key: this.uploadedContract?.key || "",
            mimeType: this.uploadedContract?.mimeType || "",
            sizeBytes: this.uploadedContract?.sizeBytes || 0,
            uploadedAt: this.uploadedContract?.uploadedAt || null,
          }
        : null,

    acknowledgement:
      this.documentSource === "uploaded" ? this.acknowledgement || null : null,
  };
};

module.exports =
  mongoose.models.ContractDocument ||
  mongoose.model("ContractDocument", ContractDocumentSchema);