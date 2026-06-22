"use strict";

const mongoose = require("mongoose");

const Invitation = require("../models/NewInvitations");
const MissingEmail = require("../models/MissingEmail");
const Campaign = require("../models/campaign");
const { InfluencerModel } = require("../models/influencer");
const { EmailThread, EmailMessage } = require("../models/email");
const Brand = require("../models/brand");
const InfoMediaKit = require("../models/infoMediaKit.model");

const {
  sendEmail,
  cleanEmail,
  cleanStr,
} = require("../services/email/invitationEmailService");

const saveErrorLog = require("../services/errorLog.service");

const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;
const EMAIL_RX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

const PLATFORM_ENUM = new Set(["youtube"]);
const STATUS_ENUM = new Set(["invited", "available"]);

const isObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(String(value || ""));

function normalizeObjectId(value) {
  const id = String(value || "").trim();
  return isObjectId(id) ? id : "";
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(String(value));
}

function toPlainId(value) {
  if (!value) return null;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

function getInvitationChannelId(doc = {}) {
  const directChannelId = String(doc.channelId || "").trim();
  if (directChannelId) return directChannelId;

  const platform = String(doc.platform || "").trim().toLowerCase();
  const userId = String(doc.userId || "").trim();

  // In old invitation rows, YouTube channelId is stored in userId.
  if (platform === "youtube" && userId) return userId;

  return "";
}

function normalizeHandle(value) {
  if (!value) return "";
  const text = String(value).trim().toLowerCase();
  return text.startsWith("@") ? text : `@${text}`;
}

function normalizePlatform(value) {
  const platform = String(value || "youtube").trim().toLowerCase();

  if (!platform || platform === "yt" || platform === "youtube") {
    return "youtube";
  }

  return "";
}

function normalizeInfluencerUserId(body = {}) {
  return (
    String(
      body.userId ||
      body.influencerUserId ||
      body.creatorId ||
      body.influencerId ||
      ""
    ).trim() || null
  );
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getHeaderValue(headers = {}, keys = []) {
  for (const key of keys) {
    const value = headers[key] || headers[String(key).toLowerCase()];
    if (value) return String(value).trim();
  }

  return "";
}

function getRequestChannelId(req = {}) {
  const body = req.body || {};
  const headers = req.headers || {};

  return (
    String(
      body.channelId ||
      body.youtubeChannelId ||
      body.youtube?.channelId ||
      body.creator?.channelId ||
      body.influencer?.channelId ||
      getHeaderValue(headers, [
        "channelid",
        "channelId",
        "channel-id",
        "x-channel-id",
        "youtube-channel-id",
        "x-youtube-channel-id",
      ]) ||
      ""
    ).trim() || null
  );
}

function normalizeCampaignIds(body = {}) {
  const rawCampaignIds = Array.isArray(body.campaignIds)
    ? body.campaignIds
    : Array.isArray(body.campaignId)
      ? body.campaignId
      : [body.campaignId];

  return [
    ...new Set(
      rawCampaignIds.map((id) => normalizeObjectId(id)).filter(Boolean)
    ),
  ];
}

function normalizeEmailText(value = "") {
  return String(value || "")
    .replace(/\s*(\[|\()?at(\]|\))?\s*/gi, "@")
    .replace(/\s*(\[|\()?dot(\]|\))?\s*/gi, ".");
}

function extractEmailFromText(value = "") {
  const normalized = normalizeEmailText(value);
  const match = normalized.match(EMAIL_RX);
  return match ? cleanEmail(match[0]) : null;
}

function getFirstDirectEmail(...values) {
  for (const value of values) {
    const email = cleanEmail(value);
    if (email) return email;
  }

  return null;
}

function getDirectEmailFromMixedValue(value, depth = 0) {
  if (!value || depth > 4) return null;

  if (typeof value === "string") {
    return extractEmailFromText(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const email = getDirectEmailFromMixedValue(item, depth + 1);
      if (email) return email;
    }

    return null;
  }

  if (typeof value === "object") {
    const directEmail = getFirstDirectEmail(
      value.email,
      value.businessEmail,
      value.contactEmail,
      value.emailAddress,
      value.proxyEmail,
      value.value
    );

    if (directEmail) return directEmail;

    for (const item of Object.values(value)) {
      const email = getDirectEmailFromMixedValue(item, depth + 1);
      if (email) return email;
    }
  }

  return null;
}

function toEmailArray(input) {
  if (Array.isArray(input)) {
    return input.map((item) => cleanEmail(item)).filter(Boolean);
  }

  if (typeof input === "string") {
    return input.split(",").map((item) => cleanEmail(item)).filter(Boolean);
  }

  const email = cleanEmail(input);
  return email ? [email] : [];
}

function uniqueEmails(values) {
  return [...new Set(values.map((item) => cleanEmail(item)).filter(Boolean))];
}

function normalizeEmailTemplate(body = {}, { brand, fallbackSubject = "" } = {}) {
  const template = body.emailTemplate || body.email || {};

  const subject = cleanStr(
    template.subject ||
    body.subject ||
    body.emailSubject ||
    fallbackSubject ||
    ""
  );

  const text = String(
    template.textBody ||
    template.body ||
    body.textBody ||
    body.body ||
    body.emailBody ||
    ""
  ).trim();

  const html = String(
    template.htmlBody ||
    body.htmlBody ||
    body.emailHtmlBody ||
    ""
  ).trim();

  const fromEmail = cleanEmail(
    template.fromEmail ||
    template.from ||
    body.fromEmail ||
    body.emailFrom ||
    brand?.proxyEmail
  );

  const replyTo = fromEmail ? [fromEmail] : [];
  const cc = toEmailArray(template.cc || body.cc);
  const bcc = toEmailArray(template.bcc || body.bcc);

  const rawAttachments =
    template.attachments || body.emailAttachments || body.attachments || [];

  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments
      .filter((file) => file?.filename && (file?.contentBase64 || file?.content))
      .map((file) => ({
        filename: cleanStr(file.filename),
        contentType:
          file.contentType || file.mimeType || "application/octet-stream",
        content: String(file.contentBase64 || file.content || "").replace(
          /^data:.*;base64,/,
          ""
        ),
        encoding: "base64",
      }))
    : [];

  if (!fromEmail) {
    return {
      error:
        "Brand proxyEmail or emailTemplate.fromEmail is required to send invitation email.",
    };
  }

  if (!subject || (!text && !html)) {
    return {
      error: "Email subject and body are required.",
    };
  }

  return {
    from: fromEmail,
    subject,
    text,
    html,
    cc,
    bcc,
    replyTo,
    attachments,
  };
}

function normalizeAiScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function getCampaignName(campaign, fallback = "") {
  return cleanStr(
    fallback ||
    campaign?.campaignTitle ||
    campaign?.campaignName ||
    campaign?.title ||
    ""
  );
}

function getEmailFromInfoMediaKitDoc(info = {}) {
  if (!info || typeof info !== "object") return null;

  const directEmail = getFirstDirectEmail(info.email, ...(info.emails || []));
  if (directEmail) return directEmail;

  return (
    getDirectEmailFromMixedValue(info.mediaKitData) ||
    getDirectEmailFromMixedValue(info.rawCreatorSnapshot) ||
    getDirectEmailFromMixedValue(info.socialLinks)
  );
}

async function findEmailInInfoMediaKit({ channelId }) {
  const normalizedChannelId = String(channelId || "").trim();

  if (!normalizedChannelId) {
    return {
      email: null,
      source: "missing_channel_id",
      doc: null,
    };
  }

  const info = await InfoMediaKit.findOne({
    channelId: normalizedChannelId,
    platform: /^youtube$/i,
  }).lean();

  if (!info) {
    return {
      email: null,
      source: "infomediakit_not_found",
      doc: null,
    };
  }

  const email = getEmailFromInfoMediaKitDoc(info);

  return {
    email,
    source: email ? "infomediakit" : "infomediakit_no_email",
    doc: info,
  };
}

async function resolveCreatorEmail({ channelId }) {
  return findEmailInInfoMediaKit({ channelId });
}

async function getBrandByMongoId(brandId) {
  if (!isObjectId(brandId)) return null;
  return Brand.findById(brandId).lean();
}

function buildMissingEmailCampaignSnapshot({
  brandId,
  campaignId,
  campaign,
  campaignName,
  handle,
  platform = "youtube",
  channelId,
}) {
  if (!campaignId) return null;

  return {
    brandId: String(brandId || ""),
    campaignId: String(campaignId || ""),
    campaignName: getCampaignName(campaign, campaignName),
    handle: normalizeHandle(handle),
    platform: normalizePlatform(platform) || "youtube",
    channelId: String(channelId || "").trim() || null,
    requestedAt: new Date(),
  };
}

async function ensureMissingEmailRecord({
  handle,
  platform = "youtube",
  channelId,
  email,
  brandId,
  campaignId,
  campaignName,
  campaign,
  createdByAdminId,
}) {
  const normalizedHandle = normalizeHandle(handle);
  const normalizedPlatform = normalizePlatform(platform) || "youtube";
  const normalizedChannelId = String(channelId || "").trim();
  const cleanedEmail = cleanEmail(email);

  if (!HANDLE_RX.test(normalizedHandle)) return null;
  if (normalizedPlatform !== "youtube") return null;

  const identityOr = [
    {
      handle: normalizedHandle,
      platform: normalizedPlatform,
    },
  ];

  if (normalizedChannelId) {
    identityOr.push({
      channelId: normalizedChannelId,
      platform: normalizedPlatform,
    });

    // Legacy support if old docs still have youtube.channelId.
    identityOr.push({
      "youtube.channelId": normalizedChannelId,
      platform: normalizedPlatform,
    });
  }

  let doc = await MissingEmail.findOne({ $or: identityOr });

  const campaignSnapshot = buildMissingEmailCampaignSnapshot({
    brandId,
    campaignId,
    campaign,
    campaignName,
    handle: normalizedHandle,
    platform: normalizedPlatform,
    channelId: normalizedChannelId,
  });

  if (!doc) {
    doc = new MissingEmail({
      email: cleanedEmail || null,
      handle: normalizedHandle,
      platform: normalizedPlatform,
      channelId: normalizedChannelId || null,
      status: cleanedEmail ? "resolved" : "pending",
      campaigns: campaignSnapshot ? [campaignSnapshot] : [],
      createdByAdminId: createdByAdminId || null,
    });

    await doc.save();
    return doc.toObject();
  }

  doc.handle = normalizedHandle;
  doc.platform = normalizedPlatform;
  doc.channelId = normalizedChannelId || doc.channelId || null;

  if (cleanedEmail) {
    doc.email = cleanedEmail;
    doc.status = "resolved";
  } else if (!doc.email) {
    doc.status = "pending";
  }

  if (createdByAdminId && !doc.createdByAdminId) {
    doc.createdByAdminId = createdByAdminId;
  }

  if (campaignSnapshot?.campaignId) {
    const campaigns = Array.isArray(doc.campaigns) ? doc.campaigns : [];

    const existingIndex = campaigns.findIndex(
      (item) =>
        String(item.campaignId) === String(campaignSnapshot.campaignId) &&
        String(item.brandId || "") === String(campaignSnapshot.brandId || "")
    );

    if (existingIndex >= 0) {
      const oldCampaign =
        typeof campaigns[existingIndex].toObject === "function"
          ? campaigns[existingIndex].toObject()
          : campaigns[existingIndex];

      campaigns[existingIndex] = {
        ...oldCampaign,
        ...campaignSnapshot,
      };
    } else {
      campaigns.push(campaignSnapshot);
    }

    doc.campaigns = campaigns;
    doc.markModified("campaigns");
  }

  await doc.save();
  return doc.toObject();
}

async function resolveMissingEmailDoc({
  missingEmailId,
  email,
  handle,
  platform = "youtube",
  channelId,
}) {
  const rawMissingEmailId = String(missingEmailId || "").trim();
  const cleanedEmail = cleanEmail(email);
  const normalizedHandle = handle ? normalizeHandle(handle) : "";
  const normalizedPlatform = normalizePlatform(platform) || "youtube";
  const normalizedChannelId = String(channelId || "").trim();

  let missing = null;

  if (rawMissingEmailId && normalizeObjectId(rawMissingEmailId)) {
    missing = await MissingEmail.findById(rawMissingEmailId).lean();
  }

  if (!missing && rawMissingEmailId) {
    missing = await MissingEmail.findOne({
      $or: [
        { missingEmailId: rawMissingEmailId },
        { missingId: rawMissingEmailId },
        { uuid: rawMissingEmailId },
        { publicId: rawMissingEmailId },
        { id: rawMissingEmailId },
        { channelId: rawMissingEmailId },
        { "youtube.channelId": rawMissingEmailId },
      ],
    }).lean();
  }

  if (!missing && normalizedChannelId) {
    missing = await MissingEmail.findOne({
      platform: normalizedPlatform,
      $or: [
        { channelId: normalizedChannelId },
        { "youtube.channelId": normalizedChannelId },
      ],
    }).lean();
  }

  if (!missing && cleanedEmail) {
    missing = await MissingEmail.findOne({ email: cleanedEmail }).lean();
  }

  if (!missing && normalizedHandle) {
    missing = await MissingEmail.findOne({
      handle: normalizedHandle,
      platform: normalizedPlatform,
    }).lean();
  }

  return missing;
}

function buildEmailTags({
  brandId,
  campaignId,
  platform,
  handle,
  channelId,
  type = "creator-invitation",
}) {
  return [
    { Name: "type", Value: type },
    { Name: "platform", Value: platform },
    { Name: "handle", Value: handle.replace(/^@/, "") },
    { Name: "channelId", Value: channelId || "" },
    { Name: "brandId", Value: brandId },
    { Name: "campaignId", Value: campaignId },
  ];
}

async function sendInvitationEmail({
  recipientEmail,
  emailTemplate,
  brandId,
  campaignId,
  platform,
  handle,
  channelId,
  type = "creator-invitation",
}) {
  return sendEmail({
    to: recipientEmail,
    from: emailTemplate.from,
    subject: emailTemplate.subject,
    text: emailTemplate.text,
    html: emailTemplate.html,
    cc: emailTemplate.cc,
    bcc: emailTemplate.bcc,
    replyTo: emailTemplate.replyTo,
    attachments: emailTemplate.attachments,
    emailTags: buildEmailTags({
      brandId,
      campaignId,
      platform,
      handle,
      channelId,
      type,
    }),
  });
}

function invitationResponse(doc, refs = {}) {
  const brand = refs.brand || null;
  const campaign = refs.campaign || null;
  const missingEmail = refs.missingEmail || null;
  const infoMediaKit = refs.infoMediaKit || null;
  const resolvedChannelId = getInvitationChannelId(doc);

  return {
    _id: String(doc._id),
    invitationId: doc.invitationId || null,

    handle: doc.handle || "",
    platform: doc.platform || "youtube",
    channelId: doc.channelId || null,
    userId: doc.userId || null,

    status: doc.status || "",
    aiScore: doc.aiScore ?? null,
    rawAiScore: doc.rawAiScore ?? null,
    recommendationReason: doc.recommendationReason || "",

    emailTo: doc.emailTo || null,
    emailFrom: doc.emailFrom || null,
    emailSubject: doc.emailSubject || "",
    emailMessageId: doc.emailMessageId || null,
    emailSentAt: doc.emailSentAt || null,

    followUpEmailTo: doc.followUpEmailTo || null,
    followUpEmailFrom: doc.followUpEmailFrom || null,
    followUpSubject: doc.followUpSubject || "",
    followUpMessageId: doc.followUpMessageId || null,
    followUpSentAt: doc.followUpSentAt || null,
    permanentCampaignLock: Boolean(doc.permanentCampaignLock),

    brandId: toPlainId(doc.brandId),
    brandName: brand?.brandName || campaign?.brandName || "",
    brandEmail: brand?.email || "",
    brandIndustry: brand?.industry || "",
    brandCompanySize: brand?.companySize || "",

    campaignId: toPlainId(doc.campaignId),
    campaignName: campaign?.campaignTitle || "",

    campaign: campaign
      ? {
        _id: String(campaign._id),
        brandId: toPlainId(campaign.brandId),
        brandName: campaign.brandName || "",
        campaignTitle: campaign.campaignTitle || "",
        description: campaign.description || "",
        campaignType: campaign.campaignType || "",
        campaignCategory: campaign.campaignCategory || "",
        campaignSubcategory: campaign.campaignSubcategory || "",
        campaignBudget: campaign.campaignBudget ?? null,
        budget: campaign.budget ?? null,
        influencerBudget: campaign.influencerBudget ?? null,
        paymentType: campaign.paymentType || "",
        platformSelection: campaign.platformSelection || [],
        numberOfInfluencers: campaign.numberOfInfluencers ?? null,
        influencerTier: campaign.influencerTier || "",
        minFollowers: campaign.minFollowers ?? null,
        maxFollowers: campaign.maxFollowers ?? null,
        creatorContentLanguage: campaign.creatorContentLanguage || "",
        audienceContentLanguage: campaign.audienceContentLanguage || "",
        targetCountry: campaign.targetCountry || "",
        additionalNotes: campaign.additionalNotes || "",
        hashtags: campaign.hashtags || [],
        timeline: campaign.timeline || null,
        startAt: campaign.startAt || null,
        endAt: campaign.endAt || null,
        scheduledAt: campaign.scheduledAt || null,
        publishedAt: campaign.publishedAt || null,
        endedAt: campaign.endedAt || null,
        status: campaign.status || "",
        publishStatus: campaign.publishStatus || "",
        approvalMode: campaign.approvalMode || "",
        isFullyManaged: campaign.isFullyManaged ?? false,
        managementType: campaign.managementType || "",
        isActive: campaign.isActive ?? null,
        applicantCount: campaign.applicantCount ?? null,
        hasApplied: campaign.hasApplied ?? null,
        isDraft: campaign.isDraft ?? null,
        byAi: campaign.byAi ?? null,
        createdAt: campaign.createdAt || null,
        updatedAt: campaign.updatedAt || null,
      }
      : null,

    missingEmailId: toPlainId(doc.missingEmailId),
    email: cleanEmail(doc.emailTo) || missingEmail?.email || null,

    missingEmail: missingEmail
      ? {
        _id: String(missingEmail._id),
        missingEmailId: missingEmail.missingEmailId || null,
        email: missingEmail.email || null,
        handle: missingEmail.handle || "",
        platform: missingEmail.platform || "youtube",
        channelId: missingEmail.channelId || resolvedChannelId || null,
        status: missingEmail.status || "",
        campaigns: missingEmail.campaigns || [],
        createdByAdminId: missingEmail.createdByAdminId || null,
        createdAt: missingEmail.createdAt || null,
        updatedAt: missingEmail.updatedAt || null,
      }
      : null,

    infoMediaKit: infoMediaKit
      ? {
        _id: String(infoMediaKit._id),
        platform: infoMediaKit.platform || "youtube",
        channelId: infoMediaKit.channelId || resolvedChannelId || null,
        channelName: infoMediaKit.channelName || "",
        channelUrl: infoMediaKit.channelUrl || "",
        thumbnail: infoMediaKit.thumbnail || "",
        country: infoMediaKit.country || "",
        creatorTier: infoMediaKit.creatorTier || "",
        subscribers: infoMediaKit.subscribers || 0,
        email: infoMediaKit.email || "",
      }
      : null,

    creatorTitle:
      infoMediaKit?.channelName || missingEmail?.handle || doc.handle || "",

    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function buildInvitationPayload({
  handle,
  platform,
  channelId,
  brandId,
  campaignId,
  status,
  userId,
  aiScore,
  rawAiScore,
  recommendationReason,
  missingEmailId,
  emailTo,
  emailFrom,
  emailSubject,
}) {
  const payload = {
    handle,
    platform,
    channelId,
    brandId,
    campaignId,
    status,
    userId: userId || null,
    emailTo,
    emailFrom,
    emailSubject,
  };

  if (aiScore !== null) payload.aiScore = aiScore;
  if (rawAiScore !== null) payload.rawAiScore = rawAiScore;
  if (recommendationReason) payload.recommendationReason = recommendationReason;
  if (missingEmailId) payload.missingEmailId = String(missingEmailId);

  return payload;
}

function applyInvitationUpdates(doc, payload = {}) {
  let changed = false;

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;

    if (String(doc[key] ?? "") !== String(value ?? "")) {
      doc[key] = value;
      changed = true;
    }
  }

  return changed;
}

async function deleteMissingEmailByChannelId({ channelId }) {
  const normalizedChannelId = String(channelId || "").trim();

  if (!normalizedChannelId) {
    return {
      deletedCount: 0,
    };
  }

  const result = await MissingEmail.deleteMany({
    platform: "youtube",
    $or: [
      { channelId: normalizedChannelId },
      { "youtube.channelId": normalizedChannelId },
    ],
  });

  return {
    deletedCount: result.deletedCount || 0,
  };
}

exports.createInvitation = async (req, res) => {
  try {
    const brandId = normalizeObjectId(req.body?.brandId);
    const campaignIds = normalizeCampaignIds(req.body);

    const rawHandle = String(req.body?.handle || "").trim();
    const rawPlatform = String(req.body?.platform || "youtube").trim();
    const rawStatus = String(req.body?.status || "").trim().toLowerCase();

    const channelId = getRequestChannelId(req);
    const userId = normalizeInfluencerUserId(req.body);

    const aiScore = normalizeAiScore(req.body?.aiScore);
    const rawAiScore = Number.isFinite(Number(req.body?.rawAiScore))
      ? Number(req.body.rawAiScore)
      : null;

    const recommendationReason = cleanStr(
      req.body?.recommendationReason || ""
    );

    if (!brandId) {
      return res.status(400).json({
        status: "error",
        message: "Valid brand _id is required.",
      });
    }

    if (!campaignIds.length) {
      return res.status(400).json({
        status: "error",
        message: "Valid campaignId or campaignIds are required.",
      });
    }

    if (!rawHandle) {
      return res.status(400).json({
        status: "error",
        message: "handle is required.",
      });
    }

    if (!channelId) {
      return res.status(400).json({
        status: "error",
        message: "channelId is required for YouTube invitation email lookup.",
      });
    }

    const handle = normalizeHandle(rawHandle);

    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-".',
      });
    }

    const platform = normalizePlatform(rawPlatform);

    if (!platform || !PLATFORM_ENUM.has(platform)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid platform. Only youtube is supported.",
      });
    }

    const status = STATUS_ENUM.has(rawStatus) ? rawStatus : "invited";

    const brand = await getBrandByMongoId(brandId);

    if (!brand) {
      return res.status(404).json({
        status: "error",
        message: "Brand not found for provided brand _id.",
      });
    }

    const campaigns = await Campaign.find({
      _id: {
        $in: campaignIds.map((id) => toObjectId(id)),
      },
      $or: [{ brandId: toObjectId(brandId) }, { brandId: String(brandId) }],
    }).lean();

    const campaignMap = new Map(
      campaigns.map((campaign) => [String(campaign._id), campaign])
    );

    const missingCampaignIds = campaignIds.filter(
      (campaignId) => !campaignMap.has(String(campaignId))
    );

    if (missingCampaignIds.length) {
      return res.status(404).json({
        status: "error",
        message: "One or more campaigns were not found for this brand.",
        missingCampaignIds,
      });
    }

    const emailTemplate = normalizeEmailTemplate(req.body, {
      brand,
      fallbackSubject: `Invitation to Collaborate - ${brand.brandName || "CollabGlam"
        }`,
    });

    if (emailTemplate?.error) {
      return res.status(400).json({
        status: "error",
        message: emailTemplate.error,
      });
    }

    const infoResult = await findEmailInInfoMediaKit({ channelId });
    const recipientEmail = cleanEmail(infoResult.email);
    const infoMediaKit = infoResult.doc || null;
    const emailSource = infoResult.source;

    const results = [];
    const missingRecords = [];

    let createdCount = 0;
    let existingCount = 0;
    let updatedCount = 0;
    let emailSentCount = 0;

    // If email is not found, do NOT create invitation.
    // Only save/update MissingEmail record.
    if (!recipientEmail) {
      for (const campaignId of campaignIds) {
        const campaign = campaignMap.get(String(campaignId));
        const campaignName = getCampaignName(campaign, req.body?.campaignName);

        const missingEmail = await ensureMissingEmailRecord({
          handle,
          platform,
          channelId,
          email: null,
          brandId,
          campaignId,
          campaign,
          campaignName,
          createdByAdminId: req.body?.createdByAdminId,
        });

        if (
          missingEmail?._id &&
          !missingRecords.some(
            (item) => String(item._id) === String(missingEmail._id)
          )
        ) {
          missingRecords.push(missingEmail);
        }

        results.push({
          status: "pending_email_resolution",
          message:
            "Email not found. MissingEmail record created/updated. Invitation was not created.",
          emailSent: false,
          emailMeta: null,
          emailSkippedReason:
            "Email not found in InfoMediaKit. Invitation was not saved because emailTo is missing.",
          data: {
            handle,
            platform,
            channelId,
            brandId,
            campaignId,
            campaignName,
            missingEmail,
          },
        });
      }

      const multipleCampaigns = campaignIds.length > 1;

      return res.status(200).json({
        status: "pending_email_resolution",
        message:
          "Email not found in InfoMediaKit. MissingEmail was created/updated, but invitation was not saved.",
        handle,
        platform,
        channelId,
        emailSource,
        createdCount: 0,
        existingCount: 0,
        updatedCount: 0,
        emailSentCount: 0,
        emailSent: false,
        missingEmailCount: missingRecords.length,
        emailMeta: null,
        emailSkippedReason:
          "Email not found. Invitation was not created because emailTo is missing.",
        data: multipleCampaigns
          ? results.map((item) => item.data)
          : results[0]?.data || null,
        missingEmails:
          missingRecords.length === 1 ? missingRecords[0] : missingRecords,
        results,
      });
    }

    for (const campaignId of campaignIds) {
      const campaign = campaignMap.get(String(campaignId));
      const campaignName = getCampaignName(campaign, req.body?.campaignName);

      let missingEmail = null;

      const emailToValue = recipientEmail;

      const payload = buildInvitationPayload({
        handle,
        platform,
        channelId,
        brandId,
        campaignId,
        status,
        userId,
        aiScore,
        rawAiScore,
        recommendationReason,
        missingEmailId: missingEmail?._id,
        emailTo: emailToValue,
        emailFrom: emailTemplate.from,
        emailSubject: emailTemplate.subject,
      });

      let doc = await Invitation.findOne({
        brandId,
        campaignId,
        platform,
        $or: [{ channelId }, { handle }],
      });

      let responseStatus = "saved";
      let emailSent = false;
      let emailMeta = null;
      let emailSkippedReason = null;

      if (doc) {
        responseStatus = "exists";
        existingCount += 1;

        const changed = applyInvitationUpdates(doc, payload);

        if (changed) {
          await doc.save();
          updatedCount += 1;
        }
      } else {
        doc = await Invitation.create(payload);
        createdCount += 1;
      }

      if (recipientEmail) {
        if (doc.emailSentAt && doc.emailMessageId) {
          emailSkippedReason = "Duplicate invitation skipped. Email already sent.";
        } else {
          try {
            const sent = await sendInvitationEmail({
              recipientEmail,
              emailTemplate,
              brandId,
              campaignId,
              platform,
              handle,
              channelId,
              type: "creator-invitation",
            });

            emailSent = Boolean(sent?.messageId);

            if (emailSent) {
              emailSentCount += 1;

              doc.emailTo = recipientEmail;
              doc.emailFrom = emailTemplate.from;
              doc.emailSubject = emailTemplate.subject;
              doc.emailMessageId = sent?.messageId || null;
              doc.emailSentAt = new Date();

              await doc.save();
              await deleteMissingEmailByChannelId({ channelId });
            }

            emailMeta = {
              recipientEmail,
              emailSource,
              messageId: sent?.messageId || null,
              subject: emailTemplate.subject,
              campaignId,
              from: emailTemplate.from,
              channelId,
            };
          } catch (mailErr) {
            console.error("Invitation email send failed:", mailErr);

            emailSkippedReason =
              mailErr?.message ||
              "Invitation saved, but email sending failed.";
          }
        }
      } else {
        emailSkippedReason =
          "Invitation Send Succefully";
      }

      results.push({
        status: responseStatus,
        message: recipientEmail
          ? emailSent
            ? "Invitation created and email sent successfully."
            : responseStatus === "exists"
              ? "Invitation already exists for this campaign and creator."
              : "Invitation saved."
          : "Invitation saved. Influencer email is missing.",
        emailSent,
        emailMeta,
        emailSkippedReason,
        data: invitationResponse(doc, {
          brand,
          campaign,
          missingEmail,
          infoMediaKit,
        }),
      });
    }

    const multipleCampaigns = campaignIds.length > 1;

    return res.status(createdCount ? 201 : 200).json({
      status: recipientEmail
        ? createdCount
          ? "saved"
          : "exists"
        : "pending_email_resolution",
      message: recipientEmail
        ? multipleCampaigns
          ? "Invitations processed successfully."
          : createdCount
            ? "Invitation created successfully."
            : "Invitation already exists for this campaign and creator."
        : "Invitation saved. Email was not found in InfoMediaKit, so handle was stored in emailTo and MissingEmail was created.",
      handle,
      platform,
      channelId,
      emailSource,
      createdCount,
      existingCount,
      updatedCount,
      emailSentCount,
      emailSent: emailSentCount > 0,
      missingEmailCount: missingRecords.length,
      emailMeta: multipleCampaigns ? null : results[0]?.emailMeta || null,
      emailSkippedReason: multipleCampaigns
        ? null
        : results[0]?.emailSkippedReason || null,
      data: multipleCampaigns
        ? results.map((item) => item.data)
        : results[0]?.data || null,
      missingEmails:
        missingRecords.length === 1 ? missingRecords[0] : missingRecords,
      results,
    });
  } catch (err) {
    console.error("createInvitation error:", err);

    const statusCode =
      err?.code === 11000 ? 409 : err?.statusCode || err?.status || 500;

    await saveErrorLog(req, err, statusCode, "CREATE_INVITATION_ERROR");

    if (err?.code === 11000) {
      return res.status(409).json({
        status: "error",
        message:
          "Duplicate MongoDB index is blocking this invitation. Drop old unique indexes from invitations collection.",
        duplicateKey: err.keyValue || null,
        indexesToDrop: [
          "brandId_1_handle_1_platform_1",
          "brandId_1_campaignId_1_handle_1_platform_1",
          "brandId_1_modashUserId_1",
        ],
      });
    }

    return res.status(500).json({
      status: "error",
      message: err?.message || "Failed to create invitation.",
    });
  }
};

