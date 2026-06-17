"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const {
  SESClient,
  SendRawEmailCommand,
} = require("@aws-sdk/client-ses");

const Brand = require("../models/brand");
const influencerModule = require("../models/influencer");
const Influencer = influencerModule.InfluencerModel || influencerModule;

const Campaign = require("../models/campaign");
const { EmailThread, EmailMessage, EmailTemplate } = require("../models/email");
const CampaignApplication = require("../models/applyCampaign");
const Invitation = require("../models/NewInvitations");
const MissingEmail = require("../models/MissingEmail");

const { buildInvitationEmail } = require("../template/invitationTemplate");
const { uploadToGridFS } = require("../utils/gridfs");
const saveErrorLog = require("../services/errorLog.service");

// ===============================
// Constants
// ===============================
const MAX_RAW_EMAIL_BYTES = 10 * 1024 * 1024; // SES raw email hard limit
const MAX_STORED_ATTACHMENT_BYTES = 25 * 1024 * 1024; // allow storing larger files; fallback to links if email gets too large
const BRAND_COOLDOWN_MS = 48 * 60 * 60 * 1000; // 2 days
const DEFAULT_RELAY_DOMAIN = "mail.collabglam.com";
const HANDLE_RX = /^@[A-Za-z0-9._\-]+$/;

const PLATFORM_MAP = new Map([
  ["youtube", "youtube"],
  ["yt", "youtube"],
  ["instagram", "instagram"],
  ["ig", "instagram"],
  ["tiktok", "tiktok"],
  ["tt", "tiktok"],
]);

