'use strict';

const mongoose = require('mongoose');

const InfoMediaKitSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      default: 'youtube',
      index: true,
    },
    channelId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    channelName: {
      type: String,
      default: '',
      trim: true,
    },
    channelUrl: {
      type: String,
      default: '',
      trim: true,
    },
    thumbnail: {
      type: String,
      default: '',
      trim: true,
    },
    country: {
      type: String,
      default: '',
      trim: true,
    },
    estimatedAudienceCountry: {
      type: String,
      default: '',
      trim: true,
    },
    creatorTier: {
      type: String,
      default: '',
      trim: true,
    },
    subscribers: {
      type: Number,
      default: 0,
    },
    // Store creator email at top-level so it is visible directly in the infomediakit table.
    // This is the original email. Frontend is responsible for masking before display.
    email: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    emails: {
      type: [String],
      default: [],
    },
    website: {
      type: String,
      default: '',
      trim: true,
    },
    socialLinks: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    mediaKitData: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    rawCreatorSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    openCount: {
      type: Number,
      default: 0,
    },
    lastOpenedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'infomediakit',
    strict: false,
  }
);

InfoMediaKitSchema.index({ platform: 1, channelId: 1 });
InfoMediaKitSchema.index({ email: 1 });
InfoMediaKitSchema.index({ channelName: 'text' });

module.exports =
  mongoose.models.InfoMediaKit || mongoose.model('InfoMediaKit', InfoMediaKitSchema);