exports.sendInvitationFollowUp = async (req, res) => {
  try {
    const brandId = normalizeObjectId(req.body?.brandId);
    const campaignId = normalizeObjectId(req.body?.campaignId);

    const rawHandle = String(req.body?.handle || "").trim();
    const channelId = getRequestChannelId(req);
    const userId = normalizeInfluencerUserId(req.body);

    // Fixed platform
    const platform = "youtube";

    if (!brandId) {
      return res.status(400).json({
        status: "error",
        message: "Valid brand _id is required.",
      });
    }

    if (!campaignId) {
      return res.status(400).json({
        status: "error",
        message: "Valid campaignId is required.",
      });
    }

    if (!channelId) {
      return res.status(400).json({
        status: "error",
        message: "channelId is required.",
      });
    }

    const handle = rawHandle ? normalizeHandle(rawHandle) : "";

    if (handle && !HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid handle format.",
      });
    }

    const [brand, campaign] = await Promise.all([
      getBrandByMongoId(brandId),
      Campaign.findOne({
        _id: toObjectId(campaignId),
        $or: [{ brandId: toObjectId(brandId) }, { brandId: String(brandId) }],
      }).lean(),
    ]);

    if (!brand) {
      return res.status(404).json({
        status: "error",
        message: "Brand not found for provided brand _id.",
      });
    }

    if (!campaign) {
      return res.status(404).json({
        status: "error",
        message: "Campaign not found for this brand.",
      });
    }

    const invitationOr = [
      { channelId },
      { userId: channelId }, // legacy support: old rows stored YouTube channelId in userId
    ];

    if (handle) {
      invitationOr.push({ handle });
    }

    if (req.body?.invitationId && normalizeObjectId(req.body.invitationId)) {
      invitationOr.push({ _id: toObjectId(req.body.invitationId) });
    }

    const doc = await Invitation.findOne({
      brandId,
      campaignId,
      platform,
      $or: invitationOr,
    });

    if (!doc) {
      return res.status(404).json({
        status: "error",
        message:
          "Invitation not found for this brand, campaign and channelId. Send the invitation first before follow-up.",
        lookup: {
          brandId,
          campaignId,
          platform,
          channelId,
          handle: handle || null,
        },
      });
    }

    if (doc.permanentCampaignLock || doc.followUpSentAt) {
      return res.status(409).json({
        status: "error",
        message: "Follow-up already sent. This campaign is permanently locked.",
        data: invitationResponse(doc, { brand, campaign }),
      });
    }

    const resolvedHandle = doc.handle || handle || "";
    const resolvedChannelId = getInvitationChannelId(doc) || channelId;

    const directEmailFromInvitation = cleanEmail(doc.emailTo);

    let recipientEmail = directEmailFromInvitation;
    let emailSource = directEmailFromInvitation
      ? "invitation_email_to"
      : "email_not_found";

    let infoMediaKit = null;
    let missingEmail = null;

    if (!recipientEmail) {
      const infoResult = await findEmailInInfoMediaKit({
        channelId: resolvedChannelId,
      });

      recipientEmail = cleanEmail(infoResult.email);
      emailSource = infoResult.source;
      infoMediaKit = infoResult.doc || null;
    }

    if (!recipientEmail) {
      missingEmail = await resolveMissingEmailDoc({
        missingEmailId: doc.missingEmailId || req.body?.missingEmailId,
        handle: resolvedHandle,
        platform,
        channelId: resolvedChannelId,
      });

      recipientEmail = cleanEmail(missingEmail?.email);
      emailSource = recipientEmail ? "missing_email" : emailSource;
    }

    if (!recipientEmail) {
      return res.status(400).json({
        status: "error",
        message:
          "Influencer email not found in invitation, InfoMediaKit or MissingEmail. Please resolve missing email first.",
        handle: resolvedHandle,
        platform,
        channelId: resolvedChannelId,
      });
    }

    const emailTemplate = normalizeEmailTemplate(req.body, {
      brand,
      fallbackSubject: `Follow-up: Invitation to Collaborate - ${brand.brandName || "CollabGlam"
        }`,
    });

    if (emailTemplate?.error) {
      return res.status(400).json({
        status: "error",
        message: emailTemplate.error,
      });
    }

    const sent = await sendInvitationEmail({
      recipientEmail,
      emailTemplate,
      brandId,
      campaignId,
      platform,
      handle: resolvedHandle,
      channelId: resolvedChannelId,
      type: "creator-followup",
    });

    doc.status = "invited";
    doc.userId = userId || doc.userId || null;
    doc.channelId = resolvedChannelId;

    if (missingEmail?._id) {
      doc.missingEmailId = String(missingEmail._id);
    }

    doc.followUpEmailTo = recipientEmail;
    doc.followUpEmailFrom = emailTemplate.from;
    doc.followUpSubject = emailTemplate.subject;
    doc.followUpMessageId = sent?.messageId || null;
    doc.followUpSentAt = new Date();
    doc.permanentCampaignLock = true;

    await doc.save();

    return res.status(200).json({
      status: "success",
      message: "Follow-up email sent successfully. Campaign locked permanently.",
      emailSent: Boolean(sent?.messageId),
      emailMeta: {
        recipientEmail,
        emailSource,
        missingEmailId: missingEmail?._id ? String(missingEmail._id) : null,
        messageId: sent?.messageId || null,
        subject: emailTemplate.subject,
        from: emailTemplate.from,
        campaignId,
        channelId: resolvedChannelId,
      },
      data: invitationResponse(doc, {
        brand,
        campaign,
        missingEmail,
        infoMediaKit,
      }),
    });
  } catch (err) {
    console.error("sendInvitationFollowUp error:", err);

    const statusCode = err?.statusCode || err?.status || 500;

    await saveErrorLog(req, err, statusCode, "SEND_INVITATION_FOLLOWUP_ERROR");

    return res.status(500).json({
      status: "error",
      message: err?.message || "Failed to send follow-up email.",
    });
  }
};

