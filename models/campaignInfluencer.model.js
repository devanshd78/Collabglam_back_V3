'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const CampaignInfluencerSchema = new Schema(
  {
    platform: {
      type: String,
      default: 'youtube',
      index: true,
    },

    channelId: {
      type: String,
      required: true,
      trim: true,
      index: true,
      unique: true,
    },

    channelUrl: String,
    channelName: String,
    thumbnail: String,

    // Same creator can be recommended for multiple campaigns.
    // Keep campaign ids as an array and append new ids with $addToSet.
    campaignIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Campaign',
        index: true,
      },
    ],

    brandIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Brand',
        index: true,
      },
    ],

    creatorSnapshot: {
      subscribers: Number,
      creatorTier: String,
      category: String,
      country: String,
      estimatedAudienceCountry: String,
      primaryLanguage: String,
      totalViews: Number,
      totalVideos: Number,
      avgViews: Number,
      avgLikes: Number,
      avgComments: Number,
      engagementRate: Number,
      recentUploadDate: Date,
      description: String,
    },

    scores: {
      recommendationScore: Number,
      campaignFitScore: Number,
      relevancyScore: Number,
      engagementScore: Number,
      sponsorshipScore: Number,
      brandSafetyScore: Number,
      authenticityScore: Number,
      audienceCountryConfidence: Number,
      nicheFit: Number,
    },

    recommendationReason: String,

    // One creator can have a separate recommendation context per campaign.
    campaignContexts: [
      {
        campaignId: {
          type: Schema.Types.ObjectId,
          ref: 'Campaign',
          index: true,
        },
        brandId: {
          type: Schema.Types.ObjectId,
          ref: 'Brand',
          index: true,
        },
        campaignTitle: String,
        campaignDescription: String,
        campaignBudget: Number,
        paymentType: String,
        targetCountry: String,
        requestedTier: String,
        contentFormats: [String],
        campaignGoals: [String],
        targetAgeRanges: [String],
        matchedKeyword: String,
        matchedCategory: String,
        sourceVideoTitle: String,
        sourceVideoUrl: String,
        foundViaQuery: String,
        recommendationScore: Number,
        recommendationReason: String,
        matchedAt: Date,
      },
    ],

    contact: {
      hasContactInfo: Boolean,
      maskedEmail: String,
      website: String,
      socialLinks: [
        {
          platform: String,
          url: String,
        },
      ],
    },

    rawYouTubeDataId: {
      type: Schema.Types.ObjectId,
      ref: 'YouTubeData',
    },

    lastRecommendedAt: Date,
  },
  {
    timestamps: true,
    strict: false,
  }
);

CampaignInfluencerSchema.index({ channelId: 1 }, { unique: true });
CampaignInfluencerSchema.index({ campaignIds: 1, platform: 1 });
CampaignInfluencerSchema.index({ brandIds: 1, platform: 1 });
CampaignInfluencerSchema.index({ 'scores.recommendationScore': -1 });

module.exports =
  mongoose.models.CampaignInfluencer ||
  mongoose.model('CampaignInfluencer', CampaignInfluencerSchema);