// ===============================
// AWS SES Client
// ===============================
const ses = new SESClient({
  region: process.env.SES_REGION || process.env.AWS_REGION || "us-east-1",
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

// ===============================
// Small helpers
// ===============================
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const safeStr = (v) => (v === null || v === undefined ? "" : String(v));
const safeLower = (v) => safeStr(v).trim().toLowerCase();

function toIdString(v) {
  if (!v) return "";
  if (typeof v === "object" && v._id) return String(v._id);
  return String(v);
}

function sameId(a, b) {
  return toIdString(a) === toIdString(b);
}

function andQuery(...parts) {
  const cleaned = parts.filter(Boolean);
  if (!cleaned.length) return {};
  if (cleaned.length === 1) return cleaned[0];
  return { $and: cleaned };
}

function getRelayDomain() {
  return (
    safeLower(process.env.EMAIL_RELAY_DOMAIN || DEFAULT_RELAY_DOMAIN) ||
    DEFAULT_RELAY_DOMAIN
  );
}

function normalizeHandle(h) {
  const t = safeStr(h).trim();
  if (!t) return "";
  return t.startsWith("@") ? t : `@${t}`;
}

function getBrandLabel(brand) {
  return (
    safeStr(brand?.brandName).trim() ||
    safeStr(brand?.name).trim() ||
    safeStr(brand?.email).split("@")[0] ||
    "Brand"
  );
}

function getInfluencerLabel(influencer) {
  return (
    safeStr(influencer?.name).trim() ||
    safeStr(influencer?.email).split("@")[0] ||
    "Influencer"
  );
}

function getCampaignTitle(campaignLike) {
  return (
    safeStr(campaignLike?.campaignTitle).trim() ||
    safeStr(campaignLike?.productOrServiceName).trim() ||
    safeStr(campaignLike?.title).trim() ||
    safeStr(campaignLike?.campaignType).trim() ||
    safeStr(campaignLike?.brandName).trim() ||
    "Campaign"
  );
}

function normalizeCampaignObjectId(campaignLike) {
  const id = toIdString(campaignLike?._id || campaignLike);
  return isObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

function buildCampaignSnapshot(campaignLike) {
  const id = campaignLike?._id || campaignLike?.id || null;
  if (!id) return null;

  return {
    _id: id,
    title: getCampaignTitle(campaignLike),
    campaignType: safeStr(campaignLike?.campaignType).trim(),
  };
}

function serializeCampaign(campaignLike, campaignSnapshot = null) {
  const populated =
    campaignLike && typeof campaignLike === "object" ? campaignLike : null;

  const campaignId = populated?._id
    ? String(populated._id)
    : campaignLike
    ? String(campaignLike)
    : campaignSnapshot?._id
    ? String(campaignSnapshot._id)
    : null;

  const title = populated
    ? getCampaignTitle(populated)
    : safeStr(campaignSnapshot?.title).trim();

  const campaignType = populated
    ? safeStr(populated.campaignType).trim()
    : safeStr(campaignSnapshot?.campaignType).trim();

  if (!campaignId && !title && !campaignType) return null;

  return {
    _id: campaignId,
    title,
    campaignType,
  };
}

function slugifyLocalPart(value, fallback = "user") {
  const slug = safeLower(value).replace(/[^a-z0-9]+/g, "").slice(0, 30);
  return slug || fallback;
}

function computeInfluencerDisplayAlias(influencer) {
  if (influencer?.proxyEmail) return safeLower(influencer.proxyEmail);
  return `${slugifyLocalPart(
    getInfluencerLabel(influencer),
    "influencer"
  )}@${getRelayDomain()}`;
}

function buildStandardHtml(bodyText) {
  const safe = safeStr(bodyText || "");
  return `<p>${safe.replace(/\n/g, "<br/>")}</p>
<hr/>
<p style="font-size:12px;color:#666;">
  Sent via ${safeStr(process.env.PLATFORM_NAME || "CollabGlam")} – your email is hidden.
</p>`;
}

function renderTemplateString(str, context = {}) {
  if (!str) return str;

  const map = {
    brandName: context.brandName || "",
    influencerName: context.influencerName || "",
    platformName: process.env.PLATFORM_NAME || "CollabGlam",
  };

  return String(str).replace(
    /{{\s*(brandName|influencerName|platformName)\s*}}/gi,
    (_, key) => map[key] || ""
  );
}

function normalizeAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.map((att) => ({
        filename: att.filename || att.name || "attachment",
        contentType: att.contentType || "application/octet-stream",
        contentBase64: att.contentBase64 || att.content || "",
        size: Number(att.size) || 0,
      }))
    : [];
}

function buildBrandOwnershipMatch(brandOrId) {
  const clauses = [];
  const mongoId = toIdString(brandOrId?._id || brandOrId);
  const legacyBrandId = safeStr(brandOrId?.brandId || "");

  if (isObjectId(mongoId)) {
    clauses.push({ brand: new mongoose.Types.ObjectId(mongoId) });
    clauses.push({ brandId: mongoId });
  }

  if (legacyBrandId && legacyBrandId !== mongoId) {
    clauses.push({ brandId: legacyBrandId });
  }

  if (!clauses.length) return null;
  if (clauses.length === 1) return clauses[0];
  return { $or: clauses };
}

function pickProfileImageFromPage(page = []) {
  if (!Array.isArray(page)) return "";

  for (const item of page) {
    const direct =
      item?.profileImage ||
      item?.profilePic ||
      item?.profilePicture ||
      item?.avatarUrl ||
      item?.avatar ||
      item?.image ||
      item?.photo ||
      item?.picture ||
      item?.data?.profile?.picture ||
      item?.data?.picture ||
      item?.providerRaw?.profile?.picture ||
      item?.providerRaw?.picture ||
      "";

    if (direct) return safeStr(direct).trim();
  }

  return "";
}

function getBrandImage(brandLike = {}) {
  return (
    safeStr(brandLike?.profileImage).trim() ||
    safeStr(brandLike?.profilePic).trim() ||
    safeStr(brandLike?.logoUrl).trim() ||
    safeStr(brandLike?.avatarUrl).trim() ||
    safeStr(brandLike?.image).trim() ||
    safeStr(brandLike?.photo).trim() ||
    ""
  );
}

function getInfluencerImage(influencerLike = {}) {
  return (
    safeStr(influencerLike?.profileImage).trim() ||
    safeStr(influencerLike?.profilePic).trim() ||
    safeStr(influencerLike?.profilePicture).trim() ||
    safeStr(influencerLike?.avatarUrl).trim() ||
    safeStr(influencerLike?.avatar).trim() ||
    safeStr(influencerLike?.image).trim() ||
    safeStr(influencerLike?.photo).trim() ||
    pickProfileImageFromPage(influencerLike?.page1) ||
    pickProfileImageFromPage(influencerLike?.page2) ||
    pickProfileImageFromPage(influencerLike?.page3) ||
    ""
  );
}

function publicBrand(brandLike = {}, threadLike = {}) {
  const id = brandLike?._id ? String(brandLike._id) : null;
  const proxyEmail =
    safeLower(threadLike?.brandDisplayAlias) ||
    safeLower(brandLike?.proxyEmail) ||
    safeLower(threadLike?.brandAliasEmail) ||
    "";

  const profileImage = getBrandImage(brandLike);

  return {
    _id: id,
    brandId: id,
    name:
      safeStr(brandLike?.brandName).trim() ||
      safeStr(brandLike?.name).trim() ||
      safeStr(threadLike?.brandSnapshot?.name).trim() ||
      "Brand",
    email: safeLower(brandLike?.email),
    proxyEmail,
    aliasEmail: proxyEmail,
    profileImage,
    profilePic: profileImage,
    logoUrl: profileImage,
  };
}

function publicInfluencer(influencerLike = {}, threadLike = {}) {
  const id = influencerLike?._id ? String(influencerLike._id) : null;
  const proxyEmail =
    safeLower(threadLike?.influencerDisplayAlias) ||
    safeLower(influencerLike?.proxyEmail) ||
    safeLower(threadLike?.influencerAliasEmail) ||
    computeInfluencerDisplayAlias(influencerLike || threadLike?.influencerSnapshot);

  const profileImage = getInfluencerImage(influencerLike);

  return {
    _id: id,
    influencerId: id,
    name:
      safeStr(influencerLike?.name).trim() ||
      safeStr(threadLike?.influencerSnapshot?.name).trim() ||
      "Influencer",
    email: safeLower(influencerLike?.email),
    proxyEmail,
    aliasEmail: proxyEmail,
    profileImage,
    profilePic: profileImage,
    avatarUrl: profileImage,
  };
}

async function uploadEmailAttachmentsToGridFS({
  req,
  safeAttachments,
  metadata,
}) {
  if (!safeAttachments.length) return [];

  const filesForGrid = safeAttachments.map((att) => {
    const raw = safeStr(att.contentBase64).trim();
    const base64 = raw.includes(",") ? raw.split(",").pop() : raw;

    if (!base64) {
      const err = new Error(`Attachment "${att.filename}" has no content`);
      err.statusCode = 400;
      throw err;
    }

    const buffer = Buffer.from(base64, "base64");

    if (buffer.length > MAX_STORED_ATTACHMENT_BYTES) {
      const err = new Error(
        `Attachment "${att.filename}" is too large. Max allowed upload size is 25MB.`
      );
      err.statusCode = 413;
      throw err;
    }

    return {
      originalname: att.filename,
      mimetype: att.contentType,
      buffer,
      size: buffer.length,
    };
  });

  return uploadToGridFS(filesForGrid, {
    req,
    prefix: "email",
    metadata,
  });
}

// ===============================
// MIME builder for SES raw send
// ===============================
function splitBase64Lines(input) {
  return String(input || "").replace(/.{1,76}/g, "$&\r\n").trim();
}

function encodeHeaderUtf8(value) {
  const str = safeStr(value);
  if (!str) return "";
  return `=?UTF-8?B?${Buffer.from(str, "utf8").toString("base64")}?=`;
}

function escapeHeaderParam(value) {
  return safeStr(value || "attachment")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ");
}

function normalizeRecipientList(value) {
  if (!value) return [];

  const rawList = Array.isArray(value)
    ? value
    : safeStr(value)
        .split(/[;,]/g)
        .map((v) => v.trim());

  return rawList.map((v) => safeLower(v)).filter(Boolean);
}

function appendAttachmentLinksToBodies({
  htmlBody,
  textBody,
  attachmentLinks = [],
}) {
  const links = Array.isArray(attachmentLinks)
    ? attachmentLinks.filter((item) => item?.url)
    : [];

  if (!links.length) {
    return {
      htmlBody: safeStr(htmlBody),
      textBody: safeStr(textBody),
    };
  }

  const htmlLinks = links
    .map((item) => {
      const safeName = safeStr(item.filename || "Attachment");
      const safeUrl = safeStr(item.url);
      return `<li><a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeName}</a></li>`;
    })
    .join("");

  const textLinks = links
    .map(
      (item) =>
        `- ${safeStr(item.filename || "Attachment")}: ${safeStr(item.url)}`
    )
    .join("\n");

  return {
    htmlBody: `${safeStr(htmlBody)}
<hr/>
<p><strong>Attachments shared as download links</strong></p>
<ul>${htmlLinks}</ul>`,
    textBody: `${safeStr(textBody)}

Attachments shared as download links
${textLinks}`,
  };
}

function buildRawMimeEmail({
  fromAlias,
  fromName,
  toRealEmail,
  headerTo,
  cc = [],
  subject,
  htmlBody,
  textBody,
  replyTo,
  inReplyTo,
  references = [],
  attachments = [],
}) {
  const safeSubject = encodeHeaderUtf8(subject || "(no subject)");
  const safeFromName = encodeHeaderUtf8(fromName || "CollabGlam");
  const altBoundary = `alt_${crypto.randomUUID()}`;
  const mixedBoundary = `mix_${crypto.randomUUID()}`;

  const normalizedCc = normalizeRecipientList(cc);
  const visibleTo = safeStr(headerTo || toRealEmail).trim() || toRealEmail;

  const normalizedReferences = Array.isArray(references)
    ? references.map((v) => safeStr(v).trim()).filter(Boolean)
    : [];

  const textPart = splitBase64Lines(
    Buffer.from(safeStr(textBody || ""), "utf8").toString("base64")
  );

  const htmlPart = splitBase64Lines(
    Buffer.from(safeStr(htmlBody || ""), "utf8").toString("base64")
  );

  const headers = [
    `From: ${safeFromName} <${fromAlias}>`,
    `To: ${visibleTo}`,
    normalizedCc.length ? `Cc: ${normalizedCc.join(", ")}` : "",
    replyTo ? `Reply-To: ${replyTo}` : "",
    `Subject: ${safeSubject}`,
    inReplyTo ? `In-Reply-To: <${inReplyTo}>` : "",
    normalizedReferences.length
      ? `References: ${normalizedReferences.map((v) => `<${v}>`).join(" ")}`
      : "",
    "MIME-Version: 1.0",
  ].filter(Boolean);

  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  if (!hasAttachments) {
    const raw = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      `--${altBoundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      textPart,
      "",
      `--${altBoundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      htmlPart,
      "",
      `--${altBoundary}--`,
      "",
    ].join("\r\n");

    return Buffer.from(raw, "utf8");
  }

  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
    "",
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    textPart,
    "",
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    htmlPart,
    "",
    `--${altBoundary}--`,
    "",
  ];

  for (const attachment of attachments) {
    const filename = escapeHeaderParam(attachment.filename || "attachment");
    const contentType = attachment.contentType || "application/octet-stream";
    const rawContent = safeStr(attachment.contentBase64).trim();
    const base64 = rawContent.includes(",")
      ? rawContent.split(",").pop()
      : rawContent;

    if (!base64) continue;

    lines.push(
      `--${mixedBoundary}`,
      `Content-Type: ${contentType}; name="${filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${filename}"`,
      "",
      splitBase64Lines(base64.replace(/\s+/g, "")),
      ""
    );
  }

  lines.push(`--${mixedBoundary}--`, "");

  return Buffer.from(lines.join("\r\n"), "utf8");
}

async function sendViaSES({
  fromAlias,
  fromName,
  toRealEmail,
  headerTo,
  cc,
  bcc,
  subject,
  htmlBody,
  textBody,
  replyTo,
  inReplyTo,
  references,
  attachments,
  attachmentLinks = [],
}) {
  const ccList = normalizeRecipientList(cc);
  const bccList = normalizeRecipientList(bcc);

  let finalHtmlBody = safeStr(htmlBody);
  let finalTextBody = safeStr(textBody);
  let finalAttachments = attachments || [];

  let rawMessage = buildRawMimeEmail({
    fromAlias,
    fromName,
    toRealEmail,
    headerTo,
    cc: ccList,
    subject,
    htmlBody: finalHtmlBody,
    textBody: finalTextBody,
    replyTo,
    inReplyTo,
    references,
    attachments: finalAttachments,
  });

  if (Buffer.byteLength(rawMessage) > MAX_RAW_EMAIL_BYTES) {
    if (!attachmentLinks.length) {
      const err = new Error(
        "Email is too large to send. Please reduce attachment size or send fewer files."
      );
      err.statusCode = 413;
      throw err;
    }

    const linkBodies = appendAttachmentLinksToBodies({
      htmlBody: finalHtmlBody,
      textBody: finalTextBody,
      attachmentLinks,
    });

    finalHtmlBody = linkBodies.htmlBody;
    finalTextBody = linkBodies.textBody;
    finalAttachments = [];

    rawMessage = buildRawMimeEmail({
      fromAlias,
      fromName,
      toRealEmail,
      headerTo,
      cc: ccList,
      subject,
      htmlBody: finalHtmlBody,
      textBody: finalTextBody,
      replyTo,
      inReplyTo,
      references,
      attachments: finalAttachments,
    });

    if (Buffer.byteLength(rawMessage) > MAX_RAW_EMAIL_BYTES) {
      const err = new Error(
        "Email content is too large to send, even after converting attachments to links."
      );
      err.statusCode = 413;
      throw err;
    }
  }

  const cmd = new SendRawEmailCommand({
    Source: fromAlias,
    Destinations: [toRealEmail, ...ccList, ...bccList],
    RawMessage: { Data: rawMessage },
  });

  try {
    const result = await ses.send(cmd);

    if (!result?.MessageId) {
      throw new Error("SES send succeeded without a MessageId");
    }

    return {
      ...result,
      finalHtmlBody,
      finalTextBody,
      usedAttachmentLinksOnly:
        finalAttachments.length === 0 && attachmentLinks.length > 0,
    };
  } catch (err) {
    console.error("SES raw send error:", err);
    throw err;
  }
}

// ===============================
// Finders
// ===============================
async function findBrandById(id) {
  if (!id) return null;

  if (isObjectId(id)) {
    const byMongo = await Brand.findById(id);
    if (byMongo) return byMongo;
  }

  return Brand.findOne({ brandId: id });
}

async function findInfluencerById(id) {
  if (!id) return null;

  if (isObjectId(id)) {
    const byMongo = await Influencer.findById(id);
    if (byMongo) return byMongo;
  }

  return Influencer.findOne({ influencerId: id });
}

async function findCampaignByIdOrCampaignsId(id) {
  if (!id) return null;

  if (isObjectId(id)) {
    const byMongo = await Campaign.findById(id);
    if (byMongo) return byMongo;
  }

  return Campaign.findOne({ campaignsId: id });
}

// ===============================
// Proxy-email helpers
// ===============================
async function proxyEmailExists(email, exclude = {}) {
  const normalized = safeLower(email);
  if (!normalized) return false;

  const brandMatch = await Brand.findOne({
    proxyEmail: normalized,
    ...(exclude.brandId ? { _id: { $ne: exclude.brandId } } : {}),
  }).select("_id");

  if (brandMatch) return true;

  const influencerMatch = await Influencer.findOne({
    proxyEmail: normalized,
    ...(exclude.influencerId ? { _id: { $ne: exclude.influencerId } } : {}),
  }).select("_id");

  return !!influencerMatch;
}

async function generateUniqueProxyEmail(baseName, exclude = {}) {
  const domain = getRelayDomain();
  const base = slugifyLocalPart(baseName, "user");

  let attempt = 0;
  while (attempt < 500) {
    const local = attempt === 0 ? base : `${base}${attempt + 1}`;
    const email = `${local}@${domain}`;
    const exists = await proxyEmailExists(email, exclude);
    if (!exists) return email;
    attempt += 1;
  }

  throw new Error("Unable to generate unique proxy email");
}

async function ensureBrandProxyEmail(brandDoc) {
  if (brandDoc.proxyEmail) return safeLower(brandDoc.proxyEmail);

  const proxyEmail = await generateUniqueProxyEmail(getBrandLabel(brandDoc), {
    brandId: brandDoc._id,
  });

  brandDoc.proxyEmail = proxyEmail;
  await brandDoc.save();

  return proxyEmail;
}

async function ensureInfluencerProxyEmail(influencerDoc) {
  if (influencerDoc.proxyEmail) return safeLower(influencerDoc.proxyEmail);

  const proxyEmail = await generateUniqueProxyEmail(
    getInfluencerLabel(influencerDoc),
    {
      influencerId: influencerDoc._id,
    }
  );

  influencerDoc.proxyEmail = proxyEmail;
  await influencerDoc.save();

  return proxyEmail;
}

// ===============================
// Thread matching
// ===============================
function threadMatchForBrand(brandDoc) {
  return { brand: brandDoc._id };
}

function getReadState(threadLike, role) {
  const safeRole = role === "brand" ? "brand" : "influencer";
  const unreadField =
    safeRole === "brand" ? "brandUnreadCount" : "influencerUnreadCount";
  const readAtField =
    safeRole === "brand" ? "brandLastReadAt" : "influencerLastReadAt";

  const unreadCount = Math.max(0, Number(threadLike?.[unreadField] || 0));

  return {
    unreadCount,
    isUnread: unreadCount > 0,
    lastReadAt: threadLike?.[readAtField] || null,
  };
}

function buildReadPatch(role) {
  const now = new Date();

  if (role === "brand") {
    return {
      brandLastReadAt: now,
      brandUnreadCount: 0,
    };
  }

  return {
    influencerLastReadAt: now,
    influencerUnreadCount: 0,
  };
}

async function assertThreadAccessForRead({ thread, role, brandId, influencerId }) {
  if (role === "brand") {
    if (!brandId) {
      const err = new Error("brandId is required to mark brand thread as read.");
      err.statusCode = 400;
      throw err;
    }

    const brand = await findBrandById(brandId);
    if (!brand) {
      const err = new Error("Brand not found");
      err.statusCode = 404;
      throw err;
    }

    if (!sameId(thread.brand, brand._id)) {
      const err = new Error("Forbidden");
      err.statusCode = 403;
      throw err;
    }

    return;
  }

  if (!influencerId) {
    const err = new Error(
      "influencerId is required to mark influencer thread as read."
    );
    err.statusCode = 400;
    throw err;
  }

  const influencer = await findInfluencerById(influencerId);
  if (!influencer) {
    const err = new Error("Influencer not found");
    err.statusCode = 404;
    throw err;
  }

  if (!sameId(thread.influencer, influencer._id)) {
    const err = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }
}

async function markThreadAsRead(req, res) {
  try {
    const { threadId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(String(threadId))) {
      return res.status(400).json({ error: "Invalid threadId" });
    }

    const role = safeLower(req.body?.role || req.query?.role);
    const brandId = req.body?.brandId || req.query?.brandId;
    const influencerId = req.body?.influencerId || req.query?.influencerId;

    if (!["brand", "influencer"].includes(role)) {
      return res.status(400).json({
        error: 'role is required and must be either "brand" or "influencer".',
      });
    }

    const thread = await EmailThread.findById(threadId).lean();

    if (!thread) {
      return res.status(404).json({ error: "Thread not found" });
    }

    await assertThreadAccessForRead({
      thread,
      role,
      brandId,
      influencerId,
    });

    const patch = buildReadPatch(role);

    await EmailThread.updateOne(
      { _id: thread._id },
      {
        $set: patch,
      }
    );

    return res.status(200).json({
      success: true,
      threadId: String(thread._id),
      role,
      unreadCount: 0,
      isUnread: false,
      lastReadAt:
        role === "brand" ? patch.brandLastReadAt : patch.influencerLastReadAt,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "MARK_THREAD_AS_READ_ERROR");
    console.error("markThreadAsRead error:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Internal server error",
    });
  }
}

// ===============================
// Brand follow-up policy
// ===============================
async function enforceBrandPolicyOrThrow(threadId) {
  const influencerHasReplied = await EmailMessage.exists({
    thread: threadId,
    direction: "influencer_to_brand",
  });

  if (influencerHasReplied) return;

  const brandCount = await EmailMessage.countDocuments({
    thread: threadId,
    direction: "brand_to_influencer",
  });

  if (brandCount === 0) return;

  if (brandCount === 1) {
    const first = await EmailMessage.findOne({
      thread: threadId,
      direction: "brand_to_influencer",
    })
      .sort({ createdAt: 1 })
      .select({ createdAt: 1 })
      .lean();

    const firstAt = first?.createdAt || new Date();
    const nextAllowedAt = new Date(firstAt.getTime() + BRAND_COOLDOWN_MS);

    if (Date.now() < nextAllowedAt.getTime()) {
      const err = new Error(
        `You can send a follow-up after ${nextAllowedAt.toISOString()}`
      );
      err.statusCode = 429;
      err.code = "BRAND_EMAIL_COOLDOWN";
      err.meta = { nextAllowedAt };
      throw err;
    }

    return;
  }

  const err = new Error(
    "You already sent a follow-up. Wait for the influencer to reply before sending another email."
  );
  err.statusCode = 409;
  err.code = "BRAND_WAITING_FOR_REPLY";
  throw err;
}

// ===============================
// Thread creation / sync
// ===============================
async function syncThreadWithLiveParticipants(
  thread,
  brand,
  influencer,
  campaign,
  subject
) {
  const brandProxy = await ensureBrandProxyEmail(brand);
  const influencerProxy = await ensureInfluencerProxyEmail(influencer);

  thread.brand = brand._id;
  thread.influencer = influencer._id;
  thread.campaign = campaign?._id || null;

  thread.brandAliasEmail = brandProxy;
  thread.influencerAliasEmail = influencerProxy;

  thread.brandDisplayAlias = brandProxy;
  thread.influencerDisplayAlias = influencerProxy;

  thread.brandSnapshot = {
    name: getBrandLabel(brand),
    email: brand.email,
  };

  thread.influencerSnapshot = {
    name: getInfluencerLabel(influencer),
    email: influencer.email,
  };

  thread.campaignSnapshot = buildCampaignSnapshot(campaign);

  if (!thread.subject && subject) thread.subject = subject;

  return thread;
}

async function getOrCreateThread({
  brand,
  influencer,
  campaign,
  createdBy,
  subject,
}) {
  const normalizedCampaignId = normalizeCampaignObjectId(campaign);

  const brandProxy = await ensureBrandProxyEmail(brand);
  const influencerProxy = await ensureInfluencerProxyEmail(influencer);

  const filter = {
    brand: brand._id,
    influencer: influencer._id,
    campaign: normalizedCampaignId,
  };

  const update = {
    $set: {
      brand: brand._id,
      influencer: influencer._id,
      campaign: normalizedCampaignId,

      brandSnapshot: {
        name: getBrandLabel(brand),
        email: brand.email,
      },

      influencerSnapshot: {
        name: getInfluencerLabel(influencer),
        email: influencer.email,
      },

      campaignSnapshot: buildCampaignSnapshot(campaign),

      brandAliasEmail: brandProxy,
      influencerAliasEmail: influencerProxy,

      brandDisplayAlias: brandProxy,
      influencerDisplayAlias: influencerProxy,
    },

    $setOnInsert: {
      subject: subject || undefined,
      status: "active",
      createdBy: createdBy || "system",
    },
  };

  const thread = await EmailThread.findOneAndUpdate(filter, update, {
    new: true,
    upsert: true,
    setDefaultsOnInsert: true,
  });

  if (subject && !thread.subject) {
    thread.subject = subject;
    await thread.save();
  }

  return thread;
}

// ===============================
// Shared send helper
// ===============================
async function createAndSendMessage({
  req,
  thread,
  brand,
  influencer,
  campaign,
  direction,
  subject,
  body,
  htmlBodyOverride,
  attachments,
  context,
}) {
  const safeAttachments = normalizeAttachments(attachments);

  const metadata = {
    kind: "email-attachment",
    brand: String(brand._id),
    influencer: String(influencer._id),
    brandId: String(brand._id),
    influencerId: String(influencer._id),
    direction,
    context,
  };

  if (campaign?._id) {
    metadata.campaign = String(campaign._id);
    metadata.campaignId = String(campaign._id);
  }

  const uploadedFiles = await uploadEmailAttachmentsToGridFS({
    req,
    safeAttachments,
    metadata,
  });

  const attachmentMeta = uploadedFiles.map((f) => ({
    filename: f.originalName || f.filename,
    contentType: f.mimeType,
    size: f.size,
    storageKey: String(f.id),
    url: f.url,
  }));

  const attachmentLinks = attachmentMeta
    .filter((file) => file.url)
    .map((file) => ({
      filename: file.filename,
      url: file.url,
      size: file.size,
    }));

  const htmlBody = htmlBodyOverride || buildStandardHtml(body);
  const textBody = safeStr(body);

  const brandLabel = getBrandLabel(brand);
  const influencerLabel = getInfluencerLabel(influencer);

  const fromAlias =
    direction === "brand_to_influencer"
      ? thread.brandDisplayAlias || thread.brandAliasEmail
      : thread.influencerDisplayAlias || thread.influencerAliasEmail;

  const fromProxyEmail =
    direction === "brand_to_influencer"
      ? thread.brandAliasEmail
      : thread.influencerAliasEmail;

  const toProxyEmail =
    direction === "brand_to_influencer"
      ? thread.influencerAliasEmail
      : thread.brandAliasEmail;

  const toRealEmail =
    direction === "brand_to_influencer" ? influencer.email : brand.email;

  const fromRealEmail =
    direction === "brand_to_influencer" ? brand.email : influencer.email;

  const fromName =
    direction === "brand_to_influencer"
      ? `${brandLabel} via ${process.env.PLATFORM_NAME || "CollabGlam"}`
      : `${influencerLabel} via ${process.env.PLATFORM_NAME || "CollabGlam"}`;

  const replyTo = fromProxyEmail;
  const headerTo = toProxyEmail || toRealEmail;

  const previousExternalMessages = await EmailMessage.find({
    thread: thread._id,
    forwardedSesMessageId: { $exists: true, $ne: null },
  })
    .sort({ createdAt: 1 })
    .select({ forwardedSesMessageId: 1 })
    .lean();

  const previousForwardedIds = previousExternalMessages
    .map((m) => safeStr(m.forwardedSesMessageId).trim())
    .filter(Boolean);

  const threadInReplyTo =
    previousForwardedIds.length > 0
      ? previousForwardedIds[previousForwardedIds.length - 1]
      : undefined;

  const threadReferences = previousForwardedIds;

  const sesResult = await sendViaSES({
    fromAlias,
    fromName,
    toRealEmail,
    headerTo,
    subject,
    htmlBody,
    textBody,
    replyTo,
    inReplyTo: threadInReplyTo,
    references: threadReferences,
    attachments: safeAttachments,
    attachmentLinks,
  });

  const dbMessageId = sesResult.MessageId;
  const finalHtmlBody = sesResult.finalHtmlBody || htmlBody;
  const finalTextBody = sesResult.finalTextBody || textBody;

  const msg = await EmailMessage.create({
    thread: thread._id,
    direction,
    messageId: dbMessageId,

    fromUser: direction === "brand_to_influencer" ? brand._id : influencer._id,
    fromUserModel:
      direction === "brand_to_influencer" ? "Brand" : "Influencer",

    fromAliasEmail: fromAlias,
    fromProxyEmail,
    fromRealEmail,
    toRealEmail,
    toProxyEmail,

    subject,
    htmlBody: finalHtmlBody,
    textBody: finalTextBody,

    attachments: attachmentMeta,
    sentAt: new Date(),
    forwardedSesMessageId: sesResult.MessageId,
  });

  thread.brand = brand._id;
  thread.influencer = influencer._id;
  thread.campaign = campaign?._id || null;

  thread.lastMessageAt = msg.createdAt;
  thread.lastMessageDirection = direction;
  thread.lastMessageSnippet = safeStr(finalTextBody).slice(0, 200);
  const readAt = msg.createdAt || new Date();

  if (direction === "brand_to_influencer") {
    thread.brandLastReadAt = readAt;
    thread.brandUnreadCount = 0;
    thread.influencerUnreadCount =
      Math.max(0, Number(thread.influencerUnreadCount || 0)) + 1;
  }

  if (direction === "influencer_to_brand") {
    thread.influencerLastReadAt = readAt;
    thread.influencerUnreadCount = 0;
    thread.brandUnreadCount =
      Math.max(0, Number(thread.brandUnreadCount || 0)) + 1;
  }
  thread.brandSnapshot = {
    name: brandLabel,
    email: brand.email,
  };

  thread.influencerSnapshot = {
    name: influencerLabel,
    email: influencer.email,
  };

  thread.campaignSnapshot = buildCampaignSnapshot(campaign);

  thread.brandDisplayAlias = thread.brandAliasEmail;
  thread.influencerDisplayAlias = thread.influencerAliasEmail;

  if (!thread.subject && subject) thread.subject = subject;

  await thread.save();

  return {
    success: true,
    thread,
    message: msg,
    sesMessageId: sesResult.MessageId,
    usedAttachmentLinksOnly: !!sesResult.usedAttachmentLinksOnly,
  };
}

// ===============================
// Resolve influencer and recipient email
// ===============================
async function resolveInfluencerAndEmail({
  influencerId,
  invitationId,
  brand,
}) {
  if (influencerId) {
    const influencer = await findInfluencerById(influencerId);
    if (!influencer) {
      const err = new Error("Influencer not found");
      err.statusCode = 404;
      throw err;
    }

    return {
      influencer,
      influencerName: getInfluencerLabel(influencer),
      recipientEmail: influencer.email,
    };
  }

  if (!invitationId) {
    const err = new Error("Either influencerId or invitationId is required");
    err.statusCode = 400;
    throw err;
  }

  const invitation = await Invitation.findOne({ invitationId }).lean();
  if (!invitation) {
    const err = new Error("Invitation not found");
    err.statusCode = 404;
    throw err;
  }

  const invitationBrandRef = invitation.brand || invitation.brandId;
  if (brand?._id && invitationBrandRef && !sameId(invitationBrandRef, brand._id)) {
    const err = new Error("Invitation does not belong to this brand");
    err.statusCode = 403;
    throw err;
  }

  const missing = invitation.missingEmailId
    ? await MissingEmail.findOne({
        missingEmailId: invitation.missingEmailId,
      }).lean()
    : await MissingEmail.findOne({
        handle: safeLower(invitation.handle || ""),
      }).lean();

  if (!missing?.email) {
    const err = new Error("Recipient email not found for this invitation");
    err.statusCode = 404;
    throw err;
  }

  const recipientEmail = safeLower(missing.email);
  const influencerName =
    missing.youtube?.title ||
    (missing.handle
      ? safeStr(missing.handle).replace(/^@/, "")
      : recipientEmail.split("@")[0]);

  let influencer = await Influencer.findOne({ email: recipientEmail });

  if (!influencer) {
    influencer = await Influencer.create({
      email: recipientEmail,
      name: influencerName,
      countryName: "Unknown",
    });
  }

  return { influencer, influencerName, recipientEmail };
}

// ===============================
// Campaign invitation HTML injection
// ===============================
function insertCustomBodyIntoTemplate({ templateHtml, customBody }) {
  const custom = safeStr(customBody).trim();
  if (!custom) return templateHtml;

  const customHtmlBlock = `<p>${custom
    .split("\n")
    .map((line) => safeStr(line).trim())
    .join("<br/>")}</p><br/>`;

  const marker =
    '<h3 style="margin-top:24px;margin-bottom:8px;font-size:16px;color:#111827;">Campaign Details</h3>';

  if (templateHtml.includes(marker)) {
    return templateHtml.replace(marker, `${customHtmlBlock}${marker}`);
  }

  return `${customHtmlBlock}${templateHtml}`;
}

// ===============================
// Internal: send campaign invitation
// ===============================
async function sendCampaignInvitationInternal(payload = {}) {
  const {
    brandId,
    campaignId,
    influencerId,
    invitationId,
    campaignLink,
    compensation,
    deliverables,
    additionalNotes,
    subject: customSubject,
    body: customBody,
    attachments,
    _request,
  } = payload;

  if (!brandId) {
    const err = new Error("brandId is required.");
    err.statusCode = 400;
    throw err;
  }

  if (!influencerId && !invitationId) {
    const err = new Error("Either influencerId or invitationId is required.");
    err.statusCode = 400;
    throw err;
  }

  const brand = await findBrandById(brandId);
  if (!brand) {
    const err = new Error("Brand not found");
    err.statusCode = 404;
    throw err;
  }

  const { influencer, influencerName, recipientEmail } =
    await resolveInfluencerAndEmail({
      influencerId,
      invitationId,
      brand,
    });

  let campaign = null;
  if (campaignId) {
    campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) {
      const err = new Error("Campaign not found");
      err.statusCode = 404;
      throw err;
    }
  }

  const thread = await getOrCreateThread({
    brand,
    influencer,
    campaign,
    createdBy: "brand",
    subject: customSubject || undefined,
  });

  await enforceBrandPolicyOrThrow(thread._id);

  let subject = safeStr(customSubject).trim();
  let htmlBody = "";
  let textBody = "";

  if (campaign) {
    const brandName = getBrandLabel(brand);
    const campaignTitle = getCampaignTitle(campaign);
    const campaignObjective = campaign.goal || campaign.description || "";

    const defaultDeliverables =
      Array.isArray(campaign.creativeBrief) && campaign.creativeBrief.length
        ? campaign.creativeBrief.join(", ")
        : campaign.creativeBriefText ||
          "Content deliverables to be discussed with you.";

    const finalDeliverables = deliverables || defaultDeliverables;

    const finalCompensation =
      compensation ||
      "Compensation will be discussed based on your standard rates and the campaign scope.";

    let timelineText = "Flexible / To be discussed";
    if (campaign.timeline?.startDate && campaign.timeline?.endDate) {
      const start = new Date(campaign.timeline.startDate);
      const end = new Date(campaign.timeline.endDate);
      const fmt = (d) =>
        d.toLocaleDateString("en-US", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        });
      timelineText = `${fmt(start)} – ${fmt(end)}`;
    }

    const notes =
      additionalNotes || campaign.additionalNotes || campaign.description || "";

    const baseUrl = safeStr(process.env.CAMPAIGN_BASE_URL || "");
    const campaignPublicId = campaign.campaignsId || campaign._id;
    const link =
      campaignLink ||
      (baseUrl
        ? `${baseUrl.replace(
            /\/$/,
            ""
          )}/influencer/new-collab/view-campaign?id=${campaignPublicId}`
        : "#");

    const template = buildInvitationEmail({
      brandName,
      influencerName,
      campaignTitle,
      campaignObjective,
      deliverables: finalDeliverables,
      compensation: finalCompensation,
      timeline: timelineText,
      additionalNotes: notes,
      campaignLink: link,
    });

    subject = subject || template.subject;

    if (safeStr(customBody).trim()) {
      htmlBody = insertCustomBodyIntoTemplate({
        templateHtml: template.htmlBody,
        customBody,
      });
      textBody = `${safeStr(customBody).trim()}\n\n${template.textBody}`;
    } else {
      htmlBody = template.htmlBody;
      textBody = template.textBody;
    }
  } else {
    subject =
      subject || `Collaboration opportunity with ${getBrandLabel(brand)}`;

    if (safeStr(customBody).trim()) {
      textBody = safeStr(customBody).trim();
      htmlBody = buildStandardHtml(textBody);
    } else {
      const lines = [];
      lines.push(`Hi ${influencerName || "there"},`);
      lines.push("");
      lines.push(
        `${getBrandLabel(
          brand
        )} would love to explore a collaboration with you on upcoming content.`
      );
      lines.push("");
      lines.push(
        "If this sounds interesting, just hit reply and we can go over the details together."
      );
      lines.push("");
      lines.push("Best,");
      lines.push(`${getBrandLabel(brand)} team`);

      textBody = lines.join("\n");
      htmlBody = buildStandardHtml(textBody);
    }
  }

  const result = await createAndSendMessage({
    req: _request,
    thread,
    brand,
    influencer,
    campaign,
    direction: "brand_to_influencer",
    subject,
    body: textBody,
    htmlBodyOverride: htmlBody,
    attachments,
    context: "campaign-invitation",
  });

  return {
    success: true,
    threadId: result.thread._id,
    messageId: result.message._id,
    recipientEmail,
    brandAliasEmail: result.thread.brandAliasEmail,
    brandDisplayAlias: result.thread.brandDisplayAlias,
    influencerDisplayAlias: result.thread.influencerDisplayAlias,
    subject,
    campaignId: campaign ? String(campaign._id) : null,
    usedAttachmentLinksOnly: !!result.usedAttachmentLinksOnly,
  };
}