exports.updateInvitationStatus = async (req, res) => {
  try {
    const invitationMongoId = normalizeObjectId(
      req.body?._id || req.body?.invitationId
    );

    const rawStatus = String(req.body?.status || "").trim().toLowerCase();

    if (!invitationMongoId) {
      return res.status(400).json({
        status: "error",
        message: "Valid invitation _id is required.",
      });
    }

    if (!STATUS_ENUM.has(rawStatus)) {
      return res.status(400).json({
        status: "error",
        message: 'Invalid status. Use "invited" or "available".',
      });
    }

    const doc = await Invitation.findById(invitationMongoId);

    if (!doc) {
      return res.status(404).json({
        status: "error",
        message: "Invitation not found for provided _id.",
      });
    }

    doc.status = rawStatus;

    const userId = normalizeInfluencerUserId(req.body);

    if (userId) {
      doc.userId = userId;
    }

    if (req.body?.channelId || req.body?.youtubeChannelId) {
      const channelId = getRequestChannelId(req);
      if (channelId) doc.channelId = channelId;
    }

    let warning = null;

    const rawMissingEmailId = String(req.body?.missingEmailId || "").trim();
    const hasResolverInput =
      rawMissingEmailId ||
      req.body?.email ||
      req.body?.handle ||
      req.body?.platform ||
      req.body?.channelId ||
      req.body?.youtubeChannelId;

    if (hasResolverInput) {
      const missing = await resolveMissingEmailDoc({
        missingEmailId: rawMissingEmailId,
        email: req.body?.email,
        handle: req.body?.handle || doc.handle,
        platform: req.body?.platform || doc.platform,
        channelId: getRequestChannelId(req) || doc.channelId,
      });

      if (missing?._id) {
        doc.missingEmailId = String(missing._id);

        if (cleanEmail(missing.email)) {
          doc.emailTo = cleanEmail(missing.email);
        }
      } else if (rawMissingEmailId) {
        warning =
          "missingEmailId was not found, so status was updated without changing invitation.missingEmailId.";
      }
    }

    await doc.save();

    const [brand, campaign, missingEmail, infoMediaKit] = await Promise.all([
      doc.brandId ? Brand.findById(doc.brandId).lean() : null,
      doc.campaignId ? Campaign.findById(doc.campaignId).lean() : null,
      doc.missingEmailId
        ? resolveMissingEmailDoc({ missingEmailId: doc.missingEmailId })
        : null,
      doc.channelId
        ? InfoMediaKit.findOne({
          channelId: doc.channelId,
          platform: /^youtube$/i,
        }).lean()
        : null,
    ]);

    return res.json({
      status: "success",
      message: warning
        ? "Invitation status updated, but missing email could not be linked."
        : "Invitation status updated.",
      warning,
      data: invitationResponse(doc, {
        brand,
        campaign,
        missingEmail,
        infoMediaKit,
      }),
    });
  } catch (err) {
    console.error("Error in updateInvitationStatus:", err);

    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "UPDATE_INVITATION_STATUS_ERROR"
    );

    return res.status(500).json({
      status: "error",
      message: err?.message || "Internal server error.",
    });
  }
};

exports.listInvitations = async (req, res) => {
  try {
    const body = {
      ...(req.query || {}),
      ...(req.body || {}),
    };

    const page = Math.max(1, parseInt(body.page ?? "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? "50", 10)));

    const brandId = body.brandId ? normalizeObjectId(body.brandId) : "";
    const campaignId = body.campaignId ? normalizeObjectId(body.campaignId) : "";
    const campaignIds = Array.isArray(body.campaignIds)
      ? body.campaignIds.map((id) => normalizeObjectId(id)).filter(Boolean)
      : [];

    const userId = String(
      body.userId ||
      body.influencerUserId ||
      body.creatorId ||
      body.influencerId ||
      ""
    ).trim();

    const rawHandle = typeof body.handle === "string" ? body.handle.trim() : "";
    const rawPlatform =
      typeof body.platform === "string" ? body.platform.trim() : "";
    const rawStatus =
      typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
    const rawSearch =
      typeof body.search === "string" ? body.search.trim() : "";
    const rawChannelId =
      typeof body.channelId === "string" ? body.channelId.trim() : "";

    const missingEmailOnly =
      body.missingEmailOnly === true ||
      body.missingEmailOnly === "true" ||
      body.onlyMissingEmail === true ||
      body.onlyMissingEmail === "true";

    const query = {};

    if (body.brandId) {
      if (!brandId) {
        return res.status(400).json({
          status: "error",
          message: "Invalid brandId. Use brand _id.",
        });
      }

      query.brandId = brandId;
    }

    if (body.campaignId) {
      if (!campaignId) {
        return res.status(400).json({
          status: "error",
          message: "Invalid campaignId. Use campaign _id.",
        });
      }

      query.campaignId = campaignId;
    }

    if (body.campaignIds) {
      if (!campaignIds.length) {
        return res.status(400).json({
          status: "error",
          message: "Invalid campaignIds. Use campaign _id array.",
        });
      }

      query.campaignId = { $in: campaignIds };
    }

    if (userId) {
      query.userId = userId;
    }

    if (rawChannelId) {
      query.channelId = rawChannelId;
    }

    if (rawHandle) {
      const handle = normalizeHandle(rawHandle);

      if (!HANDLE_RX.test(handle)) {
        return res.status(400).json({
          status: "error",
          message: "Invalid handle format in filter.",
        });
      }

      query.handle = handle;
    }

    if (rawPlatform) {
      const platform = normalizePlatform(rawPlatform);

      if (!platform) {
        return res.status(400).json({
          status: "error",
          message: "Invalid platform filter. Only youtube is supported.",
        });
      }

      query.platform = platform;
    }

    if (rawStatus && rawStatus !== "all") {
      if (!STATUS_ENUM.has(rawStatus)) {
        return res.status(400).json({
          status: "error",
          message: 'Invalid status filter. Use "invited", "available" or "all".',
        });
      }

      query.status = rawStatus;
    }

    if (missingEmailOnly) {
      query.missingEmailId = {
        $exists: true,
        $nin: [null, ""],
      };
    }

    if (rawSearch) {
      const rx = new RegExp(escapeRegExp(rawSearch), "i");

      const [matchedBrands, matchedCampaigns, matchedMissingEmails] =
        await Promise.all([
          Brand.find({
            $or: [
              { brandName: rx },
              { email: rx },
              { name: rx },
              { industry: rx },
              { companySize: rx },
            ],
          })
            .select("_id")
            .lean(),

          Campaign.find({
            $or: [
              { campaignTitle: rx },
              { brandName: rx },
              { description: rx },
              { campaignType: rx },
              { campaignCategory: rx },
              { campaignSubcategory: rx },
              { targetCountry: rx },
              { paymentType: rx },
              { influencerTier: rx },
              { hashtags: rx },
            ],
          })
            .select("_id")
            .lean(),

          MissingEmail.find({
            $or: [
              { email: rx },
              { handle: rx },
              { platform: rx },
              { status: rx },
              { channelId: rx },
              { "campaigns.campaignName": rx },
              { "campaigns.channelId": rx },
            ],
          })
            .select("_id")
            .lean(),
        ]);

      const matchedBrandIds = matchedBrands.map((item) => String(item._id));
      const matchedCampaignIds = matchedCampaigns.map((item) =>
        String(item._id)
      );
      const matchedMissingEmailIds = matchedMissingEmails.map((item) =>
        String(item._id)
      );

      const searchOr = [
        { handle: rx },
        { userId: rx },
        { channelId: rx },
        { recommendationReason: rx },
        { emailTo: rx },
        { emailFrom: rx },
        { emailSubject: rx },
      ];

      const possibleHandle = normalizeHandle(rawSearch);

      if (HANDLE_RX.test(possibleHandle)) {
        searchOr.push({ handle: possibleHandle });
      }

      if (isObjectId(rawSearch)) {
        searchOr.push({ _id: toObjectId(rawSearch) });
        searchOr.push({ brandId: rawSearch });
        searchOr.push({ campaignId: rawSearch });
        searchOr.push({ missingEmailId: rawSearch });
      }

      if (matchedBrandIds.length) {
        searchOr.push({ brandId: { $in: matchedBrandIds } });
      }

      if (matchedCampaignIds.length) {
        searchOr.push({ campaignId: { $in: matchedCampaignIds } });
      }

      if (matchedMissingEmailIds.length) {
        searchOr.push({ missingEmailId: { $in: matchedMissingEmailIds } });
      }

      query.$or = searchOr;
    }

    const [total, docs] = await Promise.all([
      Invitation.countDocuments(query),
      Invitation.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const brandIds = [
      ...new Set(
        docs.map((doc) => normalizeObjectId(doc.brandId)).filter(Boolean)
      ),
    ];

    const foundCampaignIds = [
      ...new Set(
        docs.map((doc) => normalizeObjectId(doc.campaignId)).filter(Boolean)
      ),
    ];

    const rawMissingEmailIds = [
      ...new Set(
        docs
          .map((doc) => String(doc.missingEmailId || "").trim())
          .filter(Boolean)
      ),
    ];

    const channelIds = [
      ...new Set(
        docs.map((doc) => getInvitationChannelId(doc)).filter(Boolean)
      ),
    ];

    const mongoMissingEmailIds = rawMissingEmailIds.filter((id) =>
      normalizeObjectId(id)
    );

    const customMissingEmailIds = rawMissingEmailIds.filter(
      (id) => !normalizeObjectId(id)
    );

    const [brands, campaigns, missingEmails, infoMediaKits] =
      await Promise.all([
        brandIds.length
          ? Brand.find({
            _id: { $in: brandIds.map((id) => toObjectId(id)) },
          })
            .select("brandName email name industry companySize proxyEmail")
            .lean()
          : [],

        foundCampaignIds.length
          ? Campaign.find({
            _id: { $in: foundCampaignIds.map((id) => toObjectId(id)) },
          }).lean()
          : [],

        rawMissingEmailIds.length
          ? MissingEmail.find({
            $or: [
              ...(mongoMissingEmailIds.length
                ? [
                  {
                    _id: {
                      $in: mongoMissingEmailIds.map((id) =>
                        toObjectId(id)
                      ),
                    },
                  },
                ]
                : []),
              ...(customMissingEmailIds.length
                ? [
                  { missingEmailId: { $in: customMissingEmailIds } },
                  { missingId: { $in: customMissingEmailIds } },
                  { uuid: { $in: customMissingEmailIds } },
                  { publicId: { $in: customMissingEmailIds } },
                  { id: { $in: customMissingEmailIds } },
                ]
                : []),
            ],
          }).lean()
          : [],

        channelIds.length
          ? InfoMediaKit.find({
            channelId: { $in: channelIds },
            platform: /^youtube$/i,
          }).lean()
          : [],
      ]);

    const brandMap = new Map(brands.map((brand) => [String(brand._id), brand]));
    const campaignMap = new Map(
      campaigns.map((campaign) => [String(campaign._id), campaign])
    );
    const missingEmailMap = new Map(
      missingEmails.map((missing) => [String(missing._id), missing])
    );
    const infoMediaKitMap = new Map(
      infoMediaKits.map((info) => [String(info.channelId), info])
    );

    for (const missing of missingEmails) {
      for (const key of [
        "missingEmailId",
        "missingId",
        "uuid",
        "publicId",
        "id",
      ]) {
        if (missing[key]) {
          missingEmailMap.set(String(missing[key]), missing);
        }
      }
    }

    const data = docs.map((doc) =>
      invitationResponse(doc, {
        brand: brandMap.get(String(doc.brandId || "")),
        campaign: campaignMap.get(String(doc.campaignId || "")),
        missingEmail: missingEmailMap.get(String(doc.missingEmailId || "")),
        infoMediaKit: infoMediaKitMap.get(getInvitationChannelId(doc)),
      })
    );

    return res.json({
      status: "success",
      message: docs.length
        ? "Invitation list fetched successfully."
        : missingEmailOnly
          ? "No invitations found with missingEmailId."
          : "No invitations found.",
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data,
    });
  } catch (err) {
    console.error("listInvitations error:", err);

    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "LIST_INVITATIONS_ERROR"
    );

    return res.status(500).json({
      status: "error",
      message: err?.message || "Internal server error.",
    });
  }
};

exports.getInvitationList = async (req, res) => {
  try {
    const brandId =
      normalizeObjectId(req.body?.brandId) ||
      normalizeObjectId(req.query?.brandId);

    if (!brandId) {
      return res.status(400).json({
        status: "error",
        message: "Valid brand _id is required.",
      });
    }

    const invitations = await Invitation.find({
      brandId,
      missingEmailId: { $ne: null },
    }).lean();

    if (!invitations.length) {
      return res.json({
        status: "success",
        message: "No invitations found for this brand with missingEmailId.",
        data: [],
      });
    }

    const missingIds = [
      ...new Set(
        invitations
          .map((inv) => String(inv.missingEmailId || "").trim())
          .filter(Boolean)
      ),
    ];

    const mongoMissingIds = missingIds.filter((id) => normalizeObjectId(id));
    const customMissingIds = missingIds.filter((id) => !normalizeObjectId(id));

    const campaignIds = [
      ...new Set(
        invitations
          .map((inv) => normalizeObjectId(inv.campaignId))
          .filter(Boolean)
      ),
    ];

    const channelIds = [
      ...new Set(
        invitations
          .map((inv) => String(inv.channelId || "").trim())
          .filter(Boolean)
      ),
    ];

    const [missingDocs, campaigns, infoMediaKits] = await Promise.all([
      missingIds.length
        ? MissingEmail.find({
          $or: [
            ...(mongoMissingIds.length
              ? [
                {
                  _id: {
                    $in: mongoMissingIds.map((id) => toObjectId(id)),
                  },
                },
              ]
              : []),
            ...(customMissingIds.length
              ? [
                { missingEmailId: { $in: customMissingIds } },
                { missingId: { $in: customMissingIds } },
                { uuid: { $in: customMissingIds } },
                { publicId: { $in: customMissingIds } },
                { id: { $in: customMissingIds } },
              ]
              : []),
          ],
        }).lean()
        : [],

      campaignIds.length
        ? Campaign.find({
          _id: {
            $in: campaignIds.map((id) => toObjectId(id)),
          },
        })
          .select("campaignTitle brandName campaignBudget status publishStatus")
          .lean()
        : [],

      channelIds.length
        ? InfoMediaKit.find({
          channelId: { $in: channelIds },
          platform: /^youtube$/i,
        }).lean()
        : [],
    ]);

    const missingMap = new Map();
    const campaignMap = new Map();
    const infoMap = new Map();

    for (const missing of missingDocs) {
      missingMap.set(String(missing._id), missing);

      for (const key of [
        "missingEmailId",
        "missingId",
        "uuid",
        "publicId",
        "id",
      ]) {
        if (missing[key]) {
          missingMap.set(String(missing[key]), missing);
        }
      }
    }

    for (const campaign of campaigns) {
      campaignMap.set(String(campaign._id), campaign);
    }

    for (const info of infoMediaKits) {
      infoMap.set(String(info.channelId), info);
    }

    const data = invitations.map((inv) => {
      const missing = missingMap.get(String(inv.missingEmailId || ""));
      const campaign = campaignMap.get(String(inv.campaignId || ""));
      const info = infoMap.get(String(inv.channelId || ""));

      return {
        _id: String(inv._id),
        invitationId: inv.invitationId || null,
        handle: inv.handle || "",
        platform: inv.platform || "youtube",
        channelId: inv.channelId || null,
        userId: inv.userId || null,
        status: inv.status || "",
        missingEmailId: inv.missingEmailId || null,
        campaignId: inv.campaignId || null,
        campaignName: campaign?.campaignTitle || "",
        brandName: campaign?.brandName || "",
        title: info?.channelName || missing?.handle || inv.handle || "",
        email: cleanEmail(inv.emailTo) || missing?.email || null,
        emailTo: inv.emailTo || null,
        emailFrom: inv.emailFrom || null,
        emailSentAt: inv.emailSentAt || null,
        missingEmail: missing || null,
        infoMediaKit: info || null,
      };
    });

    return res.json({
      status: "success",
      message: "Invitation list fetched successfully.",
      data,
    });
  } catch (err) {
    console.error("Error in getInvitationList:", err);

    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_INVITATION_LIST_ERROR"
    );

    return res.status(500).json({
      status: "error",
      message: "Internal server error.",
    });
  }
};

const COOLDOWN_MS = 48 * 60 * 60 * 1000;

async function computeBrandEligibilityForThread(threadId) {
  const messages = await EmailMessage.find({ thread: threadId })
    .select("direction createdAt sentAt")
    .sort({ createdAt: 1 })
    .lean();

  const hasIncoming = messages.some(
    (message) => message.direction === "influencer_to_brand"
  );

  if (hasIncoming) {
    return {
      canSend: true,
      state: "allowed",
      reason: "Influencer replied — messaging is unlocked.",
      nextAllowedAt: null,
      outgoingCount: messages.filter(
        (message) => message.direction === "brand_to_influencer"
      ).length,
    };
  }

  const outgoing = messages.filter(
    (message) => message.direction === "brand_to_influencer"
  );

  const outgoingCount = outgoing.length;

  if (outgoingCount === 0) {
    return {
      canSend: true,
      state: "allowed",
      reason: "First email allowed.",
      nextAllowedAt: null,
      outgoingCount,
    };
  }

  if (outgoingCount === 1) {
    const firstAt = new Date(
      outgoing[0].sentAt || outgoing[0].createdAt
    ).getTime();

    const nextAllowedAt = new Date(firstAt + COOLDOWN_MS);

    if (Date.now() >= nextAllowedAt.getTime()) {
      return {
        canSend: true,
        state: "allowed",
        reason: "48 hours passed — follow-up allowed.",
        nextAllowedAt: null,
        outgoingCount,
      };
    }

    return {
      canSend: false,
      state: "cooldown",
      reason: "Wait 48 hours before sending a follow-up. No reply yet.",
      nextAllowedAt: nextAllowedAt.toISOString(),
      outgoingCount,
    };
  }

  return {
    canSend: false,
    state: "blocked",
    reason:
      "You already sent 2 emails without a reply. You can message again only after the influencer replies.",
    nextAllowedAt: null,
    outgoingCount,
  };
}

exports.getInvitationSendEligibility = async (req, res) => {
  try {
    const brandId = normalizeObjectId(req.body?.brandId);
    const invitationId = normalizeObjectId(
      req.body?._id || req.body?.invitationId
    );

    if (!brandId || !invitationId) {
      return res.status(400).json({
        canSend: false,
        state: "missing_email",
        reason: "brandId and invitation _id are required.",
        nextAllowedAt: null,
      });
    }

    const brand = await Brand.findById(brandId).lean();

    if (!brand) {
      return res.status(404).json({
        canSend: false,
        state: "missing_email",
        reason: "Brand not found.",
        nextAllowedAt: null,
      });
    }

    const invitation = await Invitation.findById(invitationId).lean();

    if (!invitation) {
      return res.status(404).json({
        canSend: false,
        state: "missing_email",
        reason: "Invitation not found.",
        nextAllowedAt: null,
      });
    }

    if (invitation.brandId && invitation.brandId !== String(brand._id)) {
      return res.status(403).json({
        canSend: false,
        state: "missing_email",
        reason: "Invitation does not belong to this brand.",
        nextAllowedAt: null,
      });
    }

    let recipientEmail = cleanEmail(invitation.emailTo);

    if (!recipientEmail && invitation.channelId) {
      const infoResult = await findEmailInInfoMediaKit({
        channelId: invitation.channelId,
      });

      recipientEmail = cleanEmail(infoResult.email);
    }

    if (!recipientEmail && invitation.missingEmailId) {
      const missing = await resolveMissingEmailDoc({
        missingEmailId: invitation.missingEmailId,
        handle: invitation.handle,
        platform: invitation.platform,
        channelId: invitation.channelId,
      });

      recipientEmail = cleanEmail(missing?.email);
    }

    if (!recipientEmail) {
      return res.status(200).json({
        canSend: false,
        state: "missing_email",
        reason: "Recipient email not found yet for this invitation.",
        nextAllowedAt: null,
        threadId: null,
      });
    }

    const influencer = await InfluencerModel.findOne({
      email: recipientEmail,
    })
      .select("_id")
      .lean();

    if (!influencer) {
      return res.status(200).json({
        canSend: true,
        state: "allowed",
        reason: "First email allowed.",
        nextAllowedAt: null,
        threadId: null,
        outgoingCount: 0,
      });
    }

    const thread = await EmailThread.findOne({
      brand: brand._id,
      influencer: influencer._id,
    })
      .select("_id")
      .lean();

    if (!thread) {
      return res.status(200).json({
        canSend: true,
        state: "allowed",
        reason: "First email allowed.",
        nextAllowedAt: null,
        threadId: null,
        outgoingCount: 0,
      });
    }

    const eligibility = await computeBrandEligibilityForThread(thread._id);

    return res.status(200).json({
      ...eligibility,
      threadId: String(thread._id),
    });
  } catch (err) {
    console.error("getInvitationSendEligibility error:", err);

    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_INVITATION_SEND_ELIGIBILITY_ERROR"
    );

    return res.status(500).json({
      canSend: false,
      state: "missing_email",
      reason: "Internal server error.",
      nextAllowedAt: null,
    });
  }
};


exports.getAllInvitations = async (req, res) => {
  try {
    const body = {
      ...(req.query || {}),
      ...(req.body || {}),
    };

    // This API must show invitations from all brands.
    // So even if frontend sends brandId, we intentionally ignore it.
    delete body.brandId;
    delete body.brand_id;
    delete body.brandID;

    const clonedReq = {
      ...req,
      query: body,
      body: {},
    };

    return exports.listInvitations(clonedReq, res);
  } catch (err) {
    console.error("getAllInvitations error:", err);

    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_ALL_INVITATIONS_ERROR"
    );

    return res.status(500).json({
      status: "error",
      message: err?.message || "Internal server error.",
    });
  }
};