// ===============================
// Controllers
// ===============================

// GET /api/email/templates/:key?brandId=...&influencerId=...
async function getTemplateByKey(req, res) {
  try {
    const { key } = req.params;
    const { brandId, influencerId } = req.query;

    const template = await EmailTemplate.findOne({ key }).lean();
    if (!template) {
      return res.status(404).json({ error: "Template not found" });
    }

    let brandName = "";
    let influencerName = "";

    if (brandId) {
      const b = await findBrandById(brandId);
      if (b) brandName = getBrandLabel(b);
    }

    if (influencerId) {
      const i = await findInfluencerById(influencerId);
      if (i) influencerName = getInfluencerLabel(i);
    }

    const ctx = { brandName, influencerName };

    return res.status(200).json({
      templateId: template._id,
      key: template.key,
      name: template.name,
      subject: renderTemplateString(template.subject, ctx),
      htmlBody: renderTemplateString(template.htmlBody, ctx),
      textBody: renderTemplateString(template.textBody || "", ctx),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_TEMPLATE_BY_KEY_ERROR");
    console.error("getTemplateByKey error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/email/threads
async function createThread(req, res) {
  try {
    const { brandId, influencerId, campaignId, subject } = req.body;

    if (!brandId || !influencerId) {
      return res
        .status(400)
        .json({ error: "brandId and influencerId are required." });
    }

    const brand = await findBrandById(brandId);
    const influencer = await findInfluencerById(influencerId);
    const campaign = campaignId
      ? await findCampaignByIdOrCampaignsId(campaignId)
      : null;

    if (!brand) return res.status(404).json({ error: "Brand not found" });
    if (!influencer) {
      return res.status(404).json({ error: "Influencer not found" });
    }
    if (campaignId && !campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const thread = await getOrCreateThread({
      brand,
      influencer,
      campaign,
      createdBy: "system",
      subject,
    });

    return res.status(200).json({
      success: true,
      threadId: String(thread._id),
      brandAliasEmail: thread.brandAliasEmail,
      influencerAliasEmail: thread.influencerAliasEmail,
      brandDisplayAlias: thread.brandDisplayAlias,
      influencerDisplayAlias: thread.influencerDisplayAlias,
      subject: thread.subject || "",
      campaign: serializeCampaign(thread.campaign, thread.campaignSnapshot),
    });
  } catch (err) {
    console.error("createThread error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
}

// POST /api/email/brand-to-influencer
async function sendBrandToInfluencer(req, res) {
  try {
    const { brandId, influencerId, campaignId, subject, body, htmlBody, attachments } =
      req.body;

    if (!brandId || !influencerId || !subject || !body) {
      return res.status(400).json({
        error: "brandId, influencerId, subject and body are required.",
      });
    }

    const brand = await findBrandById(brandId);
    const influencer = await findInfluencerById(influencerId);
    const campaign = campaignId
      ? await findCampaignByIdOrCampaignsId(campaignId)
      : null;

    if (!brand) return res.status(404).json({ error: "Brand not found" });
    if (!influencer) {
      return res.status(404).json({ error: "Influencer not found" });
    }
    if (campaignId && !campaign) {
      return res.status(404).json({ error: "Campaign not found" });
    }

    const thread = await getOrCreateThread({
      brand,
      influencer,
      campaign,
      createdBy: "brand",
      subject,
    });

    await enforceBrandPolicyOrThrow(thread._id);

    const result = await createAndSendMessage({
      req,
      thread,
      brand,
      influencer,
      campaign,
      direction: "brand_to_influencer",
      subject,
      body,
      htmlBodyOverride: htmlBody,
      attachments,
      context: "brand-to-influencer",
    });

    return res.status(200).json({
      success: true,
      threadId: String(result.thread._id),
      messageId: String(result.message._id),
      forwardedSesMessageId: result.sesMessageId,
      campaignId: result.thread.campaign
        ? String(result.thread.campaign)
        : null,
      usedAttachmentLinksOnly: !!result.usedAttachmentLinksOnly,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SEND_BRAND_TO_INFLUENCER_ERROR");
    console.error("sendBrandToInfluencer error:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Internal server error",
      code: err.code,
      meta: err.meta,
    });
  }
}

// POST /api/email/influencer-to-brand
async function sendInfluencerToBrand(req, res) {
  try {
    const {
      threadId,
      brandId,
      influencerId,
      campaignId,
      subject,
      body,
      htmlBody,
      attachments,
    } = req.body;

    if (!subject || !body) {
      return res.status(400).json({
        error: "subject and body are required.",
      });
    }

    let brand = null;
    let influencer = null;
    let campaign = null;
    let thread = null;

    if (threadId) {
      if (!mongoose.Types.ObjectId.isValid(String(threadId))) {
        return res.status(400).json({ error: "Invalid threadId" });
      }

      thread = await EmailThread.findById(threadId)
        .populate("brand", "_id name brandName email proxyEmail profilePic logoUrl profileImage image photo")
        .populate("influencer", "_id name email proxyEmail influencerId profileImage profilePic profilePicture avatar avatarUrl image photo page1")
        .populate(
          "campaign",
          "_id campaignTitle campaignType productOrServiceName brandName"
        );

      if (!thread) {
        return res.status(404).json({ error: "Thread not found" });
      }

      brand = thread.brand?._id
        ? thread.brand
        : await findBrandById(thread.brand);

      influencer = thread.influencer?._id
        ? thread.influencer
        : await findInfluencerById(thread.influencer);

      campaign = thread.campaign?._id
        ? thread.campaign
        : thread.campaign || null;

      if (!brand) {
        return res
          .status(404)
          .json({ error: "Brand not found for this thread" });
      }

      if (!influencer) {
        return res
          .status(404)
          .json({ error: "Influencer not found for this thread" });
      }

      const authInfluencerId =
        req.influencer?._id || req.influencer?.influencerId;

      if (
        authInfluencerId &&
        String(influencer._id) !== String(authInfluencerId)
      ) {
        return res.status(403).json({ error: "Forbidden" });
      }

      await syncThreadWithLiveParticipants(
        thread,
        brand,
        influencer,
        campaign,
        subject
      );
      await thread.save();
    } else {
      if (!brandId || !influencerId) {
        return res.status(400).json({
          error: "Either threadId OR brandId + influencerId are required.",
        });
      }

      brand = await findBrandById(brandId);
      influencer = await findInfluencerById(influencerId);
      campaign = campaignId
        ? await findCampaignByIdOrCampaignsId(campaignId)
        : null;

      if (!brand) return res.status(404).json({ error: "Brand not found" });
      if (!influencer) {
        return res.status(404).json({ error: "Influencer not found" });
      }
      if (campaignId && !campaign) {
        return res.status(404).json({ error: "Campaign not found" });
      }

      thread = await getOrCreateThread({
        brand,
        influencer,
        campaign,
        createdBy: "influencer",
        subject,
      });
    }

    const result = await createAndSendMessage({
      req,
      thread,
      brand,
      influencer,
      campaign,
      direction: "influencer_to_brand",
      subject,
      body,
      htmlBodyOverride: htmlBody,
      attachments,
      context: "influencer-to-brand",
    });

    return res.status(200).json({
      success: true,
      threadId: String(result.thread._id),
      messageId: String(result.message._id),
      forwardedSesMessageId: result.sesMessageId,
      campaignId: result.thread.campaign
        ? String(result.thread.campaign)
        : null,
      usedAttachmentLinksOnly: !!result.usedAttachmentLinksOnly,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SEND_INFLUENCER_TO_BRAND_ERROR");
    console.error("sendInfluencerToBrand error:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Internal server error",
      code: err.code,
      meta: err.meta,
    });
  }
}

// GET /api/email/participants?threadId=... OR ?brandId=...&influencerId=...
async function getEmailParticipants(req, res) {
  try {
    const { threadId, brandId, influencerId } = req.query || {};

    let thread = null;
    let brand = null;
    let influencer = null;

    if (threadId) {
      if (!mongoose.Types.ObjectId.isValid(String(threadId))) {
        return res.status(400).json({ error: "Invalid threadId" });
      }

      thread = await EmailThread.findById(threadId)
        .populate(
          "brand",
          "_id name brandName brandId email proxyEmail profilePic logoUrl profileImage image photo"
        )
        .populate(
          "influencer",
          "_id name influencerId email proxyEmail profileImage profilePic profilePicture avatar avatarUrl image photo page1 page2 page3"
        )
        .lean();

      if (!thread) return res.status(404).json({ error: "Thread not found" });

      brand = thread.brand?._id ? thread.brand : null;
      influencer = thread.influencer?._id ? thread.influencer : null;
    }

    if (!brand && brandId) {
      brand = await findBrandById(brandId);
    }

    if (!influencer && influencerId) {
      influencer = await findInfluencerById(influencerId);
    }

    if (!brand && !influencer) {
      return res.status(400).json({
        error: "Pass threadId or at least one of brandId / influencerId.",
      });
    }

    return res.status(200).json({
      brand: brand ? publicBrand(brand, thread || {}) : null,
      influencer: influencer ? publicInfluencer(influencer, thread || {}) : null,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_EMAIL_PARTICIPANTS_ERROR");
    console.error("getEmailParticipants error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/brand/contacts?brandId=...
async function getBrandContacts(req, res) {
  try {
    const { brandId } = req.query;
    if (!brandId) {
      return res
        .status(400)
        .json({ error: "brandId query param is required." });
    }

    const brand = await findBrandById(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const map = new Map();

    const upsert = (key, patch) => {
      const prev =
        map.get(key) || {
          id: key,
          _id: null,
          brandId: null,
          influencerId: null,
          invitationId: null,
          name: "Influencer",
          displayAlias: "",
          threadId: null,
          lastMessageAt: null,
          lastMessageSnippet: "",
          flags: { invited: false, applied: false, conversation: false },
          invitation: null,
          appliedCampaigns: [],
          campaign: null,
        };

      map.set(key, {
        ...prev,
        ...patch,
        flags: { ...prev.flags, ...(patch.flags || {}) },
        appliedCampaigns: patch.appliedCampaigns || prev.appliedCampaigns,
      });
    };

    const threads = await EmailThread.find(threadMatchForBrand(brand))
      .populate("influencer", "_id name proxyEmail email influencerId profileImage profilePic profilePicture avatar avatarUrl image photo page1")
      .populate(
        "campaign",
        "_id campaignTitle campaignType productOrServiceName brandName"
      )
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(500)
      .lean();

    for (const t of threads) {
      const inf = t.influencer || null;
      const influencerMongoId = inf?._id ? String(inf._id) : null;
      const key = `thread:${String(t._id)}`;

      upsert(key, {
        _id: influencerMongoId,
        influencerId: influencerMongoId,
        name: inf?.name || t?.influencerSnapshot?.name || "Influencer",
        displayAlias:
          t.influencerDisplayAlias ||
          inf?.proxyEmail ||
          computeInfluencerDisplayAlias(inf || t?.influencerSnapshot),
        email: inf?.email || "",
        proxyEmail:
          t.influencerDisplayAlias ||
          inf?.proxyEmail ||
          computeInfluencerDisplayAlias(inf || t?.influencerSnapshot),
        profileImage: getInfluencerImage(inf || {}),
        profilePic: getInfluencerImage(inf || {}),
        avatarUrl: getInfluencerImage(inf || {}),
        threadId: String(t._id),
        lastMessageAt: t.lastMessageAt || null,
        lastMessageSnippet: t.lastMessageSnippet || "",
        flags: { conversation: true },
        campaign: serializeCampaign(t.campaign, t.campaignSnapshot),
      });
    }

    const campaigns = await Campaign.find(
      andQuery({ isDraft: 0 }, buildBrandOwnershipMatch(brand))
    )
      .select({
        _id: 1,
        campaignsId: 1,
        campaignTitle: 1,
        productOrServiceName: 1,
        campaignType: 1,
        brandName: 1,
      })
      .lean();

    const campaignTitleById = new Map(
      campaigns.map((c) => [String(c.campaignsId || c._id), getCampaignTitle(c)])
    );

    const campaignIds = campaigns
      .map((c) => c.campaignsId || c._id)
      .filter(Boolean);

    if (campaignIds.length) {
      const appDocs = await CampaignApplication.find({
        campaignId: { $in: campaignIds },
      }).lean();

      const appliedByInfluencer = new Map();

      const add = (iid, campaignId, bucket) => {
        if (!iid) return;
        const k = String(iid);
        const arr = appliedByInfluencer.get(k) || [];
        arr.push({
          campaignId: String(campaignId),
          title: campaignTitleById.get(String(campaignId)) || "Campaign",
          bucket,
        });
        appliedByInfluencer.set(k, arr);
      };

      for (const doc of appDocs) {
        const cid = doc.campaignId;
        (doc.applicants || []).forEach((a) =>
          add(a.influencer || a.influencerId, cid, "applicants")
        );
        (doc.approved || []).forEach((a) =>
          add(a.influencer || a.influencerId, cid, "approved")
        );
      }

      const influencerIds = [...appliedByInfluencer.keys()].filter(isObjectId);

      if (influencerIds.length) {
        const influencers = await Influencer.find({
          _id: { $in: influencerIds },
        })
          .select({ _id: 1, name: 1, proxyEmail: 1, email: 1, profileImage: 1, profilePic: 1, profilePicture: 1, avatar: 1, avatarUrl: 1, image: 1, photo: 1, page1: 1 })
          .lean();

        const infById = new Map(influencers.map((i) => [String(i._id), i]));

        for (const iid of influencerIds) {
          const inf = infById.get(String(iid));
          const key = `inf:${String(iid)}`;

          upsert(key, {
            _id: String(iid),
            influencerId: String(iid),
            name: inf?.name || "Influencer",
            displayAlias:
              inf?.proxyEmail ||
              computeInfluencerDisplayAlias(inf || { name: "Influencer" }),
            email: inf?.email || "",
            proxyEmail:
              inf?.proxyEmail ||
              computeInfluencerDisplayAlias(inf || { name: "Influencer" }),
            profileImage: getInfluencerImage(inf || {}),
            profilePic: getInfluencerImage(inf || {}),
            avatarUrl: getInfluencerImage(inf || {}),
            appliedCampaigns: appliedByInfluencer.get(String(iid)) || [],
            flags: { applied: true },
          });
        }
      }
    }

    const invitations = await Invitation.find(buildBrandOwnershipMatch(brand))
      .select({
        invitationId: 1,
        handle: 1,
        platform: 1,
        status: 1,
        campaignId: 1,
      })
      .lean();

    for (const inv of invitations) {
      const key = `inv:${String(inv.invitationId)}`;
      upsert(key, {
        invitationId: String(inv.invitationId),
        name: inv.handle
          ? safeStr(inv.handle).replace(/^@/, "")
          : "Influencer",
        invitation: {
          invitationId: String(inv.invitationId),
          handle: inv.handle || null,
          platform: inv.platform || null,
          status: inv.status || null,
          campaignId: inv.campaignId || null,
        },
        flags: { invited: true },
      });
    }

    const list = [...map.values()].sort((a, b) => {
      const score = (x) =>
        (x.flags.conversation ? 3 : 0) +
        (x.flags.applied ? 2 : 0) +
        (x.flags.invited ? 1 : 0);

      const s = score(b) - score(a);
      if (s !== 0) return s;

      const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bt - at;
    });

    return res.status(200).json({
      brand: publicBrand(brand),
      influencers: list,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BRAND_CONTACTS_ERROR");
    console.error("getBrandContacts error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/email/brand/inbox
async function getBrandInbox(req, res) {
  try {
    const brandId = req.body?.brandId || req.query?.brandId;
    const limit = Math.max(
      1,
      Math.min(Number(req.body?.limit || req.query?.limit || 20), 200)
    );

    if (!brandId) {
      return res.status(400).json({ error: "brandId is required." });
    }

    const brand = await findBrandById(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const threads = await EmailThread.find(threadMatchForBrand(brand))
      .populate("influencer", "_id name proxyEmail email influencerId profileImage profilePic profilePicture avatar avatarUrl image photo page1")
      .populate(
        "campaign",
        "_id campaignTitle campaignType productOrServiceName brandName"
      )
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    const threadIds = threads.map((t) => t._id);

    const messages = await EmailMessage.find({ thread: { $in: threadIds } })
      .select({
        thread: 1,
        direction: 1,
        createdAt: 1,
        sentAt: 1,
        receivedAt: 1,
        subject: 1,
        textBody: 1,
        htmlBody: 1,
        attachments: 1,
      })
      .sort({ createdAt: 1 })
      .lean();

    const msgsByThread = new Map();

    for (const m of messages) {
      const k = String(m.thread);
      const arr = msgsByThread.get(k) || [];
      arr.push({
        id: String(m._id),
        direction: m.direction,
        createdAt: m.createdAt,
        sentAt: m.sentAt,
        receivedAt: m.receivedAt,
        subject: m.subject || "",
        textBody: m.textBody || "",
        htmlBody: m.htmlBody || "",
        attachments: m.attachments || [],
      });
      msgsByThread.set(k, arr);
    }

    const conversations = threads.map((t) => {
      const inf = t.influencer || null;
      const influencerName =
        inf?.name || t.influencerSnapshot?.name || "Influencer";

      return {
        threadId: String(t._id),
        campaign: serializeCampaign(t.campaign, t.campaignSnapshot),
        influencer: {
          ...publicInfluencer(inf || t.influencerSnapshot || {}, t),
          _id: inf?._id ? String(inf._id) : null,
          influencerId: inf?._id ? String(inf._id) : null,
          name: influencerName,
        },
        subject: t.subject || "",
        snippet: t.lastMessageSnippet || "",
        lastMessageAt: t.lastMessageAt || null,
        lastMessageDirection: t.lastMessageDirection || null,
        ...getReadState(t, "brand"),
        status: t.status || "active",
        messages: msgsByThread.get(String(t._id)) || [],
      };
    });

    return res.status(200).json({
      brand: publicBrand(brand),
      conversations,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_BRAND_INBOX_ERROR");
    console.error("getBrandInbox error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/threads/brand/:brandId
async function getThreadsForBrand(req, res) {
  try {
    const brand = await findBrandById(req.params.brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const threads = await EmailThread.find(threadMatchForBrand(brand))
      .populate("influencer", "_id name proxyEmail email influencerId profileImage profilePic profilePicture avatar avatarUrl image photo page1")
      .populate(
        "campaign",
        "_id campaignTitle campaignType productOrServiceName brandName"
      )
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      brand: publicBrand(brand),
      threads: threads.map((t) => ({
        threadId: String(t._id),
        subject: t.subject || "",
        lastMessageAt: t.lastMessageAt || null,
        lastMessageDirection: t.lastMessageDirection || null,
        lastMessageSnippet: t.lastMessageSnippet || "",
        ...getReadState(t, "brand"),
        campaign: serializeCampaign(t.campaign, t.campaignSnapshot),
        influencer: {
          ...publicInfluencer(t.influencer || t.influencerSnapshot || {}, t),
          _id: t.influencer?._id ? String(t.influencer._id) : null,
          influencerId: t.influencer?._id ? String(t.influencer._id) : null,
          name: t.influencer?.name || t.influencerSnapshot?.name || "Influencer",
        },
      })),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_THREADS_FOR_BRAND_ERROR");
    console.error("getThreadsForBrand error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/threads/influencer/:influencerId
async function getThreadsForInfluencer(req, res) {
  try {
    const influencer = await findInfluencerById(req.params.influencerId);
    if (!influencer) {
      return res.status(404).json({ error: "Influencer not found" });
    }

    const threads = await EmailThread.find({ influencer: influencer._id })
      .populate("brand", "_id name brandName brandId email proxyEmail profilePic logoUrl profileImage image photo")
      .populate(
        "campaign",
        "_id campaignTitle campaignType productOrServiceName brandName"
      )
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      influencer: publicInfluencer(influencer),
      threads: threads.map((t) => ({
        threadId: String(t._id),
        subject: t.subject || "",
        lastMessageAt: t.lastMessageAt || null,
        lastMessageDirection: t.lastMessageDirection || null,
        lastMessageSnippet: t.lastMessageSnippet || "",
        ...getReadState(t, "influencer"),
        campaign: serializeCampaign(t.campaign, t.campaignSnapshot),
        brand: {
          ...publicBrand(t.brand || t.brandSnapshot || {}, t),
          _id: t.brand?._id ? String(t.brand._id) : null,
          brandId: t.brand?._id ? String(t.brand._id) : null,
          name: t.brand?.brandName || t.brand?.name || t.brandSnapshot?.name || "Brand",
        },
      })),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_THREADS_FOR_INFLUENCER_ERROR");
    console.error("getThreadsForInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/messages/:threadId
async function getMessagesForThread(req, res) {
  try {
    const { threadId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(String(threadId))) {
      return res.status(400).json({ error: "Invalid threadId" });
    }

    const thread = await EmailThread.findById(threadId)
      .populate("brand", "_id name brandName brandId email proxyEmail profilePic logoUrl profileImage image photo")
      .populate("influencer", "_id name influencerId proxyEmail email profileImage profilePic profilePicture avatar avatarUrl image photo page1")
      .populate(
        "campaign",
        "_id campaignTitle campaignType productOrServiceName brandName"
      )
      .lean();

    if (!thread) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const messages = await EmailMessage.find({ thread: thread._id })
      .select({
        direction: 1,
        createdAt: 1,
        sentAt: 1,
        receivedAt: 1,
        subject: 1,
        textBody: 1,
        htmlBody: 1,
        attachments: 1,
        fromProxyEmail: 1,
        toProxyEmail: 1,
        fromAliasEmail: 1,
      })
      .sort({ createdAt: 1 })
      .lean();

    return res.status(200).json({
      thread: {
        id: String(thread._id),
        subject: thread.subject || "",
        lastMessageAt: thread.lastMessageAt || null,
        lastMessageDirection: thread.lastMessageDirection || null,
        brandReadState: getReadState(thread, "brand"),
        influencerReadState: getReadState(thread, "influencer"),
        campaign: serializeCampaign(thread.campaign, thread.campaignSnapshot),
        brand: publicBrand(thread.brand || {}, thread),
        influencer: publicInfluencer(thread.influencer || {}, thread),
      },
      messages: messages.map((m) => ({
        id: String(m._id),
        direction: m.direction,
        createdAt: m.createdAt,
        sentAt: m.sentAt,
        receivedAt: m.receivedAt,
        subject: m.subject || "",
        textBody: m.textBody || "",
        htmlBody: m.htmlBody || "",
        fromAliasEmail: m.fromAliasEmail,
        fromProxyEmail: m.fromProxyEmail,
        toProxyEmail: m.toProxyEmail,
        attachments: m.attachments || [],
      })),
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_MESSAGES_FOR_THREAD_ERROR");
    console.error("getMessagesForThread error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// POST /api/email/campaign-invitation
async function sendCampaignInvitation(req, res) {
  try {
    const result = await sendCampaignInvitationInternal({
      ...req.body,
      _request: req,
    });

    return res.status(200).json(result);
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "SEND_CAMPAIGN_INVITATION_ERROR");
    console.error("sendCampaignInvitation error:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Internal server error",
      code: err.code || undefined,
      meta: err.meta || undefined,
    });
  }
}

// POST /api/email/campaign-invitation/preview
async function getCampaignInvitationPreview(req, res) {
  try {
    const {
      brandId,
      campaignId,
      influencerId,
      invitationId,
      campaignLink,
      compensation,
      deliverables,
      additionalNotes,
    } = req.body;

    if (!brandId || !campaignId) {
      return res
        .status(400)
        .json({ error: "brandId and campaignId are required." });
    }

    if (!influencerId && !invitationId) {
      return res.status(400).json({
        error: "Either influencerId or invitationId is required.",
      });
    }

    const brand = await findBrandById(brandId);
    if (!brand) return res.status(404).json({ error: "Brand not found" });

    const campaign = await findCampaignByIdOrCampaignsId(campaignId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const { influencer, influencerName, recipientEmail } =
      await resolveInfluencerAndEmail({
        influencerId,
        invitationId,
        brand,
      });

    const brandName = getBrandLabel(brand);
    const campaignTitle = getCampaignTitle(campaign);
    const campaignObjective = campaign.goal || campaign.description || "";

    const defaultDeliverables =
      Array.isArray(campaign.creativeBrief) && campaign.creativeBrief.length
        ? campaign.creativeBrief.join(", ")
        : campaign.creativeBriefText ||
          "Content deliverables to be discussed with you.";

    const finalDeliverables = deliverables || defaultDeliverables;

    const finalCompensation =
      compensation ||
      "Compensation will be discussed based on your standard rates and the campaign scope.";

    let timelineText = "Flexible / To be discussed";
    if (campaign.timeline?.startDate && campaign.timeline?.endDate) {
      const start = new Date(campaign.timeline.startDate);
      const end = new Date(campaign.timeline.endDate);
      const fmt = (d) =>
        d.toLocaleDateString("en-US", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        });
      timelineText = `${fmt(start)} – ${fmt(end)}`;
    }

    const notes =
      additionalNotes || campaign.additionalNotes || campaign.description || "";

    const baseUrl = safeStr(process.env.CAMPAIGN_BASE_URL || "");
    const campaignPublicId = campaign.campaignsId || campaign._id;
    const link =
      campaignLink ||
      (baseUrl
        ? `${baseUrl.replace(
            /\/$/,
            ""
          )}/influencer/new-collab/view-campaign?id=${campaignPublicId}`
        : "#");

    const templateResult = buildInvitationEmail({
      brandName,
      influencerName,
      campaignTitle,
      campaignObjective,
      deliverables: finalDeliverables,
      compensation: finalCompensation,
      timeline: timelineText,
      additionalNotes: notes,
      campaignLink: link,
    });

    return res.status(200).json({
      success: true,
      subject: templateResult.subject,
      htmlBody: templateResult.htmlBody,
      textBody: templateResult.textBody,
      meta: {
        brandName,
        influencerName,
        campaignTitle,
        campaignObjective,
        deliverables: finalDeliverables,
        compensation: finalCompensation,
        timeline: timelineText,
        additionalNotes: notes,
        campaignLink: link,
        recipientEmail,
        influencerId: influencer?._id ? String(influencer._id) : null,
      },
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_CAMPAIGN_INVITATION_PREVIEW_ERROR");
    console.error("getCampaignInvitationPreview error:", err);
    return res.status(err.statusCode || 500).json({
      error: err.message || "Internal server error",
    });
  }
}

// POST /api/email/invitation
async function handleEmailInvitation(req, res) {
  try {
    const rawEmail = safeLower(req.body?.email || "");
    const rawBrandId = safeStr(req.body?.brandId || "").trim();
    const rawCampaignId = safeStr(req.body?.campaignId || "").trim();
    const rawHandle = safeStr(req.body?.handle || "").trim();
    const rawPlatform = safeStr(req.body?.platform || "").trim();

    const {
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody,
      attachments,
    } = req.body;

    if (!rawEmail) {
      return res
        .status(400)
        .json({ status: "error", message: "email is required" });
    }

    if (!rawBrandId) {
      return res
        .status(400)
        .json({ status: "error", message: "brandId is required" });
    }

    const brand = await findBrandById(rawBrandId);
    if (!brand) {
      return res.status(404).json({
        status: "error",
        message: "Brand not found for given brandId",
      });
    }

    const influencer = await Influencer.findOne({ email: rawEmail }).lean();

    if (influencer?._id) {
      const sendResult = await sendCampaignInvitationInternal({
        brandId: String(brand._id),
        campaignId: rawCampaignId || undefined,
        influencerId: String(influencer._id),
        compensation,
        deliverables,
        additionalNotes,
        subject: customSubject,
        body: customBody,
        attachments,
        _request: req,
      });

      return res.json({
        status: "success",
        message: "Existing influencer found, invitation email sent.",
        isExistingInfluencer: true,
        influencerId: String(influencer._id),
        influencerName: getInfluencerLabel(influencer),
        brandName: getBrandLabel(brand),
        emailSent: true,
        emailMeta: {
          recipientEmail: sendResult.recipientEmail,
          threadId: String(sendResult.threadId),
          messageId: String(sendResult.messageId),
          subject: sendResult.subject,
          campaignId: sendResult.campaignId,
          usedAttachmentLinksOnly: !!sendResult.usedAttachmentLinksOnly,
        },
      });
    }

    if (!rawHandle || !rawPlatform) {
      return res.status(400).json({
        status: "error",
        message:
          "handle and platform are required when influencer is not signed up",
      });
    }

    const handle = normalizeHandle(rawHandle);
    if (!HANDLE_RX.test(handle)) {
      return res.status(400).json({
        status: "error",
        message:
          'Invalid handle. It must start with "@" and contain letters, numbers, ".", "_" or "-"',
      });
    }

    const platform = PLATFORM_MAP.get(rawPlatform.toLowerCase());
    if (!platform) {
      return res.status(400).json({
        status: "error",
        message:
          "Invalid platform. Use: youtube|instagram|tiktok (aliases: yt, ig, tt)",
      });
    }

    let missing = await MissingEmail.findOne({ email: rawEmail });
    if (!missing) missing = await MissingEmail.findOne({ handle });

    if (!missing) {
      missing = await MissingEmail.create({
        email: rawEmail,
        handle,
        platform,
        brand: brand._id,
      });
    } else {
      let changed = false;

      if (rawEmail && rawEmail !== missing.email) {
        missing.email = rawEmail;
        changed = true;
      }

      if (handle && handle !== missing.handle) {
        missing.handle = handle;
        changed = true;
      }

      if (platform && platform !== missing.platform) {
        missing.platform = platform;
        changed = true;
      }

      if (!missing.brand && brand._id) {
        missing.brand = brand._id;
        changed = true;
      }

      if (changed) await missing.save();
    }

    let invitation = await Invitation.findOne(
      andQuery(buildBrandOwnershipMatch(brand), { handle, platform })
    );

    let isNewInvitation = false;

    if (!invitation) {
      invitation = await Invitation.create({
        brand: brand._id,
        handle,
        platform,
        campaignId: rawCampaignId || null,
        status: "available",
        missingEmailId: missing.missingEmailId,
      });
      isNewInvitation = true;
    } else {
      let saveNeeded = false;

      if (!invitation.brand && brand._id) {
        invitation.brand = brand._id;
        saveNeeded = true;
      }

      if (rawCampaignId && invitation.campaignId !== rawCampaignId) {
        invitation.campaignId = rawCampaignId;
        saveNeeded = true;
      }

      if (
        missing.missingEmailId &&
        invitation.missingEmailId !== missing.missingEmailId
      ) {
        invitation.missingEmailId = missing.missingEmailId;
        saveNeeded = true;
      }

      if (saveNeeded) await invitation.save();
    }

    const sendResult = await sendCampaignInvitationInternal({
      brandId: String(brand._id),
      campaignId: rawCampaignId || undefined,
      invitationId: invitation.invitationId,
      compensation,
      deliverables,
      additionalNotes,
      subject: customSubject,
      body: customBody,
      attachments,
      _request: req,
    });

    return res.json({
      status: "success",
      message: "Email invitation created and sent to this creator.",
      isExistingInfluencer: false,
      brandName: getBrandLabel(brand),
      invitationId: invitation.invitationId,
      emailSent: true,
      emailMeta: {
        recipientEmail: sendResult.recipientEmail,
        threadId: String(sendResult.threadId),
        messageId: String(sendResult.messageId),
        subject: sendResult.subject,
        campaignId: sendResult.campaignId,
        usedAttachmentLinksOnly: !!sendResult.usedAttachmentLinksOnly,
      },
      isNewInvitation,
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "HANDLE_EMAIL_INVITATION_ERROR");
    console.error("Error in handleEmailInvitation:", err);
    return res.status(err.statusCode || 500).json({
      status: "error",
      message: err.message || "Internal server error",
      code: err.code,
      meta: err.meta,
    });
  }
}

// GET /api/email/conversations
async function getConversationsForCurrentInfluencer(req, res) {
  try {
    const auth = req.influencer;
    const authInfluencerId = auth?._id || auth?.influencerId;

    if (!auth || !authInfluencerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const influencer = await findInfluencerById(authInfluencerId);
    if (!influencer) {
      return res.status(404).json({ error: "Influencer not found" });
    }

    const threads = await EmailThread.find({ influencer: influencer._id })
      .populate("brand", "_id name brandName brandId email proxyEmail profilePic logoUrl profileImage image photo")
      .populate(
        "campaign",
        "_id campaignTitle campaignType productOrServiceName brandName"
      )
      .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
      .lean();

    const conversations = threads.map((t) => ({
      id: String(t._id),
      campaign: serializeCampaign(t.campaign, t.campaignSnapshot),
      brand: {
        _id: t.brand?._id ? String(t.brand._id) : null,
        brandId: t.brand?._id ? String(t.brand._id) : null,
        name:
          t.brand?.brandName || t.brand?.name || t.brandSnapshot?.name || "Brand",
        aliasEmail:
          t.brandDisplayAlias || t.brand?.proxyEmail || t.brandAliasEmail,
        logoUrl: t.brand?.logoUrl || null,
      },
      subject: t.subject || t.lastMessageSnippet || "",
      lastMessageAt: t.lastMessageAt,
      lastMessageDirection: t.lastMessageDirection,
      lastMessageSnippet: t.lastMessageSnippet || "",
      ...getReadState(t, "influencer"),
      influencerAliasEmail: t.influencerDisplayAlias || t.influencerAliasEmail,
    }));

    return res.status(200).json({ conversations });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_CONVERSATIONS_FOR_CURRENT_INFLUENCER_ERROR");
    console.error("getConversationsForCurrentInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// GET /api/email/conversations/:id
async function getConversationForCurrentInfluencer(req, res) {
  try {
    const auth = req.influencer;
    const authInfluencerId = auth?._id || auth?.influencerId;
    const { id: threadId } = req.params;

    if (!auth || !authInfluencerId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const influencer = await findInfluencerById(authInfluencerId);
    if (!influencer) {
      return res.status(404).json({ error: "Influencer not found" });
    }

    const thread = await EmailThread.findById(threadId)
      .populate("brand", "_id name brandName brandId email proxyEmail profilePic logoUrl profileImage image photo")
      .populate("influencer", "_id name influencerId proxyEmail email profileImage profilePic profilePicture avatar avatarUrl image photo page1")
      .populate(
        "campaign",
        "_id campaignTitle campaignType productOrServiceName brandName"
      )
      .lean();

    if (!thread) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const threadInfluencerId = String(thread.influencer?._id || thread.influencer);
    if (threadInfluencerId !== String(influencer._id)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const messages = await EmailMessage.find({ thread: thread._id })
      .sort({ createdAt: 1 })
      .lean();

    const mappedMessages = messages.map((m) => ({
      id: String(m._id),
      direction: m.direction,
      createdAt: m.createdAt,
      sentAt: m.sentAt,
      receivedAt: m.receivedAt,
      subject: m.subject,
      htmlBody: m.htmlBody,
      textBody: m.textBody,
      fromAliasEmail: m.fromAliasEmail,
      fromProxyEmail: m.fromProxyEmail,
      toProxyEmail: m.toProxyEmail,
      attachments: m.attachments || [],
    }));

    return res.status(200).json({
      conversation: {
        id: String(thread._id),
        subject: thread.subject,
        campaign: serializeCampaign(thread.campaign, thread.campaignSnapshot),
        brand: publicBrand(thread.brand || {}, thread),
        influencer: publicInfluencer(thread.influencer || influencer || {}, thread),
        lastMessageAt: thread.lastMessageAt,
        lastMessageDirection: thread.lastMessageDirection,
        ...getReadState(thread, "influencer"),
        messages: mappedMessages,
      },
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_CONVERSATION_FOR_CURRENT_INFLUENCER_ERROR");
    console.error("getConversationForCurrentInfluencer error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// Backwards compatibility
async function getInfluencerEmailListForBrand(req, res) {
  try {
    if (req.method === "POST") return await getBrandInbox(req, res);
    return await getBrandContacts(req, res);
  } catch (err) {
    await saveErrorLog(req, err, err?.statusCode || err?.status || 500, "GET_INFLUENCER_EMAIL_LIST_FOR_BRAND_ERROR");
    console.error("getInfluencerEmailListForBrand error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ===============================
// Exports
// ===============================
module.exports = {
  getTemplateByKey,

  createThread,
  markThreadAsRead,
  sendBrandToInfluencer,
  sendInfluencerToBrand,

  getBrandContacts,
  getEmailParticipants,
  getBrandInbox,

  getThreadsForBrand,
  getThreadsForInfluencer,
  getMessagesForThread,

  sendCampaignInvitation,
  getCampaignInvitationPreview,
  handleEmailInvitation,

  getConversationsForCurrentInfluencer,
  getConversationForCurrentInfluencer,

  getInfluencerEmailListForBrand,

  _sendCampaignInvitationInternal: sendCampaignInvitationInternal,
};