function getMissingEmailChannelId(doc = {}) {
  return (
    String(doc.channelId || "").trim() ||
    String(doc.youtube?.channelId || "").trim() ||
    ""
  );
}

exports.getAllMissingEmailRecords = async (req, res) => {
  try {
    const body = {
      ...(req.query || {}),
      ...(req.body || {}),
    };

    const page = Math.max(1, parseInt(body.page ?? "1", 10));
    const limit = Math.min(200, Math.max(1, parseInt(body.limit ?? "50", 10)));

    const rawStatus = String(body.status || "").trim().toLowerCase();
    const rawSearch = String(body.search || "").trim();
    const rawChannelId = String(body.channelId || body.youtubeChannelId || "").trim();
    const platform = "youtube";
    const andQuery = [{ platform }];

    if (rawStatus && rawStatus !== "all") {
      andQuery.push({ status: rawStatus });
    }

    if (rawChannelId) {
      andQuery.push({
        $or: [
          { channelId: rawChannelId },
          { "youtube.channelId": rawChannelId },
        ],
      });
    }

    if (rawSearch) {
      const rx = new RegExp(escapeRegExp(rawSearch), "i");

      const searchOr = [
        { email: rx },
        { handle: rx },
        { platform: rx },
        { status: rx },
        { channelId: rx },
        { "youtube.channelId": rx },
        { "campaigns.campaignName": rx },
        { "campaigns.channelId": rx },
        { "campaigns.brandId": rx },
        { "campaigns.campaignId": rx },
      ];

      if (isObjectId(rawSearch)) {
        searchOr.push({ _id: toObjectId(rawSearch) });
      }

      andQuery.push({ $or: searchOr });
    }

    const query = andQuery.length ? { $and: andQuery } : {};

    const [total, missingRecords] = await Promise.all([
      MissingEmail.countDocuments(query),
      MissingEmail.find(query)
        .sort({ updatedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const channelIds = [
      ...new Set(
        missingRecords
          .map((item) => getMissingEmailChannelId(item))
          .filter(Boolean)
      ),
    ];

    const infoMediaKits = channelIds.length
      ? await InfoMediaKit.find({
        channelId: { $in: channelIds },
        platform: /^youtube$/i,
      }).lean()
      : [];

    const infoMap = new Map(
      infoMediaKits.map((item) => [String(item.channelId), item])
    );

    const data = missingRecords.map((missing) => {
      const channelId = getMissingEmailChannelId(missing);
      const info = infoMap.get(channelId) || null;

      const email =
        cleanEmail(missing.email) ||
        cleanEmail(info?.email) ||
        null;

      return {
        _id: String(missing._id),
        missingEmailId: missing.missingEmailId || null,
        handle: missing.handle || "",
        platform: missing.platform || "youtube",
        channelId: channelId || null,
        email,
        status: missing.status || "",
        campaigns: missing.campaigns || [],
        createdByAdminId: missing.createdByAdminId || null,

        infoMediaKit: info
          ? {
            _id: String(info._id),
            platform: info.platform || "youtube",
            channelId: info.channelId || channelId || null,
            channelName: info.channelName || "",
            channelUrl: info.channelUrl || "",
            thumbnail: info.thumbnail || "",
            country: info.country || "",
            creatorTier: info.creatorTier || "",
            subscribers: info.subscribers || 0,
            email: info.email || "",
            emails: info.emails || [],
          }
          : null,

        createdAt: missing.createdAt || null,
        updatedAt: missing.updatedAt || null,
      };
    });

    return res.status(200).json({
      status: "success",
      message: data.length
        ? "Missing email records fetched successfully."
        : "No missing email records found.",
      page,
      limit,
      total,
      hasNext: page * limit < total,
      data,
    });
  } catch (err) {
    console.error("getAllMissingEmailRecords error:", err);

    await saveErrorLog(
      req,
      err,
      err?.statusCode || err?.status || 500,
      "GET_ALL_MISSING_EMAIL_RECORDS_ERROR"
    );

    return res.status(500).json({
      status: "error",
      message: err?.message || "Internal server error.",
    });
  }
};

exports.updateInfluencerEmailByChannelId = async (req, res) => {
  try {
    const channelId = String(
      req.params?.channelId ||
      req.body?.channelId ||
      req.body?.youtubeChannelId ||
      req.query?.channelId ||
      ""
    ).trim();

    const email = cleanEmail(
      req.body?.email ||
      req.body?.businessEmail ||
      req.body?.contactEmail ||
      ""
    );

    // Fixed platform. Do not take platform from body.
    const platform = "youtube";

    const rawHandle = String(req.body?.handle || "").trim();
    const handle = rawHandle ? normalizeHandle(rawHandle) : "";

    if (!channelId) {
      return res.status(400).json({
        status: "error",
        message: "channelId is required.",
      });
    }

    if (!email) {
      return res.status(400).json({
        status: "error",
        message: "Valid email is required.",
      });
    }

    if (handle && !HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-".',
      });
    }

    const missingMatch = {
      platform,
      $or: [{ channelId }, { "youtube.channelId": channelId }],
    };

    const missingSet = {
      email,
      status: "resolved",
      platform,
      channelId,
    };

    if (handle) {
      missingSet.handle = handle;
    }

    const missingBefore = await MissingEmail.find(missingMatch)
      .select("_id")
      .lean();

    const missingUpdateResult = await MissingEmail.updateMany(missingMatch, {
      $set: missingSet,
    });

    let missingRecords = await MissingEmail.find(missingMatch).lean();
    let createdMissingRecord = false;

    if (!missingRecords.length && handle) {
      const created = await MissingEmail.create({
        email,
        handle,
        platform,
        channelId,
        status: "resolved",
        campaigns: [],
        createdByAdminId: req.body?.createdByAdminId || null,
      });

      createdMissingRecord = true;
      missingRecords = [created.toObject()];
    }

    const infoSet = {
      platform,
      channelId,
      email,
    };

    if (req.body?.channelName !== undefined) {
      infoSet.channelName = String(req.body.channelName || "").trim();
    }

    if (req.body?.channelUrl !== undefined) {
      infoSet.channelUrl = String(req.body.channelUrl || "").trim();
    }

    if (req.body?.thumbnail !== undefined) {
      infoSet.thumbnail = String(req.body.thumbnail || "").trim();
    }

    if (req.body?.country !== undefined) {
      infoSet.country = String(req.body.country || "").trim();
    }

    if (req.body?.creatorTier !== undefined) {
      infoSet.creatorTier = String(req.body.creatorTier || "").trim();
    }

    if (req.body?.subscribers !== undefined) {
      const subscribers = Number(req.body.subscribers);
      if (Number.isFinite(subscribers)) {
        infoSet.subscribers = subscribers;
      }
    }

    const infoMediaKit = await InfoMediaKit.findOneAndUpdate(
      { channelId },
      {
        $set: infoSet,
        $addToSet: {
          emails: email,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    ).lean();

    const invitationUpdateResult = await Invitation.updateMany(
      {
        platform,
        channelId,
      },
      {
        $set: {
          emailTo: email,
        },
      }
    );

    return res.status(200).json({
      status: "success",
      message: "Influencer email updated in MissingEmail and InfoMediaKit.",
      channelId,
      platform,
      email,
      createdMissingRecord,
      missingEmailMatchedCount: missingBefore.length,
      missingEmailModifiedCount:
        missingUpdateResult.modifiedCount ?? missingUpdateResult.nModified ?? 0,
      invitationModifiedCount:
        invitationUpdateResult.modifiedCount ??
        invitationUpdateResult.nModified ??
        0,
      data: {
        missingRecords,
        infoMediaKit,
      },
    });
  } catch (err) {
    console.error("updateInfluencerEmailByChannelId error:", err);

    const statusCode =
      err?.code === 11000 ? 409 : err?.statusCode || err?.status || 500;

    await saveErrorLog(
      req,
      err,
      statusCode,
      "UPDATE_INFLUENCER_EMAIL_BY_CHANNEL_ID_ERROR"
    );

    if (err?.code === 11000) {
      return res.status(409).json({
        status: "error",
        message: "Duplicate record conflict while updating influencer email.",
        duplicateKey: err.keyValue || null,
      });
    }

    return res.status(500).json({
      status: "error",
      message: err?.message || "Internal server error.",
    });
  }
};

module.exports.resolveCreatorEmail = resolveCreatorEmail;