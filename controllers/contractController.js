"use strict";

const PDFDocument = require("pdfkit");
const moment = require("moment-timezone");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const Modash = require("../models/modash");
const { InfluencerModel: Influencer } = require("../models/influencer");
const ApplyCampaign = require("../models/applyCampaign");
const Contract = require("../models/contract");
const ContractContent = require("../models/contractContent");
const ContractSignature = require("../models/contractSignature");
const ContractActivity = require("../models/contractActivity");
const ContractDocument = require("../models/contractDocument");
const BrandSignature = require("../models/brandSignature");
const InfluencerSignature = require("../models/influencerSignature");

const {
  CONTRACT_BUCKET,
  CONTRACT_FOLDER,
  createContractUploadUrl,
  getContractObjectStream,
  getExpectedContractKeyPrefix,
  deleteContractFile,
  assertPdfUpload,
} = require("../services/s3Contract.service");

const UPLOADED_CONTRACT_ACKNOWLEDGEMENT = require("../template/UploadedContractAcknowledgement");

const MASTER_TEMPLATE = require("../template/ContractTemplate");
const { createAndEmit } = require("../utils/notifier");
const saveErrorLog = require("../services/errorLog.service");
const {
  hydrateContract,
  hydrateContracts,
  createOrUpdateContent,
  createOrUpdateDocument,
} = require("../services/contractAssembler.service");
const { addActivity } = require("../services/contractActivity.service");
const {
  CONTRACT_STATUS,
  PAYMENT_TYPE,
  normalizeContractStatus,
  normalizePaymentType,
} = require("../constants/contract");

let EmailSvc = {};
try {
  EmailSvc = require("../services/email/contractEmailService");
} catch (_e) {
  console.warn("[Email] contractEmailService not found. Emails/reminders will be skipped.");
}

const {
  sendContractEmail,
  startReminder,
  clearReminder,
  resetReminderOnEngagement,
} = EmailSvc;

const DEFAULT_TZ = "America/Los_Angeles";
const TIMEZONES_FILE = path.join(__dirname, "..", "data", "timezones.json");
const CURRENCIES_FILE = path.join(__dirname, "..", "data", "currencies.json");
const CONTRACT_PDF_TITLE = "COLLABGLAM BRAND–INFLUENCER CAMPAIGN COLLABORATION AGREEMENT";
const MAX_SIG_BYTES = Number(process.env.CONTRACT_SIGNATURE_MAX_BYTES || 500 * 1024);
const COLLABGLAM_SIG_FILE = path.join(__dirname, "..", "assets", "collabglam-signature.png");

let COLLABGLAM_FIXED_SIG_DATA_URL = process.env.COLLABGLAM_FIXED_SIG_DATA_URL || null;
let _tzCache = null;
let _curCache = null;
let sharedBrowserPromise = null;

(function loadCollabGlamSig() {
  if (COLLABGLAM_FIXED_SIG_DATA_URL) return;
  try {
    if (fs.existsSync(COLLABGLAM_SIG_FILE)) {
      const buf = fs.readFileSync(COLLABGLAM_SIG_FILE);
      COLLABGLAM_FIXED_SIG_DATA_URL = `data:image/png;base64,${buf.toString("base64")}`;
    }
  } catch (e) {
    console.warn("[Contract] Failed to load CollabGlam signature:", e?.message || e);
  }
})();

const ALLOWED_BRAND_PATHS = Object.freeze([
  "content.brand.legalName",
  "content.brand.contactPersonName",
  "content.brand.noticeEmail",
  "content.brand.noticePhone",
  "content.brand.billingAddress",
  "content.brand.brandPoc",
  "content.brand.brandPocDesignation",
  "content.campaign.productsServicesCovered",
  "content.campaign.territoryTargetCountry",
  "content.campaign.territoryTargetCountryIds",
  "content.campaign.effectiveDate",
  "content.campaign.campaignTitleOrId",
  "content.campaign.campaignId",
  "content.campaign.name",
  "content.campaign.timezone",
  "content.campaign.paymentType",
  "content.scheduleA.deliverables",
  "content.scheduleA.minimumVideoSpecs",
  "content.scheduleA.preShootScriptRequired",
  "content.scheduleA.preShootScriptDue",
  "content.scheduleA.preShootScriptReviewBusinessDays",
  "content.scheduleA.mandatoryTagsMentionsLinksCodes",
  "content.scheduleA.review.needRevisionRounds",
  "content.scheduleA.review.includedRevisionRounds",
  "content.scheduleA.review.additionalRevisionFee",
  "content.scheduleA.review.reshootObligationRequired",
  "content.scheduleA.review.draftDate",
  "content.scheduleA.review.reshootObligation",
  "content.scheduleA.review.reshootFee",
  "content.scheduleA.review.minimumLivePeriod",
  "content.scheduleA.review.customLivePeriod",
  "content.scheduleA.commercial.totalCampaignFee",
  "content.scheduleA.commercial.influencerBudget",
  "content.scheduleA.commercial.currency",
  "content.scheduleA.commercial.paymentStructure",
  "content.scheduleA.commercial.platformMilestonePaymentStructure",
  "content.scheduleA.commercial.customSplit",
  "content.scheduleA.commercial.fixedCustomAdvancePercent",
  "content.scheduleA.commercial.fixedCustomDeliverablesPercent",
  "content.scheduleA.commercial.advancePaymentTrigger",
  "content.scheduleA.commercial.wantAdvancePayment",
  "content.scheduleA.commercial.advancePaymentAmount",
  "content.scheduleA.commercial.advancePaymentType",
  "content.scheduleA.commercial.remainingPaymentTrigger",
  "content.scheduleA.commercial.paymentProcessorFeesBorneBy",
  "content.scheduleA.commercial.paymentProcessorFeesNotes",
  "content.scheduleA.commercial.laneAMarketplaceFeeNote",
  "content.scheduleA.commercial.payoutMethod",
  "content.scheduleA.commercial.payoutAccountId",
  "content.scheduleA.commercial.taxId",
  "content.scheduleA.commercial.milestones",
  "content.scheduleA.rawFiles.rawSourceFileDelivery",
  "content.scheduleA.rawFiles.deliveryDue",
  "content.scheduleA.rawFiles.format",
  "content.scheduleA.rawFiles.analyticsReportingDeadline",
  "content.scheduleA.rawFiles.analyticsReportingItems",
  "content.scheduleA.rawFiles.analyticsRequired",
  "content.scheduleA.shipping.productShippingApplicable",
  "content.scheduleA.shipping.shipToName",
  "content.scheduleA.shipping.shipToAddress",
  "content.scheduleA.shipping.shipToPhone",
  "content.scheduleA.shipping.productReceiptConfirmationDeadline",
  "content.scheduleA.shipping.productReturnable",
  "content.scheduleA.shipping.returnWindowMethod",
  "content.scheduleA.shipping.productName",
  "content.scheduleA.shipping.sku",
  "content.scheduleA.shipping.quantity",
  "content.scheduleA.shipping.estimatedProductValue",
  "content.scheduleA.shipping.riskOfLossNotes",
  "content.scheduleA.shipping.returnInstructions",
  "content.scheduleA.usageRights.rows",
  "content.scheduleA.usageRights.attributionRequirement",
  "content.scheduleA.usageRights.attributionText",
  "content.scheduleA.usageRights.editingRights",
  "content.scheduleA.usageRights.musicStockAssetResponsibility",
  "content.scheduleA.usageRights.musicStockAssetLicensingNotes",
  "content.scheduleA.compliance.creativeBriefMandatoryTalkingPoints",
  "content.scheduleA.compliance.restrictedStatements",
  "content.scheduleA.exclusivity.competitorBlackout",
  "content.scheduleA.exclusivity.categoryCompetitorList",
  "content.scheduleA.exclusivity.blackoutPeriod",
  "content.scheduleA.exclusivity.optionalMoralsClause",
  "content.scheduleA.cancellation.killFeeOrProrata",
  "content.scheduleA.cancellation.killFeeAmount",
  "content.scheduleA.cancellation.proRataTerms",
  "content.scheduleA.cancellation.refundOfUnearnedAdvance",
  "content.scheduleA.cancellation.customRefundTerms",
  "content.scheduleA.cancellation.productRecoveryTerms",
  "content.scheduleA.dispute.governingLaw",
  "content.scheduleA.dispute.disputeResolutionMethod",
  "content.scheduleA.dispute.disputeVenue",
  "content.scheduleA.dispute.arbitrationSeat",
  "content.scheduleA.dispute.attorneysFees",
  "content.scheduleA.dispute.disputeResolutionDetails",
  "content.scheduleA.dispute.attorneysFeesTerms",
  "content.collabglam.signatoryName",
]);

const ALLOWED_INFLUENCER_PATHS = Object.freeze([
  "content.influencer.legalName",
  "content.influencer.contactName",
  "content.influencer.email",
  "content.influencer.phone",
  "content.influencer.contactEmail",
  "content.influencer.contactPhone",
  "content.influencer.whatsApp",
  "content.influencer.taxFormType",
  "content.influencer.taxId",
  "content.influencer.address",
  "content.influencer.addressLine1",
  "content.influencer.addressLine2",
  "content.influencer.city",
  "content.influencer.state",
  "content.influencer.zipPostalCode",
  "content.influencer.country",
  "content.influencer.notes",
  "content.campaign.territoryTargetCountry",
  "content.campaign.territoryTargetCountryIds",
  "content.campaign.effectiveDate",
  "content.campaign.timezone",
  "content.scheduleA.preShootScriptRequired",
  "content.scheduleA.preShootScriptDue",
  "content.scheduleA.preShootScriptReviewBusinessDays",
  "content.scheduleA.review.includedRevisionRounds",
  "content.scheduleA.review.additionalRevisionFee",
  "content.scheduleA.review.reshootObligationRequired",
  "content.scheduleA.review.draftDate",
  "content.scheduleA.review.reshootObligation",
  "content.scheduleA.review.reshootObligationRequired",
  "content.scheduleA.review.draftDate",
  "content.scheduleA.review.reshootFee",
  "content.scheduleA.commercial.totalCampaignFee",
  "content.scheduleA.commercial.influencerBudget",
  "content.scheduleA.commercial.currency",
  "content.scheduleA.commercial.wantAdvancePayment",
  "content.scheduleA.commercial.advancePaymentAmount",
  "content.scheduleA.commercial.advancePaymentType",
  "content.scheduleA.commercial.laneAMarketplaceFeeNote",
  "content.scheduleA.shipping.productShippingApplicable",
  "content.scheduleA.shipping.shipToName",
  "content.scheduleA.shipping.shipToAddress",
  "content.scheduleA.shipping.productReceiptConfirmationDeadline",
  "content.scheduleA.shipping.productReturnable",
]);

function respondOK(res, payload = {}, status = 200) {
  return res.status(status).json({ success: true, ...payload });
}

function respondError(res, message = "Internal server error", status = 500, err = null) {
  if (err) console.error(message, err);
  return res.status(status).json({ success: false, message });
}

function assertRequired(obj, fields) {
  const missing = (fields || []).filter((f) => obj?.[f] === undefined || obj?.[f] === null || obj?.[f] === "");
  if (missing.length) {
    const e = new Error(`Missing required field(s): ${missing.join(", ")}`);
    e.status = 400;
    throw e;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_e) {
    return fallback;
  }
}

function loadTimezones() {
  if (!_tzCache) _tzCache = safeReadJson(TIMEZONES_FILE, []);
  return _tzCache;
}

function loadCurrencies() {
  if (!_curCache) _curCache = safeReadJson(CURRENCIES_FILE, {});
  return _curCache;
}

function findTimezoneByValueOrUTC(key) {
  if (!key) return null;
  const q = String(key).toLowerCase();
  return (
    loadTimezones().find((t) =>
      (t.value && t.value.toLowerCase() === q) ||
      (t.abbr && t.abbr.toLowerCase() === q) ||
      (Array.isArray(t.utc) && t.utc.some((u) => String(u || "").toLowerCase() === q)) ||
      (t.text && t.text.toLowerCase().includes(q))
    ) || null
  );
}

function tzOr(contract, fallback = DEFAULT_TZ) {
  return contract?.requestedEffectiveDateTimezone || contract?.effectiveDateTimezone || contract?.admin?.timezone || fallback;
}

function nowInContractTz(contract) {
  return moment.tz(tzOr(contract)).toDate();
}

function buildRequestedEffectiveDate(rawDate, tz) {
  if (!rawDate) return undefined;
  const zone = tz || DEFAULT_TZ;
  const dateStr = String(rawDate).split("T")[0];
  const parts = dateStr.split("-");
  if (parts.length !== 3) return new Date(rawDate);
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  if (!year || !month || !day) return new Date(rawDate);
  const nowInZone = moment.tz(zone);
  nowInZone.year(year).month(month - 1).date(day);
  return nowInZone.toDate();
}

function formatDateTZ(date, tz, fmt = "MMMM D, YYYY") {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  const isDateOnlyUTC = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
  if (isDateOnlyUTC) return moment.utc(d).format(fmt);
  return tz ? moment(d).tz(tz).format(fmt) : moment(d).format(fmt);
}

function compactJoin(parts, sep = ", ") {
  return (parts || []).filter(Boolean).map((s) => String(s).trim()).filter(Boolean).join(sep);
}

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getDeep(obj, pathStr) {
  return String(pathStr).split(".").reduce((acc, key) => acc?.[key], obj);
}

function setDeep(obj, pathStr, value) {
  const keys = String(pathStr).split(".");
  let ref = obj;
  while (keys.length > 1) {
    const key = keys.shift();
    if (!ref[key] || typeof ref[key] !== "object") ref[key] = {};
    ref = ref[key];
  }
  ref[keys[0]] = value;
}

function applyAllowedDeepUpdates(target, updates, allowedPaths = []) {
  const changed = [];
  for (const pathStr of allowedPaths) {
    const incoming = getDeep(updates, pathStr);
    if (incoming === undefined) continue;
    const before = getDeep(target, pathStr);
    if (JSON.stringify(before) !== JSON.stringify(incoming)) {
      setDeep(target, pathStr, incoming);
      changed.push(pathStr);
    }
  }
  return changed;
}

function mergeDeep(base, patch) {
  if (patch === undefined) return base;
  if (Array.isArray(patch)) return patch.map((x) => mergeDeep(undefined, x));
  if (!patch || typeof patch !== "object") return patch;
  if (!base || typeof base !== "object" || Array.isArray(base)) base = {};
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = mergeDeep(out[k], v);
  return out;
}

function flatten(obj, prefix = "", out = {}) {
  if (obj instanceof Date || obj === null || obj === undefined || typeof obj !== "object" || Array.isArray(obj)) {
    out[prefix] = obj;
    return out;
  }
  const entries = Object.entries(obj);
  if (!entries.length) out[prefix] = obj;
  for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function computeEditedFields(prevObj, nextObj, whitelistTopKeys) {
  const prev = flatten(prevObj || {});
  const next = flatten(nextObj || {});
  const fields = new Set();
  const allKeys = Object.keys({ ...prev, ...next });
  for (const key of allKeys) {
    const topKey = key.split(".")[0];
    if (whitelistTopKeys && !whitelistTopKeys.includes(topKey)) continue;
    const a = prev[key] instanceof Date ? prev[key].toISOString() : JSON.stringify(prev[key]);
    const b = next[key] instanceof Date ? next[key].toISOString() : JSON.stringify(next[key]);
    if (a !== b) fields.add(key);
  }
  return Array.from(fields).sort();
}

function renderKeyValueTable(rows = []) {
  return `
    <table border="0" cellpadding="6" cellspacing="0" style="width:100%; border-collapse:collapse;">
      ${(rows || [])
      .filter(([label]) => label)
      .map(([label, value]) => `<tr><td style="width:35%;"><strong>${esc(label)}</strong></td><td>${esc(value ?? "")}</td></tr>`)
      .join("")}
    </table>
  `.trim();
}

function renderAgreementHeaderTableHTML(content = {}, tz = DEFAULT_TZ) {
  return renderKeyValueTable([
    ["Brand Legal Name", content?.brand?.legalName || ""],
    ["Brand Contact Person Name", content?.brand?.contactPersonName || ""],
    ["Brand Notice Email / Phone", compactJoin([content?.brand?.noticeEmail, content?.brand?.noticePhone], " / ")],
    ["Brand Billing Address", content?.brand?.billingAddress || ""],
    ["Influencer Legal Name / Entity", content?.influencer?.legalName || ""],
    ["Influencer Posting Handle URL", content?.influencer?.postingHandleUrl || ""],
    ["Influencer Contact Email / Phone", compactJoin([content?.influencer?.email, content?.influencer?.phone], " / ")],
    ["Influencer Address", content?.influencer?.address || compactJoin([content?.influencer?.addressLine1, content?.influencer?.addressLine2, content?.influencer?.city, content?.influencer?.state, content?.influencer?.zipPostalCode, content?.influencer?.country])],
    ["Products / Services Covered", content?.campaign?.productsServicesCovered || ""],
    ["Territory / Target Country", content?.campaign?.territoryTargetCountry || ""],
    ["Effective Date", content?.campaign?.effectiveDate ? formatDateTZ(content.campaign.effectiveDate, tz) : ""],
    ["CollabGlam LLC", compactJoin([content?.collabglam?.legalName || "CollabGlam LLC", content?.collabglam?.address || "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA", `Email: ${content?.collabglam?.email || "help@collabglam.com"}`], " | ")],
    ["Campaign Title", content?.campaign?.campaignTitleOrId || content?.campaign?.name || ""],
  ]);
}

function renderDeliverablesScheduleTable(rows = []) {
  const body = (Array.isArray(rows) ? rows : [])
    .map((r, i) => `
      <tr>
        <td>${esc(String(r?.srNo ?? i + 1))}</td>
        <td>${esc(r?.milestoneName || r?.milestoneId || "")}</td>
        <td>${esc(r?.platformHandle || r?.platform || r?.handle || "")}</td>
        <td>${esc(r?.deliverableFormat || r?.deliverableName || "")}</td>
        <td>${esc(r?.aspectRatio || "")}</td>
        <td>${esc(String(r?.qty ?? ""))}</td>
        <td>${esc(r?.contentSpecification || "")}</td>
        <td>${esc(r?.draftRequired ? "Yes" : "No")}</td>
        <td>${esc(r?.draftDue || "")}</td>
        <td>${esc(r?.liveDate || "")}</td>
      </tr>
    `)
    .join("");
  return `<table><thead><tr><th>Sr. No.</th><th>Milestone</th><th>Platform / Handle</th><th>Deliverable Type</th><th>Aspect Ratio</th><th>Qty</th><th>Specifications</th><th>Draft Required</th><th>Draft Due</th><th>Live Date</th></tr></thead><tbody>${body || `<tr><td colspan="10">No deliverables defined.</td></tr>`}</tbody></table>`;
}

function renderUsageRightsTable(rows = []) {
  const body = (Array.isArray(rows) ? rows : [])
    .map((r) => `<tr><td>${esc(r?.usageRight || "")}</td><td>${r?.selected ? "☑" : "☐"}</td><td>${esc(r?.duration || "")}</td><td>${esc(r?.territoryNotes || "")}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>Usage Right</th><th>Selected</th><th>Duration</th><th>Territory / Notes</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderMilestonesTable(rows = []) {
  const body = (Array.isArray(rows) ? rows : [])
    .map((r, i) => `<tr><td>${esc(String(i + 1))}</td><td>${esc(r?.milestoneName || "")}</td><td>${esc(r?.milestoneDescription || "")}</td><td>${esc(String(r?.paymentAmount ?? ""))}</td><td>${esc(r?.dueDate || "")}</td><td>${r?.allowDeliverables === false ? "No" : "Yes"}</td></tr>`)
    .join("");
  return `<table><thead><tr><th>#</th><th>Milestone</th><th>Description</th><th>Amount</th><th>Due Date</th><th>Deliverables Enabled</th></tr></thead><tbody>${body || `<tr><td colspan="6">No milestones defined.</td></tr>`}</tbody></table>`;
}

function renderCommercialTermsTableHTML(content = {}) {
  const commercial = content?.scheduleA?.commercial || {};
  const paymentType = normalizePaymentType(content?.campaign?.paymentType);
  if (paymentType === PAYMENT_TYPE.GIFTING) {
    return renderKeyValueTable([
      ["Product Compensation Type", "Product Gifting"],
      ["Creator Cash Compensation", "0 USD"],
      ["Validation", "No cash compensation is permitted in Product Gifting campaigns. All milestone amounts must remain $0."],
    ]);
  }

  const baseTable = renderKeyValueTable([
    ["Total Influencer Compensation", compactJoin([commercial?.influencerBudget ?? commercial?.totalCampaignFee, commercial?.currency || "USD"], " ")],
    ["Payment Distribution", commercial?.paymentStructure || commercial?.platformMilestonePaymentStructure || ""],
    ["Payment Processor Fees Borne By", commercial?.paymentProcessorFeesBorneBy || ""],
    ["Payment Processor Fee Notes", commercial?.paymentProcessorFeesNotes || ""],
    ["Lane A Marketplace Fee", commercial?.laneAMarketplaceFeeNote || ""],
  ]);
  return baseTable;
}

function buildTokenMap(contract) {
  const tz = tzOr(contract);
  const c = contract.content || {};
  const review = c?.scheduleA?.review || {};
  const commercial = c?.scheduleA?.commercial || {};
  const rawFiles = c?.scheduleA?.rawFiles || {};
  const shipping = c?.scheduleA?.shipping || {};
  const usageRights = c?.scheduleA?.usageRights || {};
  const compliance = c?.scheduleA?.compliance || {};
  const exclusivity = c?.scheduleA?.exclusivity || {};
  const cancellation = c?.scheduleA?.cancellation || {};
  const dispute = c?.scheduleA?.dispute || {};
  const effectiveDate = c?.campaign?.effectiveDate || contract.requestedEffectiveDate || contract.effectiveDate || null;
  const preShootText = c?.scheduleA?.preShootScriptRequired
    ? `Yes — due by ${c?.scheduleA?.preShootScriptDue || "N/A"} and subject to review within ${c?.scheduleA?.preShootScriptReviewBusinessDays || 2} business days`
    : "No";

  return {
    "Agreement.EffectiveDate": effectiveDate ? formatDateTZ(effectiveDate, tz) : "",
    "Agreement.EffectiveDateLong": effectiveDate ? formatDateTZ(effectiveDate, tz, "Do MMMM YYYY") : "",
    "Agreement.EffectiveDateTime": effectiveDate ? formatDateTZ(effectiveDate, tz, "MMMM D, YYYY HH:mm z") : "",
    "Agreement.HeaderTableHTML": renderAgreementHeaderTableHTML(c, tz),
    "Brand.LegalName": c?.brand?.legalName || contract.brandName || "",
    "Brand.ContactPersonName": c?.brand?.contactPersonName || "",
    "Brand.NoticeEmail": c?.brand?.noticeEmail || "",
    "Brand.NoticePhone": c?.brand?.noticePhone || "",
    "Brand.BillingAddress": c?.brand?.billingAddress || "",
    "Brand.Address": c?.brand?.billingAddress || "",
    "Influencer.LegalName": c?.influencer?.legalName || contract.influencerName || "",
    "Influencer.ContactName": c?.influencer?.contactName || c?.influencer?.legalName || "",
    "Influencer.PostingHandleUrl": c?.influencer?.postingHandleUrl || "",
    "Influencer.ContactEmail": c?.influencer?.email || "",
    "Influencer.ContactPhone": c?.influencer?.phone || "",
    "Influencer.TaxFormType": c?.influencer?.taxFormType || "",
    "Influencer.TaxId": c?.influencer?.taxId || "",
    "Influencer.AddressLine1": c?.influencer?.addressLine1 || "",
    "Influencer.AddressLine2": c?.influencer?.addressLine2 || "",
    "Influencer.City": c?.influencer?.city || "",
    "Influencer.State": c?.influencer?.state || "",
    "Influencer.ZipPostalCode": c?.influencer?.zipPostalCode || "",
    "Influencer.Country": c?.influencer?.country || "",
    "Influencer.Notes": c?.influencer?.notes || "",
    "CollabGlam.SignatoryName": c?.collabglam?.signatoryName || contract.admin?.collabglamSignatoryName || "",
    "CollabGlam.Address": c?.collabglam?.address || "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
    "Campaign.Title": c?.campaign?.campaignTitleOrId || c?.campaign?.name || "",
    "Campaign.ProductsServicesCovered": c?.campaign?.productsServicesCovered || "",
    "Campaign.Territory": c?.campaign?.territoryTargetCountry || "Worldwide",
    "SOW.CommercialTermsTableHTML": renderCommercialTermsTableHTML(c),
    "SOW.MinimumVideoSpecs": c?.scheduleA?.minimumVideoSpecs || "",
    "SOW.PreShootScriptRequiredText": preShootText,
    "SOW.MandatoryTagsMentionsLinksCodes": c?.scheduleA?.mandatoryTagsMentionsLinksCodes || "",
    "SOW.CreativeBriefMandatoryTalkingPoints": compliance?.creativeBriefMandatoryTalkingPoints || "",
    "SOW.RestrictedStatements": compliance?.restrictedStatements || "",
    "SOW.DeliverablesTableHTML": `${renderMilestonesTable(commercial?.milestones || [])}<div style="height:8px;"></div>${renderDeliverablesScheduleTable(c?.scheduleA?.deliverables || [])}`,
    "SOW.ReviewTermsTableHTML": renderKeyValueTable([
      ["Revision Required", review?.needRevisionRounds === "yes" ? "Yes" : "No"],
      ...(review?.needRevisionRounds === "yes"
        ? [
          ["Included Revision Rounds", review?.includedRevisionRounds ?? "-"],
          ["Additional Revision Fee", review?.additionalRevisionFee || "0"],
        ]
        : []),
      ["Reshoot Obligation", review?.reshootObligation || ""],
      [review?.reshootObligation === "Custom Reshoot Terms" ? "Reshoot Requirements" : "Additional Reshoot Fee", review?.reshootFee || ""],
      ["Minimum Live Period", review?.minimumLivePeriod === "Custom" ? (review?.customLivePeriod || "Custom") : (review?.minimumLivePeriod || "")],
    ]),
    "SOW.RawFilesReportingTableHTML": renderKeyValueTable([
      ["Raw / Source File Delivery", rawFiles?.rawSourceFileDelivery || ""],
      ["Files Due", rawFiles?.deliveryDue || ""],
      ["Files To Be Included", rawFiles?.format || ""],
      ["Analytics Required", rawFiles?.analyticsRequired || ""],
      ["Analytics / Reporting Deadline", rawFiles?.analyticsReportingDeadline || ""],
      ["Analytics Reporting Items", rawFiles?.analyticsReportingItems || ""],
    ]),
    "SOW.ProductShippingTableHTML": renderKeyValueTable([
      ["Product Shipping Applicable", shipping?.productShippingApplicable || ""],
      ["Product Name", shipping?.productName || ""],
      ["SKU", shipping?.sku || ""],
      ["Quantity", shipping?.quantity || ""],
      ["Estimated Product Value", shipping?.estimatedProductValue || ""],
      ["Creator Shipping Details", "Creator will provide their shipping details after receiving the contract."],
      ["Product Receipt Confirmation Deadline", shipping?.productReceiptConfirmationDeadline || ""],
      ["Product Returnable", shipping?.productReturnable || ""],
      ["Return Window", shipping?.returnWindowMethod || ""],
      ["Return Instructions", shipping?.returnInstructions || ""],
      ["Risk of Loss Notes", shipping?.riskOfLossNotes || ""],
    ]),
    "SOW.UsageRightsTableHTML": `${renderUsageRightsTable(usageRights?.rows || [])}${renderKeyValueTable([
      ["Attribution Requirement", usageRights?.attributionRequirement || ""],
      ["Attribution Text", usageRights?.attributionText || ""],
      ["Editing Rights", usageRights?.editingRights || ""],
      ["Music / Stock Asset Responsibility", usageRights?.musicStockAssetResponsibility || ""],
      ["Licensing Notes", usageRights?.musicStockAssetLicensingNotes || ""],
    ])}`,
    "SOW.ExclusivityTableHTML": renderKeyValueTable([
      ["Exclusivity / Competitor Blackout", exclusivity?.competitorBlackout || ""],
      ["Category / Competitor List", exclusivity?.competitorBlackout === "Applies" ? (exclusivity?.categoryCompetitorList || "") : ""],
      ["Exclusivity / Blackout Period", exclusivity?.competitorBlackout === "Applies" ? (exclusivity?.blackoutPeriod || "") : ""],
      ["Optional Morals / Reputation Clause", exclusivity?.optionalMoralsClause || ""],
      ...(exclusivity?.optionalMoralsClause === "Included" ? [["Morals / Reputation Clause", MORALS_REPUTATION_CLAUSE]] : []),
    ]),
    "SOW.CancellationTableHTML": renderKeyValueTable([
      ["Kill Fee / Pro-Rata Compensation", cancellation?.killFeeOrProrata || ""],
      ["Kill Fee Amount", cancellation?.killFeeAmount || ""],
      ["Pro-Rata Terms", cancellation?.proRataTerms || ""],
      ...(normalizePaymentType(c?.campaign?.paymentType) === PAYMENT_TYPE.GIFTING
        ? [
          ["Product Recovery / Non-Performance Terms", cancellation?.productRecoveryTerms || ""],
          ...(cancellation?.productRecoveryTerms === "Product Must Be Returned" ? [["Product Recovery Clause", PRODUCT_MUST_BE_RETURNED_CLAUSE]] : []),
          ["Custom Recovery Terms", cancellation?.customRefundTerms || ""],
        ]
        : [
          ["Refund of Unearned Advance", cancellation?.refundOfUnearnedAdvance || ""],
          ...(cancellation?.refundOfUnearnedAdvance === "Yes" ? [["Refund Clause", REFUND_REQUIRED_CLAUSE]] : []),
          ["Custom Refund Terms", cancellation?.customRefundTerms || ""],
        ]),
    ]),
    "SOW.DisputeTableHTML": renderKeyValueTable([
      ["Governing Law", dispute?.governingLaw || ""],
      ["Dispute Resolution Method", dispute?.disputeResolutionMethod || ""],
      ["Venue", dispute?.disputeVenue || ""],
      ["Arbitration Seat", dispute?.arbitrationSeat || ""],
      ["Dispute Resolution Details", dispute?.disputeResolutionDetails || ""],
      ["Attorneys’ Fees", dispute?.attorneysFees || ""],
      ["Attorneys’ Fees Terms", dispute?.attorneysFeesTerms || ""],
    ]),
  };
}

function renderTemplate(templateText, tokenMap) {
  return String(templateText || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, rawKey) => {
    const key = rawKey.replace(/\s*\(.*?\)\s*$/, "").trim();
    const v = tokenMap[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function injectTrustedHtmlPlaceholders(legalHTML, contract) {
  const tokens = buildTokenMap(contract);
  const swaps = [
    ["[[Agreement.HeaderTableHTML]]", tokens["Agreement.HeaderTableHTML"] || ""],
    ["[[SOW.DeliverablesTableHTML]]", tokens["SOW.DeliverablesTableHTML"] || ""],
    ["[[SOW.ReviewTermsTableHTML]]", tokens["SOW.ReviewTermsTableHTML"] || ""],
    ["[[SOW.CommercialTermsTableHTML]]", tokens["SOW.CommercialTermsTableHTML"] || ""],
    ["[[SOW.RawFilesReportingTableHTML]]", tokens["SOW.RawFilesReportingTableHTML"] || ""],
    ["[[SOW.ProductShippingTableHTML]]", tokens["SOW.ProductShippingTableHTML"] || ""],
    ["[[SOW.UsageRightsTableHTML]]", tokens["SOW.UsageRightsTableHTML"] || ""],
    ["[[SOW.ExclusivityTableHTML]]", tokens["SOW.ExclusivityTableHTML"] || ""],
    ["[[SOW.CancellationTableHTML]]", tokens["SOW.CancellationTableHTML"] || ""],
    ["[[SOW.DisputeTableHTML]]", tokens["SOW.DisputeTableHTML"] || ""],
  ];
  let out = legalHTML;
  for (const [key, html] of swaps) {
    out = out.replaceAll(key, html);
    out = out.replace(new RegExp(`<p>\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<\\/p>`, "g"), html);
  }
  return out;
}

function legalTextToHTML(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  let buffer = [];
  let inSigSection = false;
  const flushP = () => {
    if (!buffer.length) return;
    out.push(`<p>${esc(buffer.join("\n")).replace(/\n/g, "<br>")}</p>`);
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushP();
      continue;
    }
    if (/Agreement/i.test(line) && line.length > 30 && !out.length) {
      flushP();
      out.push(`<h1>${esc(line)}</h1>`);
      continue;
    }
    if (/^PART\s+\d+\s+—/i.test(line)) {
      flushP();
      out.push(`<h2>${esc(line)}</h2>`);
      continue;
    }
    if (/^Signatures$/i.test(line)) {
      flushP();
      out.push("<h2>Signatures</h2>");
      out.push('<div id="__SIG_PANEL__"></div>');
      inSigSection = true;
      continue;
    }
    if (inSigSection) {
      if (/^-{3,}.*End of Agreement.*-{3,}$/i.test(line)) {
        out.push(`<p style="text-align:center;margin-top:12pt;">--- End of Agreement ---</p>`);
      }
      continue;
    }
    const numeric = line.match(/^(\d+)\.\s+(.+)$/);
    if (numeric) {
      flushP();
      out.push(`<h3><span class="secno">${esc(numeric[1])}.</span> ${esc(numeric[2])}</h3>`);
      continue;
    }
    const alpha = line.match(/^([A-Z])\.\s+(.+)$/);
    if (alpha) {
      flushP();
      out.push(`<h3>${esc(alpha[1])}. ${esc(alpha[2])}</h3>`);
      continue;
    }
    buffer.push(rawLine);
  }

  flushP();
  if (!out.length) out.unshift(`<h1>${esc(CONTRACT_PDF_TITLE)}</h1>`);
  return out.join("\n");
}

function signaturePanelHTML(contract) {
  const tz = tzOr(contract);
  const roles = [
    { key: "brand", header: "BRAND", entityLabel: contract?.content?.brand?.legalName || contract.brandName || "—" },
    { key: "influencer", header: "INFLUENCER", entityLabel: contract?.content?.influencer?.legalName || contract.influencerName || "—" },
    { key: "collabglam", header: "COLLABGLAM LLC", entityLabel: "CollabGlam LLC" },
  ];
  const headerRow = roles.map(({ header }) => `<th style="text-align:center;background:#fff;font-weight:700;">${esc(header)}</th>`).join("");
  const sigCells = [];
  const nameCells = [];
  const dateCells = [];
  for (const { key, entityLabel } of roles) {
    const s = contract.signatures?.[key] || {};
    const imgSrc = s.sigImageDataUrl || (key === "collabglam" ? COLLABGLAM_FIXED_SIG_DATA_URL : "");
    const when = s.at ? formatDateTZ(s.at, tz, "MMMM D, YYYY") : "";
    const sigContent = imgSrc ? `<img class="sigimg" alt="Signature" src="${esc(imgSrc)}" style="max-height:50pt;max-width:100%;display:block;">` : `<div style="height:50pt;"></div>`;
    sigCells.push(`<td style="height:60pt;vertical-align:bottom;padding:4pt;">${sigContent}</td>`);
    nameCells.push(`<td style="padding:4pt;"><strong>Name:</strong> ${esc(s.name || entityLabel || "")}</td>`);
    dateCells.push(`<td style="padding:4pt;"><strong>Date:</strong> ${esc(when)}</td>`);
  }
  return `<table style="width:100%;border-collapse:collapse;table-layout:fixed;margin-top:10pt;"><thead><tr>${headerRow}</tr></thead><tbody><tr>${sigCells.join("")}</tr><tr>${nameCells.join("")}</tr><tr>${dateCells.join("")}</tr></tbody></table>`;
}

function renderContractHTML({ contract, templateText }) {
  let legalHTML = legalTextToHTML(templateText);
  legalHTML = legalHTML.replace('<div id="__SIG_PANEL__"></div>', signaturePanelHTML(contract));
  legalHTML = injectTrustedHtmlPlaceholders(legalHTML, contract);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><style>
    @page { size: A4; margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body { font-family: "Times New Roman", Times, serif; color: #000; font-size: 10.5pt; line-height: 1.35; }
    h1,h2,h3 { font-weight:700;color:#000;margin:10pt 0 6pt; }
    h1 { font-size:13pt;text-align:center;text-transform:uppercase; }
    h2 { font-size:11pt; } h3 { font-size:10.5pt; }
    p { margin:0 0 5pt;text-align:justify; }
    img,table { max-width:100%; }
    table { width:100%;border-collapse:collapse;table-layout:fixed;font-size:9.5pt;margin:6pt 0; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th,td { border:1px solid #000;padding:3pt 4pt;vertical-align:top;word-break:break-word;overflow-wrap:anywhere; }
    th { text-align:left;background:#fff;font-weight:700; }
    tr:nth-child(even) td { background:#fafafa; }
  </style></head><body><main>${legalHTML}</main></body></html>`;
}

async function launchBrowserOnce() {
  const baseOptions = {
    headless: true,
    dumpio: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions"],
    timeout: 60000,
  };
  const execPath = process.env.CHROME_EXECUTABLE_PATH;
  if (execPath && fs.existsSync(execPath)) {
    try {
      return await puppeteer.launch({ ...baseOptions, executablePath: execPath });
    } catch (err) {
      console.error("[PDF] Launch with CHROME_EXECUTABLE_PATH failed:", err?.message || err);
    }
  }
  return puppeteer.launch(baseOptions);
}

async function getSharedBrowser() {
  if (sharedBrowserPromise) {
    try {
      const b = await sharedBrowserPromise;
      if (b && b.isConnected && b.isConnected()) return b;
    } catch (_e) {
      sharedBrowserPromise = null;
    }
  }
  sharedBrowserPromise = (async () => {
    const browser = await launchBrowserOnce();
    browser.on("disconnected", () => { sharedBrowserPromise = null; });
    return browser;
  })();
  return sharedBrowserPromise;
}

async function renderPDFWithPuppeteer({ html, res, filename = "Contract.pdf", headerTitle, headerDate }) {
  let page;
  const headerTemplate = `<style>.pdf-h{font-family:"Times New Roman",Times,serif;font-size:9pt;width:100%;padding:4mm 10mm;text-align:center}.title{font-weight:bold}.effdate{margin-top:1mm}</style><div class="pdf-h"><div class="title">${esc(headerTitle || "")}</div><div class="effdate">Effective Date &amp; Time: ${esc(headerDate || "")}</div></div>`;
  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ preferCSSPageSize: true, format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate, footerTemplate: "<div></div>", margin: { top: "18mm", bottom: "14mm", left: "16mm", right: "16mm" }, scale: 1 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${filename}`);
    return res.end(pdf);
  } catch (e) {
    console.error("[PDF] Puppeteer render failed, using PDFKit fallback:", e?.message || e);
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=${filename}`);
    doc.pipe(res);
    doc.fontSize(18).text(headerTitle || CONTRACT_PDF_TITLE, { align: "center" }).moveDown();
    String(html || "").replace(/<[^>]+>/g, " ").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).forEach((p) => doc.text(p, { align: "justify" }).moveDown());
    doc.end();
  } finally {
    if (page) await page.close().catch(() => null);
  }
}

process.on("SIGTERM", async () => {
  try {
    const b = sharedBrowserPromise && (await sharedBrowserPromise);
    if (b?.close) await b.close();
  } catch (_e) { }
});

function campaignQuery(campaignId) {
  return { _id: campaignId };
}

function findContractQuery(contractId) {
  const or = [{ contractId: String(contractId) }];
  if (mongoose.Types.ObjectId.isValid(contractId)) or.push({ _id: contractId });
  return { $or: or };
}

async function findContract(contractId) {
  return Contract.findOne(findContractQuery(contractId));
}

function roleFromReq(req, explicitRole) {
  return explicitRole || req.user?.role || (req.user?.isAdmin ? "admin" : req.user?.brandId ? "brand" : req.user?.influencerId ? "influencer" : "system");
}

function requiredSigners(contract) {
  if (Array.isArray(contract?.requiredSigners) && contract.requiredSigners.length) {
    return contract.requiredSigners.map((x) => String(x).toLowerCase());
  }
  return ["brand", "influencer"];
}

function hasAcceptedCurrent(contract, role) {
  const v = Number(contract.version || 0);
  const a = contract.acceptances?.[role];
  return Boolean(a?.accepted && Number(a?.acceptedVersion) === v);
}

function markAccepted(contract, role, byUserId) {
  const v = Number(contract.version || 0);
  contract.acceptances = contract.acceptances || {};
  contract.acceptances[role] = { ...(contract.acceptances[role] || {}), accepted: true, acceptedVersion: v, at: new Date(), byUserId: byUserId || "" };
}

async function resetSignaturesForNewVersion(contract) {
  await ContractSignature.updateMany({ contractId: contract.contractId }, { $set: { signed: false, revokedAt: new Date(), revokeReason: "new_version" } });
}

function resetAcceptancesForNewVersion(contract) {
  contract.acceptances = contract.acceptances || {};
  contract.acceptances.brand = { ...(contract.acceptances.brand || {}), accepted: false };
  contract.acceptances.influencer = { ...(contract.acceptances.influencer || {}), accepted: false };
  contract.editsLockedAt = null;
  contract.awaitingRole = "influencer";
  contract.statusFlags = contract.statusFlags || {};
  contract.statusFlags.awaitingCollabglam = false;
}

function normalizeStatus(contract) {
  return Contract.normalizeStatus ? Contract.normalizeStatus(contract.status) : normalizeContractStatus(contract.status);
}

function isLockedContract(contract) {
  const st = normalizeStatus(contract);
  return Boolean(contract.lockedAt || st === CONTRACT_STATUS.CONTRACT_SIGNED || st === CONTRACT_STATUS.MILESTONES_CREATED);
}

function requireNotLocked(contract) {
  if (isLockedContract(contract)) {
    const e = new Error("Contract is locked and cannot be edited");
    e.status = 400;
    throw e;
  }
}

function requireInfluencerAcceptedCurrent(contract) {
  if (!hasAcceptedCurrent(contract, "influencer")) {
    const e = new Error("Influencer must accept the current version first");
    e.status = 400;
    throw e;
  }
}

function requireBrandAcceptedCurrent(contract) {
  if (!hasAcceptedCurrent(contract, "brand")) {
    const e = new Error("Brand must accept the current version first");
    e.status = 400;
    throw e;
  }
}

function requireReadyToSign(contract) {
  const st = normalizeStatus(contract);
  if (st !== CONTRACT_STATUS.READY_TO_SIGN || !contract.editsLockedAt) {
    const e = new Error("Contract is not ready to sign yet");
    e.status = 400;
    throw e;
  }
  if (!hasAcceptedCurrent(contract, "brand") || !hasAcceptedCurrent(contract, "influencer")) {
    const e = new Error("Both parties must accept the current version before signing");
    e.status = 400;
    throw e;
  }
}

async function nextUnsignedRole(contract) {
  const signatures = await ContractSignature.find({ contractId: contract.contractId }).lean();
  const signedByRole = signatures.reduce((acc, s) => ({ ...acc, [s.role]: Boolean(s.signed) }), {});
  for (const role of requiredSigners(contract)) {
    if (!signedByRole[role]) return role;
  }
  return null;
}

async function allRequiredSigned(contract) {
  return !(await nextUnsignedRole(contract));
}

async function syncStatusFromAcceptances(contract) {
  const prev = normalizeStatus(contract);
  const brandOk = hasAcceptedCurrent(contract, "brand");
  const infOk = hasAcceptedCurrent(contract, "influencer");
  contract.statusFlags = contract.statusFlags || {};

  if (brandOk && infOk) {
    contract.status = CONTRACT_STATUS.READY_TO_SIGN;
    contract.editsLockedAt = contract.editsLockedAt || new Date();
    const nextRole = (await nextUnsignedRole(contract)) || "brand";
    contract.awaitingRole = nextRole;
    contract.statusFlags.awaitingCollabglam = nextRole === "collabglam";
    return { movedToReady: prev !== CONTRACT_STATUS.READY_TO_SIGN, nextRole };
  }
  if (infOk && !brandOk) {
    contract.status = CONTRACT_STATUS.INFLUENCER_ACCEPTED;
    contract.awaitingRole = "brand";
    contract.statusFlags.awaitingCollabglam = false;
    return { movedToReady: false, nextRole: "brand" };
  }
  if (brandOk && !infOk) {
    contract.status = CONTRACT_STATUS.BRAND_ACCEPTED;
    contract.awaitingRole = "influencer";
    contract.statusFlags.awaitingCollabglam = false;
    return { movedToReady: false, nextRole: "influencer" };
  }
  return { movedToReady: false, nextRole: contract.awaitingRole || "influencer" };
}

function parseSignatureImage({ signatureImageDataUrl, signatureImageBase64, signatureImageMime }) {
  if (!signatureImageDataUrl && !signatureImageBase64) return "";
  if (signatureImageDataUrl) {
    const m = String(signatureImageDataUrl).match(/^data:(image\/(png|jpeg|jpg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/i);
    if (!m) {
      const e = new Error("Invalid signatureImageDataUrl. Must be image data URL with base64.");
      e.status = 400;
      throw e;
    }
    const bytes = Buffer.from(m[3], "base64").length;
    if (bytes > MAX_SIG_BYTES) {
      const e = new Error(`Signature image must be ≤ ${MAX_SIG_BYTES / 1024} KB.`);
      e.status = 400;
      throw e;
    }
    return String(signatureImageDataUrl).trim();
  }
  const mime = (signatureImageMime || "image/png").toLowerCase();
  if (!/^image\/(png|jpeg|jpg|webp|svg\+xml)$/.test(mime)) {
    const e = new Error("Unsupported signatureImageMime.");
    e.status = 400;
    throw e;
  }
  const base64 = String(signatureImageBase64 || "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
    const e = new Error("Invalid base64 payload for signature image.");
    e.status = 400;
    throw e;
  }
  return `data:${mime};base64,${base64}`;
}

function getEmailForRole({ contract, role, brandDoc, influencerDoc }) {
  if (role === "brand") return contract?.content?.brand?.noticeEmail?.trim() || contract?.other?.brandProfile?.email?.trim() || brandDoc?.email?.trim() || "";
  if (role === "influencer") return contract?.content?.influencer?.contactEmail?.trim() || contract?.content?.influencer?.email?.trim() || contract?.other?.influencerProfile?.email?.trim() || influencerDoc?.email?.trim() || "";
  if (role === "collabglam") return contract?.admin?.collabglamSignatoryEmail?.trim() || process.env.COLLABGLAM_SIGNATORY_EMAIL?.trim() || "";
  return "";
}

function getNameForRole({ contract, role, brandDoc, influencerDoc }) {
  if (role === "brand") return contract?.content?.brand?.contactPersonName || contract?.brandName || brandDoc?.name || brandDoc?.legalName || "Brand";
  if (role === "influencer") return contract?.content?.influencer?.contactName || contract?.influencerName || influencerDoc?.name || influencerDoc?.legalName || "Influencer";
  if (role === "collabglam") return contract?.content?.collabglam?.signatoryName || "CollabGlam";
  return "User";
}

async function safeSendEmail({ contract, templateKey, to, recipientRole, recipientName }) {
  if (!sendContractEmail || !to) return;
  try {
    await sendContractEmail({ contract, templateKey, to, recipientRole, recipientName });
  } catch (e) {
    console.error("[Email] send failed:", templateKey, to, e?.message || e);
  }
}

async function safeStartReminder(contract, role) {
  if (!startReminder) return;
  try { await startReminder({ contract, role }); } catch (e) { console.error("[Reminder] start failed:", role, e?.message || e); }
}
async function safeClearReminder(contractId, role) {
  if (!clearReminder) return;
  try { await clearReminder({ contractId, role }); } catch (e) { console.error("[Reminder] clear failed:", role, e?.message || e); }
}
async function safeResetReminderOnView(contract, role) {
  if (!resetReminderOnEngagement) return;
  try { await resetReminderOnEngagement({ contract, role }); } catch (e) { console.error("[Reminder] reset-on-view failed:", role, e?.message || e); }
}

function getCampaignPaymentType(_campaign, contentInput = {}) {
  return normalizePaymentType(contentInput?.campaign?.paymentType);
}

function getCampaignFee(campaign, paymentType) {
  if (paymentType === PAYMENT_TYPE.GIFTING) return 0;
  return Number(campaign?.influencerBudget || campaign?.campaignBudget || campaign?.budget || 0);
}

function buildDefaultDeliverables(_campaign, inputDeliverables) {
  if (Array.isArray(inputDeliverables) && inputDeliverables.length) return inputDeliverables;

  // Do not create a dummy deliverable from campaign/platform defaults.
  // The frontend should show one empty form, but backend content must remain empty
  // until the brand clicks Add Deliverable and submits real deliverable details.
  return [];
}

function getMandatoryTags(campaign) {
  return Array.isArray(campaign?.hashtags) && campaign.hashtags.length ? campaign.hashtags.join(", ") : "";
}

const FIXED_PAYMENT_STRUCTURE = Object.freeze({
  UPON_COMPLETION: "100% Upon Completion",
  HALF_ADVANCE_HALF_COMPLETION: "50% Advance + 50% Completion",
  CUSTOM_SPLIT: "Custom Split",
});
const LANE_A_MARKETPLACE_FEE_NOTE = "Unless expressly stated otherwise, 10% of the applicable Influencer compensation funded through the Platform is deducted from the Influencer payout and retained by CollabGlam; the Brand-funded campaign amount remains fixed.";
const MORALS_REPUTATION_CLAUSE = "Either Party may suspend or terminate the Agreement for material reputational harm resulting from serious public misconduct, as defined in this Agreement.";
const REFUND_REQUIRED_CLAUSE = "Refund required for material non-performance or uncured breach.";
const PRODUCT_MUST_BE_RETURNED_CLAUSE = "Creator must return shipped products upon material non-performance or uncured breach.";
const PRODUCT_GIFTING_MILESTONE_SEQUENCE_TEXT = "Milestones are completed sequentially. A milestone must be completed before the next milestone becomes active.";
const MILESTONE_RELEASE_SEQUENCE_TEXT = "Milestones are completed and released sequentially. A milestone must be approved and released before the next milestone becomes active.";
const CAMPAIGN_DELIVERABLES_MILESTONE_ID = "campaign-deliverables";
const ADVANCE_PAYMENT_MILESTONE_ID = "advance-payment";

function toMoney(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : fallback;
}

function truthyYes(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return value === true || ["yes", "true", "1", "included", "required", "applies", "product shipment required", "return required"].includes(v);
}

function normalizePaymentStructure(value) {
  const raw = String(value || "").trim();
  const normalized = raw.toLowerCase().replace(/\s+/g, " ");
  if (!raw) return "";
  if (["100% upon completion", "100% on completion", "upon completion", "completion"].includes(normalized)) return FIXED_PAYMENT_STRUCTURE.UPON_COMPLETION;
  if (["50% advance + 50% completion", "50 / 50", "50/50", "50% advance / 50% balance", "50% advance + 50% balance"].includes(normalized)) return FIXED_PAYMENT_STRUCTURE.HALF_ADVANCE_HALF_COMPLETION;
  if (["custom", "custom split"].includes(normalized)) return FIXED_PAYMENT_STRUCTURE.CUSTOM_SPLIT;
  return raw;
}

function parseFixedCustomSplit(commercial = {}) {
  const directAdvance = Number(commercial.fixedCustomAdvancePercent);
  const directDeliverables = Number(commercial.fixedCustomDeliverablesPercent);
  if (Number.isFinite(directAdvance) || Number.isFinite(directDeliverables)) {
    const advance = Number.isFinite(directAdvance) ? directAdvance : 0;
    const deliverables = Number.isFinite(directDeliverables) ? directDeliverables : 100 - advance;
    return { advance, deliverables };
  }
  const raw = String(commercial.customSplit || "").trim();
  const match = raw.match(/(\d+(?:\.\d+)?)\s*(?:%|)\s*(?:\/|\+|,|-)\s*(\d+(?:\.\d+)?)/);
  if (match) return { advance: Number(match[1]), deliverables: Number(match[2]) };
  return { advance: 50, deliverables: 50 };
}

function createFlowError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function buildFixedPaymentMilestones(commercial = {}) {
  const total = toMoney(commercial.totalCampaignFee ?? commercial.influencerBudget ?? 0);
  const structure = normalizePaymentStructure(commercial.paymentStructure || commercial.platformMilestonePaymentStructure);

  if (!(total > 0) || !structure) {
    return [];
  }
  const existingRows = Array.isArray(commercial.milestones) ? commercial.milestones : [];
  const existingById = existingRows.reduce((acc, row) => {
    const id = row?.milestoneId || row?.id || row?.key;
    if (id) acc[String(id)] = row;
    return acc;
  }, {});
  const dueFor = (id) => existingById[id]?.dueDate || "";

  if (structure === FIXED_PAYMENT_STRUCTURE.UPON_COMPLETION) {
    return [{
      milestoneId: CAMPAIGN_DELIVERABLES_MILESTONE_ID,
      milestoneName: "Campaign Deliverables",
      milestoneDescription: "Campaign deliverables approved for completion payment.",
      paymentAmount: total,
      splitPercent: 100,
      triggerEvent: "Upon completion and approval of campaign deliverables",
      dueDate: dueFor(CAMPAIGN_DELIVERABLES_MILESTONE_ID),
      allowDeliverables: true,
      locked: true,
      isSystemGenerated: true,
    }];
  }

  const split = structure === FIXED_PAYMENT_STRUCTURE.CUSTOM_SPLIT
    ? parseFixedCustomSplit(commercial)
    : { advance: 50, deliverables: 50 };
  const advanceAmount = toMoney(total * split.advance / 100);
  const deliverablesAmount = toMoney(total - advanceAmount);

  return [
    {
      milestoneId: ADVANCE_PAYMENT_MILESTONE_ID,
      milestoneName: "Advance Payment",
      milestoneDescription: "Advance payment before campaign deliverables are submitted.",
      paymentAmount: advanceAmount,
      splitPercent: split.advance,
      triggerEvent: "Advance payment trigger",
      dueDate: dueFor(ADVANCE_PAYMENT_MILESTONE_ID),
      allowDeliverables: false,
      locked: true,
      isSystemGenerated: true,
    },
    {
      milestoneId: CAMPAIGN_DELIVERABLES_MILESTONE_ID,
      milestoneName: "Campaign Deliverables",
      milestoneDescription: "Campaign deliverables approved for completion payment.",
      paymentAmount: deliverablesAmount,
      splitPercent: split.deliverables,
      triggerEvent: "Upon completion and approval of campaign deliverables",
      dueDate: dueFor(CAMPAIGN_DELIVERABLES_MILESTONE_ID),
      allowDeliverables: true,
      locked: true,
      isSystemGenerated: true,
    },
  ];
}

function normalizeMilestoneRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    milestoneId: String(row?.milestoneId || row?.id || `milestone-${index + 1}`),
    milestoneName: String(row?.milestoneName || `Milestone ${index + 1}`).trim(),
    milestoneDescription: String(row?.milestoneDescription || ""),
    paymentAmount: toMoney(row?.paymentAmount || 0),
    splitPercent: row?.splitPercent === undefined || row?.splitPercent === "" ? "" : toMoney(row.splitPercent),
    triggerEvent: String(row?.triggerEvent || row?.milestoneDescription || ""),
    dueDate: String(row?.dueDate || ""),
    allowDeliverables: row?.allowDeliverables === false ? false : true,
    locked: Boolean(row?.locked),
    isSystemGenerated: Boolean(row?.isSystemGenerated),
  }));
}

function hasMeaningfulDeliverableInput(row = {}) {
  if (!row || typeof row !== "object") return false;

  // Exclude old backend/frontend dummy rows such as:
  // { srNo: 1, platformHandle: "", deliverableFormat: "", qty: 1 }
  // or rows that only contain quantity/default platform text.
  return Boolean(
    String(row.deliverableName || "").trim() ||
    String(row.deliverableFormat || "").trim() ||
    String(row.contentSpecification || "").trim() ||
    String(row.aspectRatio || "").trim() ||
    String(row.handle || "").trim() ||
    String(row.liveDate || "").trim() ||
    String(row.draftDue || "").trim() ||
    String(row.preShootScriptDue || "").trim() ||
    row.draftRequired === true ||
    row.preShootScriptRequired === true
  );
}

function normalizeDeliverableRows(rows = [], milestones = []) {
  const deliverableMilestones = milestones.filter((m) => m.allowDeliverables !== false);
  const fallbackMilestone = deliverableMilestones[0] || milestones[0] || null;
  const byId = milestones.reduce((acc, row) => {
    acc[String(row.milestoneId)] = row;
    return acc;
  }, {});

  return (Array.isArray(rows) ? rows : [])
    .filter(hasMeaningfulDeliverableInput)
    .map((row, index) => {
      const requestedId = String(row?.milestoneId || "");
      const matched = byId[requestedId] && byId[requestedId].allowDeliverables !== false ? byId[requestedId] : fallbackMilestone;
      return {
        srNo: Number(row?.srNo ?? index + 1),
        milestoneId: matched?.milestoneId || "",
        milestoneName: matched?.milestoneName || "",
        platform: String(row?.platform || ""),
        handle: String(row?.handle || ""),
        handles: Array.isArray(row?.handles) ? row.handles : (row?.handle ? [row.handle] : []),
        platformHandle: String(row?.platformHandle || [row?.platform, row?.handle].filter(Boolean).join(" / ")),
        deliverableFormat: String(row?.deliverableFormat || row?.deliverableName || ""),
        deliverableName: String(row?.deliverableName || row?.deliverableFormat || ""),
        contentSpecification: String(row?.contentSpecification || ""),
        aspectRatio: String(row?.aspectRatio || ""),
        qty: Number(row?.qty || 1) || 1,
        draftRequired: Boolean(row?.draftRequired),
        draftDue: row?.draftRequired ? String(row?.draftDue || "") : "",
        liveDate: String(row?.liveDate || ""),
        preShootScriptRequired: Boolean(row?.preShootScriptRequired),
        preShootScriptDue: row?.preShootScriptRequired ? String(row?.preShootScriptDue || "") : "",
        preShootScriptReviewBusinessDays: row?.preShootScriptRequired ? Number(row?.preShootScriptReviewBusinessDays || 0) : 0,
      };
    });
}

function normalizeContractFlowContent(content = {}, campaign = null) {
  const normalized = mergeDeep({}, content || {});
  normalized.brand = normalized.brand || {};
  normalized.influencer = normalized.influencer || {};
  normalized.campaign = normalized.campaign || {};
  normalized.scheduleA = normalized.scheduleA || {};
  normalized.scheduleA.commercial = normalized.scheduleA.commercial || {};
  normalized.scheduleA.review = normalized.scheduleA.review || {};
  normalized.scheduleA.rawFiles = normalized.scheduleA.rawFiles || {};
  normalized.scheduleA.shipping = normalized.scheduleA.shipping || {};
  normalized.scheduleA.usageRights = normalized.scheduleA.usageRights || {};
  normalized.scheduleA.compliance = normalized.scheduleA.compliance || {};
  normalized.scheduleA.exclusivity = normalized.scheduleA.exclusivity || {};
  normalized.scheduleA.cancellation = normalized.scheduleA.cancellation || {};
  normalized.scheduleA.dispute = normalized.scheduleA.dispute || {};

  const paymentType = normalizePaymentType(normalized.campaign.paymentType);
  const commercial = normalized.scheduleA.commercial;
  const hasManualCompensationInput =
    (commercial.influencerBudget !== undefined &&
      commercial.influencerBudget !== null &&
      String(commercial.influencerBudget).trim() !== "") ||
    (commercial.totalCampaignFee !== undefined &&
      commercial.totalCampaignFee !== null &&
      String(commercial.totalCampaignFee).trim() !== "");
  const total = paymentType === PAYMENT_TYPE.GIFTING
    ? 0
    : hasManualCompensationInput
      ? toMoney(commercial.influencerBudget ?? commercial.totalCampaignFee ?? 0)
      : "";

  normalized.campaign.paymentType = paymentType;
  commercial.totalCampaignFee = total;
  commercial.influencerBudget = total;
  commercial.currency = commercial.currency || "USD";
  commercial.paymentStructure = paymentType === PAYMENT_TYPE.FIXED ? normalizePaymentStructure(commercial.paymentStructure || commercial.platformMilestonePaymentStructure) : (commercial.paymentStructure || commercial.platformMilestonePaymentStructure || "");
  commercial.platformMilestonePaymentStructure = commercial.paymentStructure;
  commercial.paymentProcessorFeesBorneBy = String(commercial.paymentProcessorFeesBorneBy || "").replace(/^Brand$/i, "Brand Pays").replace(/^Influencer$/i, "Creator Pays").replace(/^Split Between Both$/i, "Split");
  commercial.laneAMarketplaceFeeNote = commercial.laneAMarketplaceFeeNote || LANE_A_MARKETPLACE_FEE_NOTE;

  let milestones = [];
  if (paymentType === PAYMENT_TYPE.FIXED) {
    milestones = buildFixedPaymentMilestones(commercial);
  } else if (paymentType === PAYMENT_TYPE.MILESTONE || paymentType === PAYMENT_TYPE.GIFTING) {
    milestones = normalizeMilestoneRows(
      commercial.milestones?.length
        ? commercial.milestones
        : [{ milestoneName: paymentType === PAYMENT_TYPE.GIFTING ? "Product Gifting Deliverables" : "Milestone 1", paymentAmount: paymentType === PAYMENT_TYPE.GIFTING ? 0 : total, triggerEvent: "", dueDate: "" }]
    );

    if (paymentType === PAYMENT_TYPE.GIFTING) {
      milestones = milestones.map((row) => ({
        ...row,
        paymentAmount: 0,
        allowDeliverables: row.allowDeliverables === false ? false : true,
      }));
    }
  }
  commercial.milestones = milestones;

  normalized.scheduleA.deliverables = normalizeDeliverableRows(normalized.scheduleA.deliverables || [], commercial.milestones || []);
  normalized.scheduleA.minimumVideoSpecs = normalized.scheduleA.deliverables
    .map((row, index) => row.contentSpecification ? `Deliverable ${index + 1}: ${row.contentSpecification}` : "")
    .filter(Boolean)
    .join("\n\n");
  const firstPreShoot = normalized.scheduleA.deliverables.find((row) => row.preShootScriptRequired);
  normalized.scheduleA.preShootScriptRequired = Boolean(firstPreShoot);
  normalized.scheduleA.preShootScriptDue = firstPreShoot?.preShootScriptDue || "";
  normalized.scheduleA.preShootScriptReviewBusinessDays = firstPreShoot?.preShootScriptReviewBusinessDays || 0;

  normalized.scheduleA.rawFiles.rawSourceFileDelivery = normalized.scheduleA.rawFiles.rawSourceFileDelivery || "";
  normalized.scheduleA.rawFiles.analyticsRequired = normalized.scheduleA.rawFiles.analyticsRequired || "";
  normalized.scheduleA.shipping.productShippingApplicable = normalized.scheduleA.shipping.productShippingApplicable || "";
  normalized.scheduleA.shipping.productReturnable = normalized.scheduleA.shipping.productReturnable || "";
  normalized.scheduleA.usageRights.attributionRequirement = normalized.scheduleA.usageRights.attributionRequirement || "";
  normalized.scheduleA.usageRights.editingRights = normalized.scheduleA.usageRights.editingRights || "";
  normalized.scheduleA.usageRights.musicStockAssetResponsibility = normalized.scheduleA.usageRights.musicStockAssetResponsibility || "";

  const exclusivity = normalized.scheduleA.exclusivity;
  exclusivity.competitorBlackout = String(exclusivity.competitorBlackout || "").trim();
  exclusivity.optionalMoralsClause = String(exclusivity.optionalMoralsClause || "").trim();
  if (exclusivity.competitorBlackout !== "Applies") {
    exclusivity.categoryCompetitorList = "";
    exclusivity.blackoutPeriod = "";
  } else {
    exclusivity.categoryCompetitorList = String(exclusivity.categoryCompetitorList || "").trim();
    exclusivity.blackoutPeriod = String(exclusivity.blackoutPeriod || "").trim();
  }

  const cancellation = normalized.scheduleA.cancellation;
  cancellation.killFeeOrProrata = String(cancellation.killFeeOrProrata || "").trim();
  if (cancellation.killFeeOrProrata !== "Fixed Amount") cancellation.killFeeAmount = "";
  if (cancellation.killFeeOrProrata !== "Pro-Rata Compensation") cancellation.proRataTerms = "";

  if (paymentType === PAYMENT_TYPE.GIFTING) {
    cancellation.refundOfUnearnedAdvance = "";
    cancellation.productRecoveryTerms = String(cancellation.productRecoveryTerms || "").trim();
    if (cancellation.productRecoveryTerms !== "Custom") cancellation.customRefundTerms = "";
  } else {
    cancellation.productRecoveryTerms = "";
    cancellation.refundOfUnearnedAdvance = String(cancellation.refundOfUnearnedAdvance || "").trim();
    if (cancellation.refundOfUnearnedAdvance !== "Custom") cancellation.customRefundTerms = "";
  }

  const dispute = normalized.scheduleA.dispute;
  dispute.governingLaw = String(dispute.governingLaw || "").trim();
  dispute.disputeResolutionMethod = String(dispute.disputeResolutionMethod || "").trim();
  if (dispute.disputeResolutionMethod !== "State / Federal Courts") dispute.disputeVenue = "";
  if (dispute.disputeResolutionMethod !== "Arbitration") dispute.arbitrationSeat = "";
  if (dispute.disputeResolutionMethod !== "Other") dispute.disputeResolutionDetails = "";
  dispute.attorneysFees = String(dispute.attorneysFees || "").trim();
  if (dispute.attorneysFees !== "Other") dispute.attorneysFeesTerms = "";

  return normalized;
}

function validateContractFlowContent(content = {}, campaign = null) {
  const paymentType = normalizePaymentType(content?.campaign?.paymentType);
  const commercial = content?.scheduleA?.commercial || {};
  const total = toMoney(commercial.influencerBudget ?? commercial.totalCampaignFee ?? 0);
  const budget = toMoney(campaign?.campaignBudget ?? campaign?.budget ?? 0);

  if (paymentType !== PAYMENT_TYPE.GIFTING) {
    if (!(total > 0)) throw createFlowError("Total Influencer Compensation must be greater than 0.");
    if (budget > 0 && total > budget) throw createFlowError("Total Influencer Compensation must be less than or equal to the total campaign budget.");
  }

  const milestones = Array.isArray(commercial.milestones) ? commercial.milestones : [];
  const deliverables = Array.isArray(content?.scheduleA?.deliverables) ? content.scheduleA.deliverables : [];

  if (content?.scheduleA?.review?.minimumLivePeriod === "Custom" && !String(content?.scheduleA?.review?.customLivePeriod || "").trim()) {
    throw createFlowError("Custom Live Period is required when Minimum Live Period is Custom.");
  }

  if (paymentType === PAYMENT_TYPE.FIXED) {
    const structure = normalizePaymentStructure(commercial.paymentStructure);
    if (!Object.values(FIXED_PAYMENT_STRUCTURE).includes(structure)) throw createFlowError("Payment Distribution must be 100% Upon Completion, 50% Advance + 50% Completion, or Custom Split.");
    if (structure === FIXED_PAYMENT_STRUCTURE.CUSTOM_SPLIT) {
      const split = parseFixedCustomSplit(commercial);
      if (split.advance < 0 || split.deliverables < 0 || Math.round((split.advance + split.deliverables) * 100) / 100 !== 100) {
        throw createFlowError("Custom Split validation failed: Advance Payment % + Campaign Deliverables % must equal 100%.");
      }
    }
    if (!milestones.length) throw createFlowError("Fixed Payment campaigns must contain system-generated payment milestones.");
    if (!milestones.some((m) => m.milestoneId === CAMPAIGN_DELIVERABLES_MILESTONE_ID && m.allowDeliverables !== false)) throw createFlowError("Fixed Payment campaigns must include a Campaign Deliverables milestone with deliverables enabled.");
  }

  if (paymentType === PAYMENT_TYPE.MILESTONE) {
    if (!milestones.length) throw createFlowError("Add at least one milestone.");
    let sum = 0;
    milestones.forEach((row, index) => {
      if (!String(row.milestoneName || "").trim()) throw createFlowError(`Milestone #${index + 1}: name is required.`);
      if (!(toMoney(row.paymentAmount) > 0)) throw createFlowError(`Milestone #${index + 1}: amount must be greater than 0.`);
      if (!String(row.dueDate || "").trim()) throw createFlowError(`Milestone #${index + 1}: due date is required.`);
      sum += toMoney(row.paymentAmount);
    });
    if (Math.abs(toMoney(sum) - total) > 0.01) throw createFlowError("Sum of all milestones must equal Total Influencer Compensation.");
  }

  if (paymentType === PAYMENT_TYPE.GIFTING) {
    if (total !== 0) throw createFlowError("Product Gifting campaigns cannot include creator cash compensation.");
    if (!milestones.length) throw createFlowError("Add at least one product gifting milestone.");
    milestones.forEach((row, index) => {
      if (!String(row.milestoneName || "").trim()) throw createFlowError(`Milestone #${index + 1}: name is required.`);
      if (toMoney(row.paymentAmount) !== 0) throw createFlowError("All milestone amounts must remain $0 for Product Gifting campaigns.");
      if (!String(row.dueDate || "").trim()) throw createFlowError(`Milestone #${index + 1}: due date is required.`);
    });
  }

  if (!deliverables.length) throw createFlowError("Add at least one deliverable.");
  deliverables.forEach((row, index) => {
    if (!String(row.deliverableFormat || row.deliverableName || "").trim()) throw createFlowError(`Deliverable #${index + 1}: delivery type is required.`);
    if (!String(row.platform || row.platformHandle || "").trim()) throw createFlowError(`Deliverable #${index + 1}: platform is required.`);
    if (!String(row.aspectRatio || "").trim()) throw createFlowError(`Deliverable #${index + 1}: aspect ratio is required.`);
    if (!(Number(row.qty || 0) > 0)) throw createFlowError(`Deliverable #${index + 1}: quantity must be greater than 0.`);
    if (!String(row.milestoneId || "").trim()) throw createFlowError(`Deliverable #${index + 1}: milestone assignment is required.`);
    if (row.preShootScriptRequired && !String(row.preShootScriptDue || "").trim()) throw createFlowError(`Deliverable #${index + 1}: pre-shoot script due date is required.`);
    if (row.draftRequired && !String(row.draftDue || "").trim()) throw createFlowError(`Deliverable #${index + 1}: draft due date is required.`);
  });
}

function createDefaultContent({ campaign, brandDoc, influencerDoc, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, contentInput = {} }) {
  const effectiveDate = requestedEffectiveDate ? buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || admin?.timezone || DEFAULT_TZ) : undefined;
  const paymentType = getCampaignPaymentType(campaign, contentInput);
  const totalCampaignFee = contentInput?.scheduleA?.commercial?.totalCampaignFee ?? contentInput?.scheduleA?.commercial?.influencerBudget ?? "";
  const defaultPaymentStructure = "";
  const brandProfile = getBrandContractPrefill(brandDoc);
  const campaignTitle = getCampaignTitle(campaign);
  const campaignId = String(campaign?._id || "");

  const base = {
    brand: {
      legalName: contentInput?.brand?.legalName || brandProfile.brandName,
      contactPersonName: contentInput?.brand?.contactPersonName || contentInput?.brand?.brandPoc || brandProfile.name,
      noticeEmail: contentInput?.brand?.noticeEmail || brandProfile.noticeEmail,
      noticePhone: contentInput?.brand?.noticePhone || brandProfile.phone,
      billingAddress: contentInput?.brand?.billingAddress || brandProfile.billingAddress,
      brandPoc: contentInput?.brand?.brandPoc || contentInput?.brand?.contactPersonName || brandProfile.name,
      brandPocDesignation: contentInput?.brand?.brandPocDesignation || brandProfile.pocDesignation,
    },
    influencer: {
      legalName: influencerDoc?.legalName || influencerDoc?.name || "",
      contactName: influencerDoc?.contactName || influencerDoc?.name || "",
      postingHandleUrl: influencerDoc?.handle || influencerDoc?.profileUrl || "",
      contactEmail: influencerDoc?.email || "",
      email: influencerDoc?.email || "",
      contactPhone: influencerDoc?.phone || "",
      phone: influencerDoc?.phone || "",
      whatsApp: influencerDoc?.whatsapp || "",
      address: influencerDoc?.address || "",
    },
    collabglam: {
      legalName: "CollabGlam LLC",
      address: "CollabGlam LLC, 732 S 6th STE N, Las Vegas, Nevada 89101, USA",
      email: "help@collabglam.com",
      signatoryName: admin?.collabglamSignatoryName || "",
    },
    campaign: {
      productsServicesCovered: getCampaignProductsServicesCovered(campaign, contentInput),
      territoryTargetCountry: contentInput?.campaign?.territoryTargetCountry || getCampaignTargetCountry(campaign),
      territoryTargetCountryIds: Array.isArray(contentInput?.campaign?.territoryTargetCountryIds) ? contentInput.campaign.territoryTargetCountryIds : getCampaignCountryIds(campaign),
      effectiveDate: effectiveDate || contentInput?.campaign?.effectiveDate || null,
      campaignTitleOrId: contentInput?.campaign?.campaignTitleOrId || campaignTitle || "",
      campaignId,
      name: contentInput?.campaign?.name || campaignTitle,
      timezone: contentInput?.campaign?.timezone || "",
      paymentType,
    },
    scheduleA: {
      deliverables: buildDefaultDeliverables(campaign, contentInput?.scheduleA?.deliverables),
      minimumVideoSpecs: contentInput?.scheduleA?.minimumVideoSpecs || "",
      preShootScriptRequired: Boolean(contentInput?.scheduleA?.preShootScriptRequired),
      preShootScriptDue: contentInput?.scheduleA?.preShootScriptDue || "",
      preShootScriptReviewBusinessDays: contentInput?.scheduleA?.preShootScriptReviewBusinessDays || 2,
      mandatoryTagsMentionsLinksCodes: contentInput?.scheduleA?.mandatoryTagsMentionsLinksCodes || getMandatoryTags(campaign),
      review: {
        needRevisionRounds:
          contentInput?.scheduleA?.review?.needRevisionRounds === "yes" ||
            contentInput?.scheduleA?.review?.needRevisionRounds === true
            ? "yes"
            : "",
        includedRevisionRounds:
          contentInput?.scheduleA?.review?.needRevisionRounds === "yes" ||
            contentInput?.scheduleA?.review?.needRevisionRounds === true
            ? Number(contentInput?.scheduleA?.review?.includedRevisionRounds || 1)
            : "",

        additionalRevisionFee:
          contentInput?.scheduleA?.review?.needRevisionRounds === "yes" ||
            contentInput?.scheduleA?.review?.needRevisionRounds === true
            ? String(contentInput?.scheduleA?.review?.additionalRevisionFee || "0")
            : "",
        reshootObligation:
          contentInput?.scheduleA?.review?.reshootObligation || "",
        reshootFee: contentInput?.scheduleA?.review?.reshootFee || "",
        minimumLivePeriod: contentInput?.scheduleA?.review?.minimumLivePeriod || "",
        customLivePeriod: contentInput?.scheduleA?.review?.customLivePeriod || "",
      },
      commercial: {
        totalCampaignFee: paymentType === PAYMENT_TYPE.GIFTING ? 0 : totalCampaignFee,
        currency: contentInput?.scheduleA?.commercial?.currency || "USD",
        wantAdvancePayment: Boolean(contentInput?.scheduleA?.commercial?.wantAdvancePayment),
        advancePaymentAmount: Number(contentInput?.scheduleA?.commercial?.advancePaymentAmount || 0),
        advancePaymentType: contentInput?.scheduleA?.commercial?.advancePaymentType || "",
        paymentStructure: contentInput?.scheduleA?.commercial?.paymentStructure || contentInput?.scheduleA?.commercial?.platformMilestonePaymentStructure || defaultPaymentStructure,
        customSplit: contentInput?.scheduleA?.commercial?.customSplit || "",
        advancePaymentTrigger: contentInput?.scheduleA?.commercial?.advancePaymentTrigger || "",
        remainingPaymentTrigger: contentInput?.scheduleA?.commercial?.remainingPaymentTrigger || "",
        paymentProcessorFeesBorneBy: contentInput?.scheduleA?.commercial?.paymentProcessorFeesBorneBy || "",
        paymentProcessorFeesNotes: contentInput?.scheduleA?.commercial?.paymentProcessorFeesNotes || "",
        laneAMarketplaceFeeNote: contentInput?.scheduleA?.commercial?.laneAMarketplaceFeeNote || LANE_A_MARKETPLACE_FEE_NOTE,
        payoutMethod: contentInput?.scheduleA?.commercial?.payoutMethod || "",
        payoutAccountId: contentInput?.scheduleA?.commercial?.payoutAccountId || "",
        taxId: contentInput?.scheduleA?.commercial?.taxId || "",
        fixedCustomAdvancePercent: contentInput?.scheduleA?.commercial?.fixedCustomAdvancePercent || "",
        fixedCustomDeliverablesPercent: contentInput?.scheduleA?.commercial?.fixedCustomDeliverablesPercent || "",
        milestones: Array.isArray(contentInput?.scheduleA?.commercial?.milestones)
          ? contentInput.scheduleA.commercial.milestones
          : (paymentType === PAYMENT_TYPE.MILESTONE || paymentType === PAYMENT_TYPE.GIFTING)
            ? [{
              milestoneName: paymentType === PAYMENT_TYPE.GIFTING ? "Product Gifting Deliverables" : "Milestone 1",
              paymentAmount: 0,
              triggerEvent: "",
              dueDate: "",
              allowDeliverables: true,
            }]
            : [],
      },
      rawFiles: {
        rawSourceFileDelivery: contentInput?.scheduleA?.rawFiles?.rawSourceFileDelivery || "",
        deliveryDue: contentInput?.scheduleA?.rawFiles?.deliveryDue || "",
        format: contentInput?.scheduleA?.rawFiles?.format || "",
        analyticsRequired: contentInput?.scheduleA?.rawFiles?.analyticsRequired || "",
        analyticsReportingDeadline: contentInput?.scheduleA?.rawFiles?.analyticsReportingDeadline || "",
        analyticsReportingItems: contentInput?.scheduleA?.rawFiles?.analyticsReportingItems || "",
      },
      shipping: {
        productShippingApplicable: contentInput?.scheduleA?.shipping?.productShippingApplicable || "",
        productName: contentInput?.scheduleA?.shipping?.productName || "",
        sku: contentInput?.scheduleA?.shipping?.sku || "",
        quantity: contentInput?.scheduleA?.shipping?.quantity || "",
        estimatedProductValue: contentInput?.scheduleA?.shipping?.estimatedProductValue || "",
        shipToName: contentInput?.scheduleA?.shipping?.shipToName || "",
        shipToAddress: contentInput?.scheduleA?.shipping?.shipToAddress || "",
        shipToPhone: contentInput?.scheduleA?.shipping?.shipToPhone || "",
        productReceiptConfirmationDeadline: contentInput?.scheduleA?.shipping?.productReceiptConfirmationDeadline || "",
        productReturnable: contentInput?.scheduleA?.shipping?.productReturnable || "",
        returnWindowMethod: contentInput?.scheduleA?.shipping?.returnWindowMethod || "",
        returnInstructions: contentInput?.scheduleA?.shipping?.returnInstructions || "",
        riskOfLossNotes: contentInput?.scheduleA?.shipping?.riskOfLossNotes || "",
      },
      usageRights: {
        rows: Array.isArray(contentInput?.scheduleA?.usageRights?.rows) ? contentInput.scheduleA.usageRights.rows : [
          { usageRight: "Organic repost on Brand-owned social channels", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Brand website / blog / PDP / retailer listing", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Email / CRM / deck / internal presentation use", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Paid social / boosting / ads", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Whitelisting / Spark Ads / dark posting / creator handle", selected: false, duration: "", territoryNotes: "" },
          { usageRight: "Perpetual rights / buyout / work-made-for-hire", selected: false, duration: "", territoryNotes: "" },
        ],
        attributionRequirement: contentInput?.scheduleA?.usageRights?.attributionRequirement || "",
        attributionText: contentInput?.scheduleA?.usageRights?.attributionText || "",
        editingRights: contentInput?.scheduleA?.usageRights?.editingRights || "",
        musicStockAssetResponsibility: contentInput?.scheduleA?.usageRights?.musicStockAssetResponsibility || "",
        musicStockAssetLicensingNotes: contentInput?.scheduleA?.usageRights?.musicStockAssetLicensingNotes || "",
      },
      compliance: {
        creativeBriefMandatoryTalkingPoints: contentInput?.scheduleA?.compliance?.creativeBriefMandatoryTalkingPoints || "",
        restrictedStatements: contentInput?.scheduleA?.compliance?.restrictedStatements || "",
      },
      exclusivity: {
        competitorBlackout: contentInput?.scheduleA?.exclusivity?.competitorBlackout || "",
        categoryCompetitorList: contentInput?.scheduleA?.exclusivity?.competitorBlackout === "Applies"
          ? contentInput?.scheduleA?.exclusivity?.categoryCompetitorList || ""
          : "",
        blackoutPeriod: contentInput?.scheduleA?.exclusivity?.competitorBlackout === "Applies"
          ? contentInput?.scheduleA?.exclusivity?.blackoutPeriod || ""
          : "",
        optionalMoralsClause: contentInput?.scheduleA?.exclusivity?.optionalMoralsClause || "",
      },
      cancellation: {
        killFeeOrProrata: contentInput?.scheduleA?.cancellation?.killFeeOrProrata || "",
        killFeeAmount: contentInput?.scheduleA?.cancellation?.killFeeOrProrata === "Fixed Amount"
          ? contentInput?.scheduleA?.cancellation?.killFeeAmount || ""
          : "",
        proRataTerms: contentInput?.scheduleA?.cancellation?.killFeeOrProrata === "Pro-Rata Compensation"
          ? contentInput?.scheduleA?.cancellation?.proRataTerms || ""
          : "",
        refundOfUnearnedAdvance: paymentType === PAYMENT_TYPE.GIFTING
          ? ""
          : contentInput?.scheduleA?.cancellation?.refundOfUnearnedAdvance || "",
        customRefundTerms:
          contentInput?.scheduleA?.cancellation?.refundOfUnearnedAdvance === "Custom" ||
            contentInput?.scheduleA?.cancellation?.productRecoveryTerms === "Custom"
            ? contentInput?.scheduleA?.cancellation?.customRefundTerms || ""
            : "",
        productRecoveryTerms: paymentType === PAYMENT_TYPE.GIFTING
          ? contentInput?.scheduleA?.cancellation?.productRecoveryTerms || ""
          : "",
      },
      dispute: {
        governingLaw: contentInput?.scheduleA?.dispute?.governingLaw || "",
        disputeResolutionMethod: contentInput?.scheduleA?.dispute?.disputeResolutionMethod || "",
        disputeVenue: contentInput?.scheduleA?.dispute?.disputeResolutionMethod === "State / Federal Courts"
          ? contentInput?.scheduleA?.dispute?.disputeVenue || ""
          : "",
        arbitrationSeat: contentInput?.scheduleA?.dispute?.disputeResolutionMethod === "Arbitration"
          ? contentInput?.scheduleA?.dispute?.arbitrationSeat || ""
          : "",
        disputeResolutionDetails: contentInput?.scheduleA?.dispute?.disputeResolutionMethod === "Other"
          ? contentInput?.scheduleA?.dispute?.disputeResolutionDetails || ""
          : "",
        attorneysFees: contentInput?.scheduleA?.dispute?.attorneysFees || "",
        attorneysFeesTerms: contentInput?.scheduleA?.dispute?.attorneysFees === "Other"
          ? contentInput?.scheduleA?.dispute?.attorneysFeesTerms || ""
          : "",
      },
    },
  };
  const merged = mergeDeep(base, contentInput || {});
  return normalizeContractFlowContent(merged, campaign);
}

function buildOtherProfile({ brandDoc, influencerDoc, resolvedHandle = "" }) {
  const brandProfile = getBrandContractPrefill(brandDoc);
  return {
    brandProfile: {
      legalName: brandProfile.brandName,
      address: brandProfile.billingAddress,
      contactName: brandProfile.name,
      pocDesignation: brandProfile.pocDesignation,
      email: brandProfile.email,
      proxyEmail: brandProfile.proxyEmail,
      country: brandDoc?.country || "",
    },
    influencerProfile: {
      legalName: influencerDoc?.legalName || influencerDoc?.name || "",
      address: influencerDoc?.address || "",
      contactName: influencerDoc?.contactName || influencerDoc?.name || "",
      email: influencerDoc?.email || "",
      country: influencerDoc?.country || "",
      handle: resolvedHandle || influencerDoc?.handle || "",
    },
    autoCalcs: {},
  };
}

function buildAdmin({ campaign, requestedEffectiveDateTimezone, req }) {
  const timezone = requestedEffectiveDateTimezone || "";
  return {
    timezone,
    jurisdiction: "USA",
    arbitrationSeat: "San Francisco, CA",
    fxSource: "ECB",
    extraRevisionFee: 0,
    escrowAMLFlags: "",
    collabglamSignatoryName: "",
    collabglamSignatoryEmail: process.env.COLLABGLAM_SIGNATORY_EMAIL || "",
    legalTemplateVersion: 1,
    legalTemplateText: MASTER_TEMPLATE,
    legalTemplateHistory: [{ version: 1, text: MASTER_TEMPLATE, updatedAt: new Date(), updatedBy: req.user?.email || "system" }],
  };
}


function fieldDef(key, label, inputType, value, opts = {}) {
  return {
    key,
    label,
    inputType,
    value: value === undefined || value === null ? "" : value,
    required: Boolean(opts.required),
    editable: opts.editable !== false,
    source: opts.source || "Brand Input",
    tooltip: opts.tooltip || "",
    options: opts.options || undefined,
    ids: opts.ids || undefined,
    countries: opts.countries || undefined,
    meta: opts.meta || undefined,
    visibleWhen: opts.visibleWhen || undefined,
    validation: opts.validation || undefined,
    systemGenerated: Boolean(opts.systemGenerated),
  };
}

function sectionDef(key, title, fields, opts = {}) {
  return {
    key,
    title,
    visible: opts.visible !== false,
    description: opts.description || "",
    fields: fields.filter(Boolean),
  };
}


function asPlainObject(doc) {
  return doc && typeof doc.toObject === "function" ? doc.toObject() : (doc || {});
}

function compactString(value) {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(compactString).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return compactString(
      value.value ??
      value.label ??
      value.name ??
      value.title ??
      value.text ??
      value.answer ??
      value.description ??
      ""
    );
  }
  return String(value).trim();
}

function normalizeLookupKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const cleaned = compactString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function collectMixedFields(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectMixedFields(item, out));
    return out;
  }
  if (typeof value !== "object") return out;

  const key = compactString(value.key || value.name || value.field || value.fieldName || value.id || value.slug || value.label || value.title || value.question);
  const answer = value.value ?? value.answer ?? value.selectedValue ?? value.inputValue ?? value.text ?? value.description ?? value.data;
  if (key && answer !== undefined && answer !== null && answer !== "") {
    out.push({ key, value: answer });
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    if (["value", "answer", "selectedValue", "inputValue", "text", "description", "data"].includes(childKey)) continue;
    if (childValue && typeof childValue === "object") collectMixedFields(childValue, out);
  }

  return out;
}

function findInBrandPages(brandDoc, aliases = []) {
  const brand = asPlainObject(brandDoc);
  const normalizedAliases = aliases.map(normalizeLookupKey).filter(Boolean);
  const fields = collectMixedFields([brand.page1, brand.page2, brand.page3]);

  for (const item of fields) {
    const normalizedKey = normalizeLookupKey(item.key);
    if (!normalizedKey) continue;
    const matched = normalizedAliases.some((alias) => normalizedKey === alias || normalizedKey.includes(alias) || alias.includes(normalizedKey));
    if (matched) {
      const value = compactString(item.value);
      if (value) return value;
    }
  }

  return "";
}

function getBrandContractPrefill(brandDoc) {
  const brand = asPlainObject(brandDoc);
  const brandName = firstNonEmpty(
    brand.brandName,
    brand.legalName,
    brand.companyName,
    findInBrandPages(brand, ["brand legal name", "legal name", "company legal name", "registered business name", "brand name"]),
    brand.name
  );
  const name = firstNonEmpty(
    brand.name,
    brand.pocContact,
    brand.contactName,
    brand.ownerName,
    findInBrandPages(brand, ["brand contact person name", "contact person name", "poc", "point of contact", "primary contact", "contact name"]),
    brandName
  );
  const pocDesignation = firstNonEmpty(
    brand.pocDesignation,
    brand.brandPocDesignation,
    brand.designation,
    brand.role,
    findInBrandPages(brand, ["brand contact person designation", "contact person designation", "poc designation", "designation", "role or designation", "job title", "title"])
  );
  const billingAddress = firstNonEmpty(
    brand.billingAddress,
    brand.legalAddress,
    brand.address,
    brand.companyAddress,
    findInBrandPages(brand, ["brand billing legal address", "billing legal address", "billing address", "legal address", "registered address", "company address", "address"])
  );

  return {
    brandId: String(brand._id || brand.id || ""),
    brandName,
    name,
    proxyEmail: firstNonEmpty(brand.proxyEmail),
    noticeEmail: firstNonEmpty(brand.proxyEmail, brand.email),
    email: firstNonEmpty(brand.email),
    phone: firstNonEmpty(brand.phone, brand.mobile, brand.contactPhone, findInBrandPages(brand, ["phone", "contact phone", "notice phone"])),
    billingAddress,
    pocDesignation,
    page1: Array.isArray(brand.page1) ? brand.page1 : [],
    page2: Array.isArray(brand.page2) ? brand.page2 : [],
    page3: Array.isArray(brand.page3) ? brand.page3 : [],
  };
}

function getCampaignTitle(campaign) {
  return firstNonEmpty(campaign?.campaignTitle, campaign?.name, campaign?.title, campaign?.productOrServiceName);
}

function getCampaignProductsServicesCovered(campaign, contentInput = {}) {
  const fromInput = compactString(contentInput?.campaign?.productsServicesCovered);
  if (fromInput) return fromInput;
  const info = campaign?.productServiceInfo;
  const infoText = Array.isArray(info)
    ? info.map((item) => compactString(item)).filter(Boolean).join(", ")
    : compactString(info);
  return firstNonEmpty(campaign?.productOrServiceName, campaign?.productsServicesCovered, infoText, campaign?.description);
}

function getCampaignCountryIds(campaign) {
  const raw = Array.isArray(campaign?.targetCountryIds) ? campaign.targetCountryIds : [];
  return raw.map((item) => String(item?._id || item?.id || item)).filter(Boolean);
}

function getCountryNameFromDoc(doc) {
  return firstNonEmpty(doc?.countryName, doc?.name, doc?.title, doc?.label, doc?.country, doc?.code, doc?.iso2, doc?.iso3);
}

async function resolveCampaignCountries(campaign) {
  const ids = getCampaignCountryIds(campaign);
  const populatedRows = (Array.isArray(campaign?.targetCountryIds) ? campaign.targetCountryIds : [])
    .filter((item) => item && typeof item === "object" && (item._id || item.id))
    .map((item) => ({ id: String(item._id || item.id), name: getCountryNameFromDoc(item), code: firstNonEmpty(item.code, item.iso2, item.iso3) }));

  if (populatedRows.length) return populatedRows;

  if (ids.length && mongoose.models.Country) {
    try {
      const docs = await mongoose.models.Country.find({ _id: { $in: ids } })
        .select("name countryName title label country code iso2 iso3")
        .lean();
      const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
      return ids.map((id) => {
        const doc = byId.get(id) || {};
        return { id, name: getCountryNameFromDoc(doc), code: firstNonEmpty(doc.code, doc.iso2, doc.iso3) };
      });
    } catch (_e) {
      return ids.map((id) => ({ id, name: "", code: "" }));
    }
  }

  const countryText = firstNonEmpty(campaign?.targetCountry, campaign?.country, Array.isArray(campaign?.countries) ? campaign.countries.join(", ") : "");
  return countryText
    ? countryText.split(",").map((name) => ({ id: "", name: name.trim(), code: "" })).filter((row) => row.name)
    : [];
}

function getCampaignTargetCountry(campaign, fallback = "Worldwide", campaignCountries = []) {
  const countryNames = Array.isArray(campaignCountries)
    ? campaignCountries.map((row) => compactString(row.name || row.label || row.countryName || row.id)).filter(Boolean)
    : [];
  return (
    countryNames.join(", ") ||
    campaign?.targetCountry ||
    campaign?.campaignTargetCountry ||
    campaign?.territoryTargetCountry ||
    campaign?.country ||
    (Array.isArray(campaign?.countries) ? campaign.countries.join(", ") : "") ||
    fallback
  );
}

function getCampaignTimeline(campaign) {
  return {
    startDate: campaign?.startDate || campaign?.campaignStartDate || campaign?.timeline?.startDate || null,
    endDate: campaign?.endDate || campaign?.campaignEndDate || campaign?.timeline?.endDate || null,
  };
}

function buildRequiredContractFields({ paymentType, content, campaign, brandProfile = {}, campaignCountries = [] }) {
  const c = content || {};
  const commercial = c?.scheduleA?.commercial || {};
  const review = c?.scheduleA?.review || {};
  const rawFiles = c?.scheduleA?.rawFiles || {};
  const shipping = c?.scheduleA?.shipping || {};
  const usageRights = c?.scheduleA?.usageRights || {};
  const compliance = c?.scheduleA?.compliance || {};
  const exclusivity = c?.scheduleA?.exclusivity || {};
  const cancellation = c?.scheduleA?.cancellation || {};
  const dispute = c?.scheduleA?.dispute || {};
  const isFixed = paymentType === PAYMENT_TYPE.FIXED;
  const isMilestone = paymentType === PAYMENT_TYPE.MILESTONE;
  const isGifting = paymentType === PAYMENT_TYPE.GIFTING;

  const baseSections = [
    sectionDef("brandOverview", "A. Brand Overview", [
      fieldDef("brand.legalName", "Brand Legal Name", "text", c?.brand?.legalName || brandProfile.brandName, { source: "Auto-fetched from Brand Database", editable: false, required: true, tooltip: "Official registered legal name of the Brand." }),
      fieldDef("brand.contactPersonName", "Brand Contact Person Name (POC)", "text", c?.brand?.contactPersonName || c?.brand?.brandPoc || brandProfile.name, { required: true, tooltip: "Primary point of contact for this campaign." }),
      (c?.brand?.brandPocDesignation || brandProfile.pocDesignation) ? fieldDef("brand.brandPocDesignation", "Brand Contact Person Designation", "text", c?.brand?.brandPocDesignation || brandProfile.pocDesignation, { tooltip: "Role or designation of the campaign contact." }) : null,
      fieldDef("brand.noticeEmail", "Brand Notice Email", "email", c?.brand?.noticeEmail || brandProfile.noticeEmail, { source: "Auto-fetched brand’s Proxy Email", editable: false, required: true, tooltip: "Official campaign communication email used for notices and updates." }),
      fieldDef("brand.billingAddress", "Brand Billing / Legal Address", "textarea", c?.brand?.billingAddress || brandProfile.billingAddress, { required: true, tooltip: "Registered billing and legal address of the Brand." }),
      fieldDef("campaign.effectiveDate", "Effective Date", "date", c?.campaign?.effectiveDate, { source: "System Generated", required: true, tooltip: "Date on which the agreement becomes effective." }),
      fieldDef("campaign.productsServicesCovered", "Products / Services Covered", "textarea", c?.campaign?.productsServicesCovered, { required: true, tooltip: "Products or services included in this collaboration." }),
    ]),
    sectionDef("campaignOverview", "B. Campaign Overview", [
      fieldDef("campaign.campaignTitleOrId", "Campaign Title", "text", c?.campaign?.campaignTitleOrId || c?.campaign?.name, { source: "Auto-fetched from Campaign Database", editable: false, required: true, tooltip: "Campaign title for this campaign." }),
      fieldDef("campaign.territoryTargetCountry", "Target Country", "multi-select-country", c?.campaign?.territoryTargetCountry || getCampaignTargetCountry(campaign, "Worldwide", campaignCountries), { source: "Fetched from Campaign details", required: true, tooltip: "Countries where the campaign is intended to be promoted.", options: campaignCountries.map((row) => ({ value: row.name || row.id, label: row.name || row.id, id: row.id, code: row.code || "" })), ids: campaignCountries.map((row) => row.id).filter(Boolean), countries: campaignCountries }),
      fieldDef("campaign.timezone", "Time Zone", "select", c?.campaign?.timezone || campaign?.campaignTimezone || "", { required: true, tooltip: "Primary campaign timezone for approvals and deadlines." }),
      fieldDef("campaign.paymentType", "Campaign Payment Type", "select", paymentType, { source: "Fetched from Campaign", required: true, tooltip: "Determines campaign payment and contract structure.", options: ["Fixed Payment", "Milestone Payment", "Product Gifting"] }),
    ]),
  ];

  const commercialFields = isGifting
    ? [
      fieldDef("campaign.paymentType", "Product Compensation Type", "display", "Product Gifting", { editable: false, systemGenerated: true, tooltip: "Creator compensation is provided through products instead of monetary payment." }),
      fieldDef("scheduleA.commercial.totalCampaignFee", "Creator Cash Compensation", "currency", 0, { editable: false, systemGenerated: true, tooltip: "Creator compensation is provided through products instead of monetary payment.", validation: "No cash compensation is permitted in Product Gifting campaigns. All milestone amounts must remain $0." }),
    ]
    : [
      fieldDef("scheduleA.commercial.influencerBudget", "Total Influencer Compensation", "currency", commercial?.influencerBudget || commercial?.totalCampaignFee, { required: true, validation: "Must be greater than 0 and less than the total campaign budget. Until this field is completed, milestones and deliverables stay disabled.", tooltip: "Total creator compensation for the campaign." }),
      isFixed ? fieldDef("scheduleA.commercial.paymentStructure", "Payment Distribution", "select", commercial?.paymentStructure, { required: true, options: [FIXED_PAYMENT_STRUCTURE.UPON_COMPLETION, FIXED_PAYMENT_STRUCTURE.HALF_ADVANCE_HALF_COMPLETION, FIXED_PAYMENT_STRUCTURE.CUSTOM_SPLIT], tooltip: "Defines how compensation is distributed between milestones." }) : null,
      isFixed ? fieldDef("scheduleA.commercial.fixedCustomAdvancePercent", "Advance Payment (%)", "number", commercial?.fixedCustomAdvancePercent, { visibleWhen: "Payment Distribution = Custom Split", validation: "Advance Payment % + Campaign Deliverables % = 100%.", tooltip: "Percentage of total creator compensation paid in advance." }) : null,
      isFixed ? fieldDef("scheduleA.commercial.fixedCustomDeliverablesPercent", "Campaign Deliverables (%)", "number", commercial?.fixedCustomDeliverablesPercent, { visibleWhen: "Payment Distribution = Custom Split", validation: "Advance Payment % + Campaign Deliverables % = 100%.", tooltip: "Percentage of total creator compensation paid after deliverables are approved." }) : null,
    ];

  baseSections.push(sectionDef(isGifting ? "productCompensationTerms" : "commercialPaymentTerms", isGifting ? "C. Product Compensation Terms" : "C. Commercial and Payment Terms", [
    ...commercialFields,
    ...(isGifting ? [] : [
      fieldDef("scheduleA.commercial.paymentProcessorFeesBorneBy", "Payment Processor Fees Borne By", "select", commercial?.paymentProcessorFeesBorneBy, { options: ["Brand Pays", "Creator Pays", "Split"], tooltip: "Determines responsibility for payment processing charges." }),
      fieldDef("scheduleA.commercial.paymentProcessorFeesNotes", "Processing Fees Notes", "textarea", commercial?.paymentProcessorFeesNotes, { visibleWhen: "Payment Processor Fees Borne By = Split", inputType: "Text Area", tooltip: "Specify how processing fees will be allocated." }),
      fieldDef("scheduleA.commercial.laneAMarketplaceFeeNote", "Lane A Marketplace Fee", "display", commercial?.laneAMarketplaceFeeNote || LANE_A_MARKETPLACE_FEE_NOTE, { source: "System Generated", editable: false, systemGenerated: true, tooltip: "Marketplace fee retained by CollabGlam according to platform terms." }),
    ]),
  ]));

  baseSections.push(sectionDef("deliverablesTimeline", "D. Deliverables and Publication Timeline", [
    fieldDef("scheduleA.commercial.milestones", isFixed ? "System Generated Milestones" : "Milestones", "milestone-list", commercial?.milestones || [], { required: true, editable: !isFixed, validation: isFixed ? "Brands cannot add, delete, or modify milestones in Fixed Payment campaigns." : isGifting ? "All milestone amounts must remain $0." : "Sum of all milestones = Total Influencer Compensation." }),
    fieldDef("scheduleA.deliverables", "Deliverables Within Milestone", "deliverable-list", c?.scheduleA?.deliverables || [], { required: true, validation: isFixed ? "Deliverables can be added only to Campaign Deliverables milestone." : "Deliverables are added inside a created milestone." }),
    fieldDef("scheduleA.mandatoryTagsMentionsLinksCodes", "Mandatory Tags / Mentions / Links / Codes", "tag-input", c?.scheduleA?.mandatoryTagsMentionsLinksCodes, { tooltip: "Specify any required social media tags, brand mentions, affiliate codes, UTM links, hashtags, or links that must be included in the content." }),
    fieldDef("scheduleA.commercial.milestoneSequence", "Milestone Release Logic", "display", isGifting ? PRODUCT_GIFTING_MILESTONE_SEQUENCE_TEXT : MILESTONE_RELEASE_SEQUENCE_TEXT, { editable: false, systemGenerated: true }),
  ]));

  baseSections.push(
    sectionDef("reviewsRevisionsReshoots", "E. Reviews, Revisions, Reshoots & Posting Controls", [
      fieldDef("scheduleA.review.needRevisionRounds", "Revision Required", "select", review?.needRevisionRounds, { options: ["Yes", "No"], tooltip: "Specify whether revisions are allowed." }),
      fieldDef("scheduleA.review.includedRevisionRounds", "Included Revision Rounds", "number", review?.includedRevisionRounds, { visibleWhen: "Revision Required = Yes", tooltip: "Number of revision rounds included in campaign scope." }),
      fieldDef("scheduleA.review.additionalRevisionFee", "Additional Revision Fee", "currency", review?.additionalRevisionFee, { visibleWhen: "Revision Required = Yes", tooltip: "Fee payable for revisions beyond included revision rounds." }),
      fieldDef("scheduleA.review.reshootObligation", "Reshoot Obligation", "select", review?.reshootObligation, { options: ["No reshoot required except for material failure to follow approved brief", "One Reshoot Included", "Custom Reshoot Terms"], tooltip: "Describe custom reshoot expectations, limitations, turnaround times, or fee arrangements." }),
      fieldDef("scheduleA.review.reshootFee", "Additional Reshoot Fee / Reshoot Requirements", "textarea", review?.reshootFee, { visibleWhen: "Reshoot Obligation = One Reshoot Included or Custom Reshoot Terms", tooltip: "Fee payable for any reshoot requests beyond the included reshoot, or describe custom reshoot expectations, limitations, turnaround times, or fee arrangements." }),
      fieldDef("scheduleA.review.minimumLivePeriod", "Minimum Live Period", "select-or-custom", review?.minimumLivePeriod, { options: ["7 Days", "15 Days", "30 Days", "60 Days", "90 Days", "6 Months", "12 Months", "Custom"], tooltip: "Minimum period the creator must keep the content publicly available before removing, archiving, or materially editing it.", dummyText: "The Creator may not delete, archive, materially edit, or materially alter a live Deliverable before the agreed Minimum Live Period without prior written approval, except where required by law or platform policy." }),
      fieldDef("scheduleA.review.customLivePeriod", "Custom Live Period", "text", review?.customLivePeriod, { visibleWhen: "Minimum Live Period = Custom", placeholder: "3 Years", tooltip: "Minimum period the creator must keep the content publicly available before removing, archiving, or materially editing it." }),
    ]),
    sectionDef("rawFilesReporting", "F. Raw Files, Source Files & Reporting", [
      fieldDef("scheduleA.rawFiles.rawSourceFileDelivery", "Raw / Source File Delivery", "select", rawFiles?.rawSourceFileDelivery, { options: ["Not Included", "Included"], dummyValue: "Select Raw / Source File Delivery", tooltip: "Specify whether raw/source files must be delivered." }),
      fieldDef("scheduleA.rawFiles.deliveryDue", "Files Due By", "text", rawFiles?.deliveryDue, { visibleWhen: "Raw / Source File Delivery = Included", placeholder: "Within 7 days of content approval", tooltip: "Specify when raw/source files must be delivered." }),
      fieldDef("scheduleA.rawFiles.format", "Files To Be Included", "textarea", rawFiles?.format, { visibleWhen: "Raw / Source File Delivery = Included", placeholder: "4K MP4\nProject Files\nRaw Footage\nRAW Images\nSource Audio Files\nEditable Design Files\nOther", tooltip: "Specify the source files and assets required from the creator." }),
      fieldDef("scheduleA.rawFiles.analyticsRequired", "Analytics Required", "select", rawFiles?.analyticsRequired, { options: ["Yes", "No"], dummyValue: "Select Analytics Required", tooltip: "Specify whether the creator must provide campaign analytics after publication." }),
      fieldDef("scheduleA.rawFiles.analyticsReportingDeadline", "Analytics / Reporting Deadline", "text", rawFiles?.analyticsReportingDeadline, { visibleWhen: "Analytics Required = Yes", placeholder: "7 Days After Publication", tooltip: "Deadline for submitting campaign performance data." }),
      fieldDef("scheduleA.rawFiles.analyticsReportingItems", "Analytics Reporting Items", "multi-select-checkbox", rawFiles?.analyticsReportingItems, { visibleWhen: "Analytics Required = Yes", options: ["Live Link", "Screenshots", "Reach", "Views", "Watch Time", "Clicks", "Saves", "Shares", "Native Insights Access"], tooltip: "Select the analytics and performance data the creator must provide after publication." }),
    ]),
    sectionDef("productShippingReturns", "G. Product Shipping & Returns", [
      fieldDef("scheduleA.shipping.productShippingApplicable", "Product Shipment Required", "select", shipping?.productShippingApplicable, { options: ["No Product Shipment Required", "Product Shipment Required"], dummyValue: "Select Product Shipment", tooltip: "Specify whether physical products will be shipped to the creator for this campaign." }),
      fieldDef("scheduleA.shipping.productName", "Product Name", "text", shipping?.productName, { visibleWhen: "Product Shipment Required", tooltip: "Name of the product being shipped to the creator." }),
      fieldDef("scheduleA.shipping.sku", "SKU (Optional)", "text", shipping?.sku, { visibleWhen: "Product Shipment Required", tooltip: "Internal product SKU or identifier." }),
      fieldDef("scheduleA.shipping.quantity", "Quantity", "number", shipping?.quantity, { visibleWhen: "Product Shipment Required", tooltip: "Number of units being shipped." }),
      fieldDef("scheduleA.shipping.estimatedProductValue", "Estimated Product Value", "currency", shipping?.estimatedProductValue, { visibleWhen: "Product Shipment Required", tooltip: "Approximate retail value of the shipped product(s)." }),
      fieldDef("scheduleA.shipping.productReceiptConfirmationDeadline", "Product Receipt Confirmation Deadline", "text", shipping?.productReceiptConfirmationDeadline, { placeholder: "Within 3 business days of delivery", tooltip: "Deadline for the creator to confirm receipt of the product after delivery." }),
      fieldDef("scheduleA.shipping.productReturnable", "Product Returnable", "select", shipping?.productReturnable, { options: ["Gift / Keep Product", "Return Required"], dummyValue: "Select Product Returnable", tooltip: "Specify whether the creator may keep the product or must return it after campaign completion." }),
      fieldDef("scheduleA.shipping.returnWindowMethod", "Return Window", "text", shipping?.returnWindowMethod, { visibleWhen: "Product Returnable = Return Required", placeholder: "Within 15 days of campaign completion", tooltip: "Time period within which the product must be returned." }),
      fieldDef("scheduleA.shipping.returnInstructions", "Return Instructions", "textarea", shipping?.returnInstructions, { visibleWhen: "Product Returnable = Return Required", placeholder: "INSERT RETURN WINDOW, PREPAID LABEL / CARRIER / INSTRUCTIONS IF APPLICABLE", tooltip: "Provide return method, carrier requirements, prepaid label instructions, or other return details." }),
      fieldDef("scheduleA.shipping.riskOfLossNotes", "Risk of Loss Notes", "textarea", shipping?.riskOfLossNotes, { placeholder: "INSERT IF DIFFERENT FROM MAIN AGREEMENT", tooltip: "Specify any special shipping liability, damage, loss, or ownership terms." }),
    ]),
    sectionDef("usageRights", "H. Usage Rights & Content Ownership", [
      fieldDef("scheduleA.usageRights.rows", "Granted Usage Rights", "usage-rights", usageRights?.rows || []),
      fieldDef("scheduleA.usageRights.attributionRequirement", "Attribution Requirement", "select", usageRights?.attributionRequirement, { options: ["Credit Required", "No Attribution Required"], dummyValue: "Select Attribution Requirement" }),
      fieldDef("scheduleA.usageRights.attributionText", "Attribution Requirements", "textarea", usageRights?.attributionText, { visibleWhen: "Attribution Requirement = Credit Required" }),
      fieldDef("scheduleA.usageRights.editingRights", "Editing Rights", "select", usageRights?.editingRights, { options: ["Cropping / Resizing Only", "Brand May Create Cutdowns / Clips For Approved Uses", "No Edits Without Written Approval"], dummyValue: "Select Editing Rights" }),
      fieldDef("scheduleA.usageRights.musicStockAssetResponsibility", "Music / Stock Asset Responsibility", "select", usageRights?.musicStockAssetResponsibility, { options: ["Brand Responsible For Separate Commercial Licensing", "Creator Responsible", "Custom Responsibility"], dummyValue: "Select Music / Stock Asset Responsibility" }),
      fieldDef("scheduleA.usageRights.musicStockAssetLicensingNotes", "Licensing Notes", "textarea", usageRights?.musicStockAssetLicensingNotes, { visibleWhen: "Music / Stock Asset Responsibility = Custom Responsibility" }),
    ]),
    sectionDef("complianceBrandSafety", "I. Compliance, Claims, Tags & Brand Safety", [
      fieldDef("scheduleA.compliance.creativeBriefMandatoryTalkingPoints", "Creative Brief / Mandatory Talking Points", "textarea", compliance?.creativeBriefMandatoryTalkingPoints),
      fieldDef("scheduleA.compliance.restrictedStatements", "Restricted Statements", "textarea", compliance?.restrictedStatements),
      fieldDef("ftcComplianceClause", "FTC / Advertising / Platform Compliance", "display", "Both Parties must comply with applicable endorsement, advertising, consumer protection, and platform requirements. The Creator may not publish false, misleading, unsafe, deceptive, or unsubstantiated claims and must include all required sponsorship disclosures in accordance with applicable laws and platform policies.", { editable: false, systemGenerated: true, tooltip: "Standard compliance clause governing advertising disclosures, endorsements, and platform requirements." }),
    ]),
    sectionDef("exclusivityMorals", "J. Exclusivity, Competitor Blackout & Morals Clause", [
      fieldDef("scheduleA.exclusivity.competitorBlackout", "Exclusivity / Competitor Blackout", "select", exclusivity?.competitorBlackout || "", { options: ["None", "Applies"], dummyValue: "Select Competitor Blackout", tooltip: "Restrict creator collaborations with competing brands during the campaign period." }),
      fieldDef("scheduleA.exclusivity.categoryCompetitorList", "Category / Competitor List", "textarea", exclusivity?.competitorBlackout === "Applies" ? exclusivity?.categoryCompetitorList : "", { visibleWhen: "Exclusivity / Competitor Blackout = Applies", tooltip: "List restricted categories, brands, or competitors." }),
      fieldDef("scheduleA.exclusivity.blackoutPeriod", "Exclusivity / Blackout Period", "text-or-select", exclusivity?.competitorBlackout === "Applies" ? exclusivity?.blackoutPeriod : "", { visibleWhen: "Exclusivity / Competitor Blackout = Applies", placeholder: "48 Hours / 2 Weeks / 30 Days / 90 Days / Custom", tooltip: "Duration of the exclusivity restriction." }),
      fieldDef("scheduleA.exclusivity.optionalMoralsClause", "Optional Morals / Reputation Clause", "select", exclusivity?.optionalMoralsClause || "", { options: ["Not Included", "Included"], dummyValue: "Select Morals Clause", tooltip: "Allows suspension or termination for serious reputational harm.", includedClause: MORALS_REPUTATION_CLAUSE }),
    ]),
    sectionDef("cancellationRefundNonPerformance", "K. Cancellation, Refund & Non-Performance Terms", [
      fieldDef("scheduleA.cancellation.killFeeOrProrata", "Kill Fee / Pro-Rata Compensation", "select", cancellation?.killFeeOrProrata || "", { options: ["None", "Fixed Amount", "Pro-Rata Compensation"], dummyValue: "Select Kill Fee / Pro-Rata", tooltip: "Compensation payable if the Brand cancels without cause." }),
      fieldDef("scheduleA.cancellation.killFeeAmount", "Kill Fee Amount", "currency", cancellation?.killFeeOrProrata === "Fixed Amount" ? cancellation?.killFeeAmount : "", { visibleWhen: "Kill Fee / Pro-Rata Compensation = Fixed Amount", tooltip: "Amount payable upon cancellation." }),
      fieldDef("scheduleA.cancellation.proRataTerms", "Pro-Rata Terms", "textarea", cancellation?.killFeeOrProrata === "Pro-Rata Compensation" ? cancellation?.proRataTerms : "", { visibleWhen: "Kill Fee / Pro-Rata Compensation = Pro-Rata Compensation", placeholder: "Creator will be paid for all approved work completed before cancellation.", tooltip: "Describe compensation based on completed work." }),
      isGifting ? fieldDef("scheduleA.cancellation.productRecoveryTerms", "Product Recovery / Non-Performance Terms", "select", cancellation?.productRecoveryTerms || "", { options: ["Brand Waives Recovery Rights", "Product Must Be Returned", "Custom"], dummyValue: "Select Product Recovery Terms", tooltip: "Defines product return obligations if campaign obligations are not fulfilled.", includedClause: PRODUCT_MUST_BE_RETURNED_CLAUSE }) : fieldDef("scheduleA.cancellation.refundOfUnearnedAdvance", "Refund of Unearned Advance", "select", cancellation?.refundOfUnearnedAdvance || "", { options: ["Yes", "No", "Custom"], dummyValue: "Select Refund Option", tooltip: "Defines whether advance payments must be refunded for non-performance.", includedClause: REFUND_REQUIRED_CLAUSE }),
      fieldDef("scheduleA.cancellation.customRefundTerms", isGifting ? "Custom Recovery Terms" : "Custom Refund Terms", "textarea", isGifting ? (cancellation?.productRecoveryTerms === "Custom" ? cancellation?.customRefundTerms : "") : (cancellation?.refundOfUnearnedAdvance === "Custom" ? cancellation?.customRefundTerms : ""), { visibleWhen: isGifting ? "Product Recovery / Non-Performance Terms = Custom" : "Refund of Unearned Advance = Custom", tooltip: isGifting ? "Specify custom product return, retention, or recovery conditions." : "Specify custom refund conditions." }),
    ]),
    sectionDef("governingLawDisputes", "L. Governing Law, Dispute Resolution & Notices", [
      fieldDef("scheduleA.dispute.governingLaw", "Governing Law", "text", dispute?.governingLaw || "", { required: true, tooltip: "State or country whose laws govern this agreement." }),
      fieldDef("scheduleA.dispute.disputeResolutionMethod", "Dispute Resolution Method", "select", dispute?.disputeResolutionMethod || "", { required: true, options: ["State / Federal Courts", "Arbitration", "Other"], dummyValue: "Select Dispute Resolution Method", tooltip: "Method used to resolve legal disputes." }),
      fieldDef("scheduleA.dispute.disputeVenue", "Venue", "text", dispute?.disputeResolutionMethod === "State / Federal Courts" ? dispute?.disputeVenue : "", { visibleWhen: "Dispute Resolution Method = State / Federal Courts", tooltip: "Location where disputes will be resolved." }),
      fieldDef("scheduleA.dispute.arbitrationSeat", "Arbitration Seat", "text", dispute?.disputeResolutionMethod === "Arbitration" ? dispute?.arbitrationSeat : "", { visibleWhen: "Dispute Resolution Method = Arbitration", tooltip: "Location of the arbitration proceedings." }),
      fieldDef("scheduleA.dispute.disputeResolutionDetails", "Dispute Resolution Details", "textarea", dispute?.disputeResolutionMethod === "Other" ? dispute?.disputeResolutionDetails : "", { visibleWhen: "Dispute Resolution Method = Other", tooltip: "Specify alternative dispute resolution terms." }),
      fieldDef("scheduleA.dispute.attorneysFees", "Attorneys' Fees", "select", dispute?.attorneysFees || "", { options: ["Prevailing Party Recovers Reasonable Fees & Costs", "Each Party Bears Own Fees", "Other"], dummyValue: "Select Attorneys' Fees", tooltip: "Determines responsibility for legal fees." }),
      fieldDef("scheduleA.dispute.attorneysFeesTerms", "Attorneys' Fees Terms", "textarea", dispute?.attorneysFees === "Other" ? dispute?.attorneysFeesTerms : "", { visibleWhen: "Attorneys' Fees = Other", tooltip: "Specify custom legal fee arrangements." }),
    ])
  );

  return baseSections;
}

function collectRequiredFieldKeys(sections = []) {
  return sections.flatMap((section) => section.fields || []).filter((field) => field.required).map((field) => field.key);
}

async function syncApplyCampaignAfterSend(contract, first = false) {
  await ApplyCampaign.updateOne(
    { campaignId: String(contract.campaignId), "applicants.influencerId": String(contract.influencerId) },
    {
      $set: {
        "applicants.$.contractId": first ? String(contract.contractId) : String(contract._id),
        "applicants.$.statusInfluencer": first ? "contract-send" : "under-influencer-review",
        "applicants.$.statusBrand": first ? "under-influencer-review" : "contract-send",
      },
    }
  );
}

async function createContractRecord({ req, brandId, influencerId, campaignId, campaign, brandDoc, influencerDoc, content, other, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand = "", signatureId = "", resendOf = null, resendIteration = 0 }) {
  const requestedDateBuilt = requestedEffectiveDate
    ? buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || admin.timezone || "")
    : undefined;
  const paymentType = normalizePaymentType(content?.campaign?.paymentType);
  const contract = new Contract({
    brandId,
    influencerId,
    campaignId,
    paymentType,
    status: CONTRACT_STATUS.BRAND_SENT_DRAFT,
    awaitingRole: "influencer",
    version: 0,
    editsLockedAt: null,
    requiredSigners: ["brand", "influencer"],
    requestedEffectiveDate: requestedDateBuilt,
    requestedEffectiveDateTimezone: requestedEffectiveDateTimezone || admin.timezone || DEFAULT_TZ,
    brandName: content?.brand?.legalName || "",
    brandAddress: content?.brand?.billingAddress || "",
    brandPoc: content?.brand?.brandPoc || "",
    brandPocDesignation: content?.brand?.brandPocDesignation || "",
    influencerName: content?.influencer?.legalName || "",
    influencerAddress: content?.influencer?.address || "",
    influencerHandle: content?.influencer?.postingHandleUrl || "",
    feeAmount: Number(content?.scheduleA?.commercial?.totalCampaignFee || 0),
    currency: content?.scheduleA?.commercial?.currency || "USD",
    lastSentAt: new Date(),
    isAssigned: 1,
    isAccepted: 0,
    resendOf,
    resendIteration,
  });

  await contract.save();
  await createOrUpdateContent({ contract, content, other });
  await createOrUpdateDocument({ contract, admin, templateText: MASTER_TEMPLATE });

  if (signatureBrand) {
    await ContractSignature.upsertSigned({
      contractId: contract.contractId,
      role: "brand",
      byUserId: req.user?.id || "",
      name: getBrandContractPrefill(brandDoc).name || getBrandContractPrefill(brandDoc).brandName || "",
      email: getBrandContractPrefill(brandDoc).noticeEmail || "",
      signatureDataUrl: signatureBrand,
      savedSignatureId: signatureId || content?.brand?.brandSignature || "",
      ipAddress: req.ip || "",
      userAgent: req.get?.("user-agent") || "",
    });
    await addActivity(contract, "brand", "SIGNED_ON_INITIATE", { role: "brand", email: brandDoc?.email || "" });
  }

  await addActivity(contract, "system", resendOf ? "RESENT_CHILD_CREATED" : "INITIATED", { campaignId, status: contract.status, resendOf });
  await contract.save();
  return contract;
}

async function renderHydratedContractPdf({ contract, res, filename }) {
  const document = await ContractDocument.findOne({
    contractId: contract.contractId,
  }).lean();

  const isUploaded =
    contract.contractSource === "uploaded" ||
    document?.documentSource === "uploaded";

  if (isUploaded) {
    const upload = document?.uploadedContract || {};

    if (!upload.key) {
      const error = new Error("Uploaded contract file is missing.");
      error.status = 404;
      throw error;
    }

    const s3Object = await getContractObjectStream(upload.key);

    const safeFileName = String(
      upload.originalName || filename || "Contract.pdf"
    )
      .replace(/"/g, "")
      .trim();

    res.setHeader("Content-Type", s3Object.ContentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeFileName}"`);

    if (s3Object.ContentLength) {
      res.setHeader("Content-Length", String(s3Object.ContentLength));
    }

    s3Object.Body.on("error", (streamErr) => {
      console.error("[Contract] S3 PDF stream failed:", streamErr);

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: "Could not stream uploaded contract.",
        });
      } else {
        res.destroy(streamErr);
      }
    });

    return s3Object.Body.pipe(res);
  }

  const hydrated = await hydrateContract(contract);

  const tokens =
    hydrated.lockedAt && hydrated.renderedTextSnapshot
      ? hydrated.templateTokensSnapshot || buildTokenMap(hydrated)
      : buildTokenMap(hydrated);

  const text =
    hydrated.lockedAt && hydrated.renderedTextSnapshot
      ? hydrated.renderedTextSnapshot
      : renderTemplate(
          hydrated.admin?.legalTemplateText || MASTER_TEMPLATE,
          tokens
        );

  const html = renderContractHTML({
    contract: hydrated,
    templateText: text,
  });

  return renderPDFWithPuppeteer({
    html,
    res,
    filename,
    headerTitle: CONTRACT_PDF_TITLE,
    headerDate:
      tokens["Agreement.EffectiveDateTime"] ||
      tokens["Agreement.EffectiveDateLong"] ||
      tokens["Agreement.EffectiveDate"] ||
      "Pending",
  });
}

exports.getSendContractRequirements = async (req, res) => {
  try {
    const {
      brandId,
      campaignId,
      influencerId,
      influencerIds = [],
      paymentType: requestedPaymentType,
      mode = "single",
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
    } = req.body;

    assertRequired(req.body, ["brandId", "campaignId"]);
    if (!mongoose.Types.ObjectId.isValid(campaignId)) return respondError(res, "Invalid campaignId", 400);
    if (!mongoose.Types.ObjectId.isValid(brandId)) return respondError(res, "Invalid brandId", 400);

    const isBulk = mode === "bulk";
    const targetInfluencerIds = isBulk
      ? (Array.isArray(influencerIds) ? influencerIds.filter(Boolean).map(String) : [])
      : [String(influencerId || "").trim()].filter(Boolean);

    if (!targetInfluencerIds.length) return respondError(res, isBulk ? "influencerIds is required" : "influencerId is required", 400);

    const [campaign, brandDoc] = await Promise.all([
      Campaign.findById(campaignId),
      Brand.findById(brandId),
    ]);

    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);

    const brandProfile = getBrandContractPrefill(brandDoc);
    const campaignCountries = await resolveCampaignCountries(campaign);
    const campaignCountryIds = campaignCountries.map((row) => row.id).filter(Boolean);
    const campaignCountryValue = getCampaignTargetCountry(campaign, "Worldwide", campaignCountries);
    const campaignName = getCampaignTitle(campaign);

    const firstInfluencerId = targetInfluencerIds[0];
    if (!mongoose.Types.ObjectId.isValid(firstInfluencerId)) return respondError(res, "Invalid influencerId", 400);

    const [influencerDoc, modashDoc, existingContractDoc] = await Promise.all([
      Influencer.findById(firstInfluencerId),
      Modash.findOne({ influencerId: String(firstInfluencerId) }),
      isBulk
        ? Promise.resolve(null)
        : Contract.findOne({ brandId, campaignId, influencerId: firstInfluencerId }).sort({ createdAt: -1 }),
    ]);

    if (!influencerDoc) return respondError(res, "Influencer not found", 404);

    const existingHydrated = existingContractDoc ? await hydrateContract(existingContractDoc) : null;
    const resolvedHandle =
      modashDoc?.handle ||
      modashDoc?.username ||
      modashDoc?.instagramHandle ||
      modashDoc?.instagram?.username ||
      influencerDoc?.handle ||
      influencerDoc?.profileUrl ||
      "";

    const requestedType = normalizePaymentType(
      requestedPaymentType ||
      existingHydrated?.content?.campaign?.paymentType ||
      campaign?.paymentType ||
      campaign?.campaignPaymentType ||
      campaign?.payoutType ||
      campaign?.paymentMode ||
      PAYMENT_TYPE.FIXED
    );

    const admin = buildAdmin({ campaign, requestedEffectiveDateTimezone, req });
    const sourceContent = mergeDeep(existingHydrated?.content || {}, {
      campaign: { paymentType: requestedType },
    });

    const content = createDefaultContent({
      campaign,
      brandDoc,
      influencerDoc: {
        ...(influencerDoc.toObject ? influencerDoc.toObject() : influencerDoc),
        handle: resolvedHandle,
      },
      admin,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      contentInput: sourceContent,
    });

    content.brand.legalName = brandProfile.brandName || content.brand.legalName || "";
    content.brand.noticeEmail = brandProfile.noticeEmail || content.brand.noticeEmail || "";
    content.brand.contactPersonName = content.brand.contactPersonName || content.brand.brandPoc || brandProfile.name || "";
    content.brand.brandPoc = content.brand.brandPoc || content.brand.contactPersonName || brandProfile.name || "";
    content.brand.billingAddress = content.brand.billingAddress || brandProfile.billingAddress || "";
    content.brand.brandPocDesignation = content.brand.brandPocDesignation || brandProfile.pocDesignation || "";
    content.campaign.name = campaignName;
    content.campaign.campaignId = String(campaign?._id || campaignId);
    content.campaign.timezone = requestedEffectiveDateTimezone || content.campaign.timezone || "";
    content.campaign.territoryTargetCountry = campaignCountryValue;
    content.campaign.territoryTargetCountryIds = campaignCountryIds;
    content.campaign.productsServicesCovered = content.campaign.productsServicesCovered || getCampaignProductsServicesCovered(campaign);

    const requiredSections = buildRequiredContractFields({ paymentType: requestedType, content, campaign, brandProfile, campaignCountries });
    const campaignTimeline = getCampaignTimeline(campaign);
    const normalizedInfluencer = {
      ...(influencerDoc.toObject ? influencerDoc.toObject() : influencerDoc),
      influencerId: String(influencerDoc._id || firstInfluencerId),
      handle: resolvedHandle || influencerDoc?.handle || "",
      primaryPlatform: influencerDoc?.primaryPlatform || influencerDoc?.platform || "",
      name: influencerDoc?.name || influencerDoc?.legalName || "",
      email: influencerDoc?.email || "",
      phone: influencerDoc?.phone || "",
      whatsapp: influencerDoc?.whatsapp || "",
      address: influencerDoc?.address || "",
      productOrServiceName: campaign?.productOrServiceName || "",
    };

    return respondOK(res, {
      mode: isBulk ? "bulk" : "single",
      paymentType: requestedType,
      contractTypeLabel:
        requestedType === PAYMENT_TYPE.FIXED ? "Fixed Payment" :
          requestedType === PAYMENT_TYPE.MILESTONE ? "Milestone Payment" :
            "Product Gifting",
      contract: existingHydrated,
      brand: {
        brandId: brandProfile.brandId || String(brandDoc._id || brandId),
        brandName: brandProfile.brandName,
        name: brandProfile.name,
        proxyEmail: brandProfile.proxyEmail,
        noticeEmail: brandProfile.noticeEmail,
        billingAddress: brandProfile.billingAddress,
        ...(brandProfile.pocDesignation ? { pocDesignation: brandProfile.pocDesignation } : {}),
      },
      brandId: brandProfile.brandId || String(brandDoc._id || brandId),
      brandName: brandProfile.brandName,
      name: brandProfile.name,
      brandProxyEmail: brandProfile.proxyEmail,
      brandNoticeEmail: brandProfile.noticeEmail,
      ...(brandProfile.pocDesignation ? { brandPocDesignation: brandProfile.pocDesignation } : {}),
      influencer: normalizedInfluencer,
      influencers: isBulk ? targetInfluencerIds.map((id, index) => index === 0 ? normalizedInfluencer : { influencerId: id }) : [normalizedInfluencer],
      campaignId: String(campaign?._id || campaignId),
      campaignName,
      campaignTitle: content.campaign.name || campaignName || content.campaign.campaignTitleOrId,
      campaignBudget: Number(campaign?.campaignBudget || campaign?.budget || 0) || null,
      campaignTimeline,
      campaignProductsServicesCovered: content.campaign.productsServicesCovered,
      campaignCountries,
      campaignCountryIds,
      campaignCountry: campaignCountryValue,
      targetCountry: content.campaign.territoryTargetCountry,
      requestedEffectiveDate: content.campaign.effectiveDate || requestedEffectiveDate || new Date(),
      requestedEffectiveDateTimezone: content.campaign.timezone || "",
      content,
      requiredSections,
      requiredFieldKeys: collectRequiredFieldKeys(requiredSections),
      validations: {
        totalCompensation: requestedType === PAYMENT_TYPE.GIFTING
          ? "Creator Cash Compensation must be $0."
          : "Must be greater than 0 and less than or equal to total campaign budget.",
        fixedPayment: "Fixed Payment milestones are system-generated and locked. Deliverables can only be assigned to Campaign Deliverables milestone.",
        milestonePayment: "Sum of all milestones must equal Total Influencer Compensation.",
        productGifting: "All milestone amounts must remain $0. Milestones are completed sequentially. A milestone must be completed before the next milestone becomes active.",
      },
    });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "SEND_CONTRACT_REQUIREMENTS_ERROR");
    return respondError(res, err.message || "send contract requirements error", err.status || 500, err);
  }
};

exports.sendRequirements = exports.getSendContractRequirements;

exports.initiate = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId, content: contentInput = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, preview = false, isResend = false, resendOf, signatureBrand = "", signatureId = "" } = req.body;
    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);

    if (!mongoose.Types.ObjectId.isValid(campaignId)) return respondError(res, "Invalid campaignId", 400);
    if (!mongoose.Types.ObjectId.isValid(brandId)) return respondError(res, "Invalid brandId", 400);
    if (!mongoose.Types.ObjectId.isValid(influencerId)) return respondError(res, "Invalid influencerId", 400);

    const [campaign, brandDoc, influencerDoc] = await Promise.all([Campaign.findById(campaignId), Brand.findById(brandId), Influencer.findById(influencerId)]);
    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);
    if (!influencerDoc) return respondError(res, "Influencer not found", 404);

    const cleanSignatureBrand = String(signatureBrand || "").trim();
    if (!cleanSignatureBrand && !preview) return respondError(res, "Brand signature is required to initiate contract.", 400);

    const admin = buildAdmin({ campaign, requestedEffectiveDateTimezone, req });
    const other = buildOtherProfile({ brandDoc, influencerDoc });
    const content = createDefaultContent({ campaign, brandDoc, influencerDoc, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, contentInput });
    validateContractFlowContent(content, campaign);

    if (preview && !isResend) {
      const tmp = {
        brandId,
        influencerId,
        campaignId,
        content,
        other,
        admin,
        requestedEffectiveDate: requestedEffectiveDate
          ? buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || admin.timezone || "")
          : null,
        requestedEffectiveDateTimezone: requestedEffectiveDateTimezone || admin.timezone || "",
        brandName: content.brand.legalName,
        influencerName: content.influencer.legalName,
        signatures: { brand: { signed: Boolean(cleanSignatureBrand), sigImageDataUrl: cleanSignatureBrand }, influencer: {}, collabglam: {} },
      };
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(admin.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      return renderPDFWithPuppeteer({ html, res, filename: `Contract-Preview-${campaignId}.pdf`, headerTitle: CONTRACT_PDF_TITLE, headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || "Pending" });
    }

    if (isResend && resendOf) {
      const parent = await Contract.findOne({ contractId: resendOf });
      if (!parent) return respondError(res, "resendOf contract not found", 404);
      if (String(parent.brandId) !== String(brandId) || String(parent.influencerId) !== String(influencerId) || String(parent.campaignId) !== String(campaignId)) return respondError(res, "resendOf must belong to the same brand, influencer, and campaign", 400);
      if (isLockedContract(parent)) return respondError(res, "Cannot resend a signed/locked contract", 400);

      const child = await createContractRecord({ req, brandId, influencerId, campaignId, campaign, brandDoc, influencerDoc, content, other, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand: cleanSignatureBrand, signatureId, resendOf: parent.contractId, resendIteration: Number(parent.resendIteration || 0) + 1 });
      parent.supersededBy = child.contractId;
      parent.resentAt = new Date();
      parent.status = CONTRACT_STATUS.SUPERSEDED;
      parent.statusFlags = parent.statusFlags || {};
      parent.statusFlags.isSuperseded = true;
      await addActivity(parent, "system", "RESENT", { to: child.contractId, by: req.user?.email || "system" });
      await parent.save();

      await Campaign.updateOne(campaignQuery(campaignId), { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } });
      await safeStartReminder(child, "influencer");
      await safeClearReminder(child.contractId, "brand");
      const hydratedChild = await hydrateContract(child);
      return respondOK(res, { message: "Resent contract created", contract: hydratedChild }, 201);
    }

    const contract = await createContractRecord({ req, brandId, influencerId, campaignId, campaign, brandDoc, influencerDoc, content, other, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand: cleanSignatureBrand, signatureId });
    await syncApplyCampaignAfterSend(contract, true);
    await syncApplyCampaignAfterSend(contract, false);
    await Campaign.updateOne(campaignQuery(campaignId), { $set: { isContracted: 1 } });

    await createAndEmit({ recipientType: "influencer", influencerId: String(influencerId), type: "contract.initiated", title: `Contract initiated by ${brandDoc.name || "Brand"}`, message: `Contract created for "${campaign.productOrServiceName || "Campaign"}".`, entityType: "contract", entityId: String(contract.contractId), actionPath: "/influencer/my-campaign", meta: { campaignId, brandId, influencerId } });
    await createAndEmit({ recipientType: "brand", brandId: String(brandId), type: "contract.initiated.self", title: "Contract sent", message: `You sent a contract to ${influencerDoc.name || "Influencer"}.`, entityType: "contract", entityId: String(contract.contractId), actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`, meta: { campaignId, influencerId } });

    const hydrated = await hydrateContract(contract);
    await safeSendEmail({ contract: hydrated, templateKey: "contract_new_received_influencer", to: getEmailForRole({ contract: hydrated, role: "influencer", influencerDoc }), recipientRole: "influencer", recipientName: getNameForRole({ contract: hydrated, role: "influencer", influencerDoc }) });
    await safeStartReminder(contract, "influencer");
    await safeClearReminder(contract.contractId, "brand");

    return respondOK(res, { message: "Contract initialized successfully", contract: hydrated }, 201);
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INITIATE_ERROR");
    return respondError(res, err.message || "initiate error", err.status || 500, err);
  }
};

exports.viewed = async (req, res) => {
  try {
    const { contractId, role } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    const who = roleFromReq(req, role);
    if (who === "brand") contract.lastViewedByBrandAt = new Date();
    if (who === "influencer") contract.lastViewedByInfluencerAt = new Date();
    await addActivity(contract, who, "VIEWED");
    await contract.save();
    if (who === "brand" || who === "influencer") await safeResetReminderOnView(contract, who);
    return respondOK(res, { message: "Marked viewed", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "VIEWED_ERROR");
    return respondError(res, err.message || "viewed error", err.status || 500, err);
  }
};

exports.influencerConfirm = async (req, res) => {
  try {
    const { contractId, influencer: influencerData = {}, creatorUpdates = {}, signatureInfluencer = "", preview = false } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    if (contract.editsLockedAt) return respondError(res, "Contract is locked for signing; edits/accept changes are disabled", 400);

    const hydrated = await hydrateContract(contract);
    const creatorContentUpdates = creatorUpdates?.content || {};
    const content = mergeDeep(
      hydrated.content || {},
      mergeDeep(creatorContentUpdates, {
        influencer: { ...(hydrated.content?.influencer || {}), ...influencerData },
      })
    );

    if (preview) {
      const tmp = { ...hydrated, content, signatures: { ...(hydrated.signatures || {}) } };
      if (signatureInfluencer) tmp.signatures.influencer = { signed: true, sigImageDataUrl: signatureInfluencer };
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      return renderPDFWithPuppeteer({ html, res, filename: `Contract-Influencer-Preview-${contractId}.pdf`, headerTitle: CONTRACT_PDF_TITLE, headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || "Pending" });
    }

    const before = { influencer: hydrated.content?.influencer || {}, signatureInfluencer: hydrated.signatureInfluencer || "" };
    await createOrUpdateContent({ contract, content, other: hydrated.other || {} });

    if (signatureInfluencer) {
      await ContractSignature.upsertSigned({ contractId: contract.contractId, role: "influencer", byUserId: req.user?.id || "", name: content.influencer?.legalName || contract.influencerName || "", email: content.influencer?.email || "", signatureDataUrl: signatureInfluencer, ipAddress: req.ip || "", userAgent: req.get?.("user-agent") || "" });
    }

    contract.influencerName = content.influencer?.legalName || contract.influencerName || "";
    contract.influencerAddress = content.influencer?.address || compactJoin([content.influencer?.addressLine1, content.influencer?.addressLine2, content.influencer?.city, content.influencer?.state, content.influencer?.zipPostalCode, content.influencer?.country]);
    contract.feeAmount = Number(content?.scheduleA?.commercial?.totalCampaignFee || contract.feeAmount || 0);
    contract.currency = content?.scheduleA?.commercial?.currency || contract.currency || "USD";

    const after = { influencer: content.influencer, scheduleA: content.scheduleA, campaign: content.campaign, signatureInfluencer };
    const editedFields = computeEditedFields(before, after, ["influencer", "signatureInfluencer"]);
    if (editedFields.length) {
      contract.version += 1;
      resetAcceptancesForNewVersion(contract);
      await resetSignaturesForNewVersion(contract);
      contract.status = CONTRACT_STATUS.INFLUENCER_EDITED;
      contract.awaitingRole = "brand";
      await addActivity(contract, "influencer", "INFLUENCER_EDITED", { editedFields, byUserId: req.user?.id || "" }, before);
    }

    markAccepted(contract, "influencer", req.user?.id);
    const sync = await syncStatusFromAcceptances(contract);
    contract.isAccepted = 1;
    await addActivity(contract, "influencer", "INFLUENCER_ACCEPTED", { editedFields, version: contract.version, nextRole: sync.nextRole, hasSignature: Boolean(signatureInfluencer) });
    await contract.save();

    await ApplyCampaign.updateOne({ campaignId: String(contract.campaignId), "applicants.influencerId": String(contract.influencerId) }, { $set: { "applicants.$.isShortlisted": 0 } });
    await Campaign.updateOne(campaignQuery(contract.campaignId), { $set: { isAccepted: 1, isContracted: 1, contractId: contract.contractId } });

    const out = await hydrateContract(contract);
    await safeSendEmail({ contract: out, templateKey: "contract_accepted_by_influencer_brand_notify", to: getEmailForRole({ contract: out, role: "brand" }), recipientRole: "brand", recipientName: getNameForRole({ contract: out, role: "brand" }) });
    if (contract.awaitingRole === "brand") await safeStartReminder(contract, "brand");
    await safeClearReminder(contract.contractId, "influencer");

    return respondOK(res, { message: "Influencer acceptance saved", contract: out });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_CONFIRM_ERROR");
    return respondError(res, err.message || "influencerConfirm error", err.status || 500, err);
  }
};

exports.brandConfirm = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    if (contract.editsLockedAt) return respondError(res, "Contract is already locked for signing", 400);
    requireInfluencerAcceptedCurrent(contract);

    markAccepted(contract, "brand", req.user?.id);
    const sync = await syncStatusFromAcceptances(contract);
    if (sync.movedToReady) await addActivity(contract, "system", "READY_TO_SIGN", { version: contract.version, nextRole: sync.nextRole });
    await addActivity(contract, "brand", "BRAND_ACCEPTED", { version: contract.version, byUserId: req.user?.id || "" });
    await contract.save();
    await ApplyCampaign.updateOne({ campaignId: String(contract.campaignId), "applicants.influencerId": String(contract.influencerId) }, { $set: { "applicants.$.statusBrand": "contractAccept" } });

    const out = await hydrateContract(contract);
    await safeSendEmail({ contract: out, templateKey: "contract_accepted_by_brand_influencer_notify", to: getEmailForRole({ contract: out, role: "influencer" }), recipientRole: "influencer", recipientName: getNameForRole({ contract: out, role: "influencer" }) });
    return respondOK(res, { message: "Brand acceptance saved", contract: out });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_CONFIRM_ERROR");
    return respondError(res, err.message || "brandConfirm error", err.status || 500, err);
  }
};

exports.adminUpdate = async (req, res) => {
  try {
    const { contractId, adminUpdates = {}, newLegalText } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    if (!req.user?.isAdmin) return respondError(res, "Forbidden: admin only", 403);
    requireNotLocked(contract);

    const doc = (await ContractDocument.findOne({ contractId: contract.contractId })) || new ContractDocument({ contractId: contract.contractId });
    const before = doc.toObject();
    Object.assign(doc, adminUpdates);
    if (typeof newLegalText === "string" && newLegalText.trim()) {
      doc.legalTemplateVersion = Number(doc.legalTemplateVersion || 1) + 1;
      doc.legalTemplateText = newLegalText;
      doc.legalTemplateHistory = doc.legalTemplateHistory || [];
      doc.legalTemplateHistory.push({ version: doc.legalTemplateVersion, text: newLegalText, updatedAt: new Date(), updatedBy: req.user?.email || "admin" });
    }
    await doc.save();
    const editedFields = computeEditedFields(before, doc.toObject(), null);
    if (editedFields.length) {
      contract.version += 1;
      resetAcceptancesForNewVersion(contract);
      await resetSignaturesForNewVersion(contract);
      contract.status = CONTRACT_STATUS.BRAND_SENT_DRAFT;
      contract.awaitingRole = "influencer";
      await addActivity(contract, "admin", "ADMIN_UPDATED", { adminUpdates: Object.keys(adminUpdates), newLegalVersion: doc.legalTemplateVersion, editedFields });
      await contract.save();
      await safeStartReminder(contract, "influencer");
      await safeClearReminder(contract.contractId, "brand");
    }
    return respondOK(res, { message: "Admin settings updated", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "ADMIN_UPDATE_ERROR");
    return respondError(res, err.message || "adminUpdate error", err.status || 500, err);
  }
};

exports.finalize = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    requireInfluencerAcceptedCurrent(contract);
    requireBrandAcceptedCurrent(contract);
    if (contract.status === CONTRACT_STATUS.READY_TO_SIGN && contract.editsLockedAt) return respondOK(res, { message: "Already ready to sign", contract: await hydrateContract(contract) });
    const prev = normalizeStatus(contract);
    contract.status = CONTRACT_STATUS.READY_TO_SIGN;
    contract.editsLockedAt = new Date();
    contract.awaitingRole = (await nextUnsignedRole(contract)) || "brand";
    contract.statusFlags.awaitingCollabglam = contract.awaitingRole === "collabglam";
    await addActivity(contract, "system", "READY_TO_SIGN", { version: contract.version, prevStatus: prev, awaitingRole: contract.awaitingRole });
    await contract.save();
    const out = await hydrateContract(contract);
    await safeSendEmail({ contract: out, templateKey: "contract_ready_to_sign_both", to: getEmailForRole({ contract: out, role: "brand" }), recipientRole: "brand", recipientName: getNameForRole({ contract: out, role: "brand" }) });
    await safeSendEmail({ contract: out, templateKey: "contract_ready_to_sign_both", to: getEmailForRole({ contract: out, role: "influencer" }), recipientRole: "influencer", recipientName: getNameForRole({ contract: out, role: "influencer" }) });
    await safeClearReminder(contract.contractId, "brand");
    await safeClearReminder(contract.contractId, "influencer");
    return respondOK(res, { message: "Contract finalized for signatures", contract: out });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "FINALIZE_ERROR");
    return respondError(res, err.message || "finalize error", err.status || 500, err);
  }
};

exports.preview = async (req, res) => {
  try {
    const { contractId } = req.query;
    assertRequired(req.query, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    return renderHydratedContractPdf({ contract, res, filename: `Contract-Preview-${contractId}.pdf` });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "PREVIEW_ERROR");
    return respondError(res, err.message || "preview error", err.status || 500, err);
  }
};

exports.sign = async (req, res) => {
  try {
    const { contractId, role, name, email, effectiveDateOverride, signatureImageDataUrl, signatureImageBase64, signatureImageMime } = req.body;
    assertRequired(req.body, ["contractId", "role"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    const signerRole = String(role).toLowerCase();
    const allowed = requiredSigners(contract);
    if (!allowed.includes(signerRole)) return respondError(res, `Invalid role. Allowed signers: ${allowed.join(", ")}`, 400);
    requireReadyToSign(contract);
    const existing = await ContractSignature.findOne({ contractId: contract.contractId, role: signerRole, signed: true });
    if (existing) return respondError(res, "Already signed for this role", 400);
    const signatureDataUrl = parseSignatureImage({ signatureImageDataUrl, signatureImageBase64, signatureImageMime });
    await ContractSignature.upsertSigned({ contractId: contract.contractId, role: signerRole, byUserId: req.user?.id || "", name, email, signatureDataUrl, ipAddress: req.ip || "", userAgent: req.get?.("user-agent") || "" });
    if (effectiveDateOverride && req.user?.isAdmin) contract.effectiveDateOverride = new Date(effectiveDateOverride);
    await addActivity(contract, signerRole, "SIGNED", { role: signerRole, name, email });
    const nextRole = await nextUnsignedRole(contract);
    contract.awaitingRole = nextRole;
    contract.statusFlags.awaitingCollabglam = nextRole === "collabglam";
    const locked = await allRequiredSigned(contract);
    if (locked) {
      const hydrated = await hydrateContract(contract);
      const tokens = buildTokenMap(hydrated);
      const rendered = renderTemplate(hydrated.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: hydrated, templateText: rendered });
      contract.effectiveDate = contract.effectiveDateOverride || hydrated?.content?.campaign?.effectiveDate || contract.requestedEffectiveDate || nowInContractTz(hydrated);
      contract.effectiveDateTimezone = tzOr(hydrated);
      contract.lockedAt = new Date();
      contract.status = CONTRACT_STATUS.CONTRACT_SIGNED;
      contract.awaitingRole = null;
      await ContractDocument.findOneAndUpdate({ contractId: contract.contractId }, { $set: { templateTokensSnapshot: tokens, renderedTextSnapshot: rendered, renderedHtmlSnapshot: html, frozenAt: new Date(), frozenByRole: signerRole } }, { upsert: true });
      await addActivity(contract, "system", "LOCKED", { allSigned: true });
    }
    await contract.save();
    await Campaign.updateOne(campaignQuery(contract.campaignId), { $set: { isContracted: 1, contractId: contract.contractId, ...(locked ? { contractLockedAt: contract.lockedAt || new Date() } : {}) } });
    await safeClearReminder(contract.contractId, signerRole);
    if (!locked && nextRole) await safeStartReminder(contract, nextRole);
    if (locked) {
      await safeClearReminder(contract.contractId, "brand");
      await safeClearReminder(contract.contractId, "influencer");
      await safeClearReminder(contract.contractId, "collabglam");
    }
    return respondOK(res, { message: locked ? "Signed & locked" : "Signature recorded", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "SIGN_ERROR");
    return respondError(res, err.message || "sign error", err.status || 500, err);
  }
};

async function updateContractFields({ req, res, actorRole, allowedPaths, updates, requestedEffectiveDate, requestedEffectiveDateTimezone }) {
  const { contractId } = req.body;
  assertRequired(req.body, ["contractId"]);
  const contract = await findContract(contractId);
  if (!contract) return respondError(res, "Contract not found", 404);
  requireNotLocked(contract);
  if (contract.isFinalUpdate) return respondError(res, "Contract has been finalized; further edits are not allowed.", 400);
  if (contract.editsLockedAt) return respondError(res, "Contract is locked for signing; edits are disabled", 400);

  const hydrated = await hydrateContract(contract);
  const campaignDoc = await Campaign.findById(contract.campaignId);
  if (!campaignDoc) return respondError(res, "Campaign not found", 404);
  const before = { content: hydrated.content || {} };
  const working = { content: JSON.parse(JSON.stringify(hydrated.content || {})) };
  const changedPaths = applyAllowedDeepUpdates(working, updates, allowedPaths);

  if (requestedEffectiveDate) {
    const builtDate = buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || contract.requestedEffectiveDateTimezone || DEFAULT_TZ);
    contract.requestedEffectiveDate = builtDate;
    contract.requestedEffectiveDateTimezone = requestedEffectiveDateTimezone || contract.requestedEffectiveDateTimezone || DEFAULT_TZ;
    working.content.campaign = working.content.campaign || {};
    working.content.campaign.effectiveDate = builtDate;
  }

  working.content = normalizeContractFlowContent(working.content, campaignDoc);
  validateContractFlowContent(working.content, campaignDoc);

  const editedFields = computeEditedFields(before, { content: working.content }, ["content"]);
  if (editedFields.length || changedPaths.length) {
    contract.version += 1;
    resetAcceptancesForNewVersion(contract);
    await resetSignaturesForNewVersion(contract);
    contract.status = actorRole === "brand" ? CONTRACT_STATUS.BRAND_EDITED : CONTRACT_STATUS.INFLUENCER_EDITED;
    contract.awaitingRole = actorRole === "brand" ? "influencer" : "brand";
    contract.lastSentAt = new Date();
    await addActivity(contract, actorRole, actorRole === "brand" ? "BRAND_EDITED" : "INFLUENCER_EDITED", { editedFields: editedFields.length ? editedFields : changedPaths, byUserId: req.user?.id || "" }, before);
  }

  contract.paymentType = normalizePaymentType(working.content?.campaign?.paymentType);
  contract.feeAmount = Number(working.content?.scheduleA?.commercial?.totalCampaignFee || 0);
  contract.currency = working.content?.scheduleA?.commercial?.currency || "USD";
  contract.brandName = working.content?.brand?.legalName || contract.brandName;
  contract.brandAddress = working.content?.brand?.billingAddress || contract.brandAddress;
  contract.influencerName = working.content?.influencer?.legalName || contract.influencerName;
  contract.influencerAddress = working.content?.influencer?.address || contract.influencerAddress;
  contract.influencerHandle = working.content?.influencer?.postingHandleUrl || contract.influencerHandle;

  await createOrUpdateContent({ contract, content: working.content, other: hydrated.other || {} });
  await contract.save();
  return { contract, changedPaths, editedFields };
}

exports.brandUpdateFields = async (req, res) => {
  try {
    const { brandUpdates = {}, preview = false, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand = "", signatureId = "" } = req.body;
    if (preview) {
      const contract = await findContract(req.body.contractId);
      if (!contract) return respondError(res, "Contract not found", 404);
      const hydrated = await hydrateContract(contract);
      const tmp = JSON.parse(JSON.stringify(hydrated));
      applyAllowedDeepUpdates(tmp, brandUpdates, ALLOWED_BRAND_PATHS);
      const campaignDoc = await Campaign.findById(contract.campaignId);
      if (!campaignDoc) return respondError(res, "Campaign not found", 404);
      if (requestedEffectiveDate) {
        const builtDate = buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || tmp.requestedEffectiveDateTimezone || DEFAULT_TZ);
        tmp.requestedEffectiveDate = builtDate;
        tmp.content.campaign.effectiveDate = builtDate;
      }
      tmp.content = normalizeContractFlowContent(tmp.content, campaignDoc);
      validateContractFlowContent(tmp.content, campaignDoc);
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      return renderPDFWithPuppeteer({ html, res, filename: `Contract-Brand-Preview-${req.body.contractId}.pdf`, headerTitle: CONTRACT_PDF_TITLE, headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || "Pending" });
    }
    const result = await updateContractFields({ req, res, actorRole: "brand", allowedPaths: ALLOWED_BRAND_PATHS, updates: brandUpdates, requestedEffectiveDate, requestedEffectiveDateTimezone });
    if (!result) return;
    const { contract, editedFields, changedPaths } = result;
    const cleanSignatureBrand = String(signatureBrand || "").trim();
    if (cleanSignatureBrand) {
      const hydratedForSignature = await hydrateContract(contract);
      await ContractSignature.upsertSigned({
        contractId: contract.contractId,
        role: "brand",
        byUserId: req.user?.id || "",
        name:
          hydratedForSignature?.content?.brand?.brandPoc ||
          hydratedForSignature?.content?.brand?.contactPersonName ||
          hydratedForSignature?.brandName ||
          "",
        email: hydratedForSignature?.content?.brand?.noticeEmail || "",
        signatureDataUrl: cleanSignatureBrand,
        savedSignatureId: signatureId || hydratedForSignature?.content?.brand?.brandSignature || "",
        ipAddress: req.ip || "",
        userAgent: req.get?.("user-agent") || "",
      });
      await addActivity(contract, "brand", "BRAND_SIGNATURE_UPDATED", {
        savedSignatureId: signatureId || "",
      });
      await contract.save();
    }
    await safeStartReminder(contract, "influencer");
    await safeClearReminder(contract.contractId, "brand");
    return respondOK(res, { message: "Brand fields updated", contract: await hydrateContract(contract), editedFields: editedFields.length ? editedFields : changedPaths });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "BRAND_UPDATE_FIELDS_ERROR");
    return respondError(res, err.message || "brandUpdateFields error", err.status || 500, err);
  }
};

exports.influencerUpdateFields = async (req, res) => {
  try {
    const result = await updateContractFields({ req, res, actorRole: "influencer", allowedPaths: ALLOWED_INFLUENCER_PATHS, updates: req.body.influencerUpdates || {} });
    if (!result) return;
    const { contract, editedFields, changedPaths } = result;
    await safeStartReminder(contract, "brand");
    await safeClearReminder(contract.contractId, "influencer");
    return respondOK(res, { message: "Influencer fields updated", contract: await hydrateContract(contract), editedFields: editedFields.length ? editedFields : changedPaths });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INFLUENCER_UPDATE_FIELDS_ERROR");
    return respondError(res, err.message || "influencerUpdateFields error", err.status || 500, err);
  }
};

exports.getContract = async (req, res) => {
  try {
    const { brandId, influencerId, campaignId } = req.body;
    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);
    const contracts = await Contract.find({ brandId, influencerId, campaignId }).sort({ createdAt: -1 });
    return respondOK(res, { contracts: await hydrateContracts(contracts) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "GET_CONTRACT_ERROR");
    return respondError(res, "Error fetching contracts", 500, err);
  }
};

exports.reject = async (req, res) => {
  try {
    const { contractId, influencerId, reason } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    requireNotLocked(contract);
    if (influencerId && String(influencerId) !== String(contract.influencerId)) return respondError(res, "Forbidden", 403);
    contract.isAccepted = 0;
    contract.isRejected = 1;
    contract.status = CONTRACT_STATUS.REJECTED;
    contract.awaitingRole = null;
    contract.editsLockedAt = null;
    contract.statusFlags.isRejected = true;
    await addActivity(contract, "influencer", "REJECTED", { reason });
    await contract.save();
    await ApplyCampaign.updateOne({ campaignId: String(contract.campaignId), "applicants.influencerId": String(contract.influencerId) }, { $set: { "applicants.$.statusInfluencer": "rejected", "applicants.$.isShortlisted": 0 } });
    await Campaign.updateOne(campaignQuery(contract.campaignId), { $set: { isContracted: 0, contractId: null, isAccepted: 0 } });
    await safeClearReminder(contract.contractId, "brand");
    await safeClearReminder(contract.contractId, "influencer");
    return respondOK(res, { message: "Contract rejected", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "REJECT_ERROR");
    return respondError(res, err.message || "reject error", err.status || 500, err);
  }
};

exports.resend = async (req, res) => {
  try {
    const { contractId, content: contentUpdates = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, preview = false } = req.body;
    assertRequired(req.body, ["contractId"]);
    const parent = await findContract(contractId);
    if (!parent) return respondError(res, "Contract not found", 404);
    if (isLockedContract(parent)) return respondError(res, "Cannot resend a signed/locked contract", 400);
    const parentHydrated = await hydrateContract(parent);
    const campaignDoc = await Campaign.findById(parent.campaignId);
    if (!campaignDoc) return respondError(res, "Campaign not found", 404);

    let mergedContent = mergeDeep(parentHydrated.content || {}, contentUpdates || {});
    if (requestedEffectiveDate) mergedContent.campaign.effectiveDate = buildRequestedEffectiveDate(requestedEffectiveDate, requestedEffectiveDateTimezone || parent.requestedEffectiveDateTimezone || DEFAULT_TZ);
    mergedContent = normalizeContractFlowContent(mergedContent, campaignDoc);
    validateContractFlowContent(mergedContent, campaignDoc);

    if (preview) {
      const tmp = { ...parentHydrated, content: mergedContent, requestedEffectiveDate: mergedContent.campaign.effectiveDate || parent.requestedEffectiveDate };
      const tokens = buildTokenMap(tmp);
      const text = renderTemplate(tmp.admin?.legalTemplateText || MASTER_TEMPLATE, tokens);
      const html = renderContractHTML({ contract: tmp, templateText: text });
      return renderPDFWithPuppeteer({ html, res, filename: `Contract-Resend-Preview-${contractId}.pdf`, headerTitle: CONTRACT_PDF_TITLE, headerDate: tokens["Agreement.EffectiveDateTime"] || tokens["Agreement.EffectiveDateLong"] || "Pending" });
    }

    const child = await createContractRecord({ req, brandId: parent.brandId, influencerId: parent.influencerId, campaignId: parent.campaignId, campaign: campaignDoc, brandDoc: {}, influencerDoc: {}, content: mergedContent, other: parentHydrated.other || {}, admin: parentHydrated.admin || buildAdmin({ campaign: campaignDoc, requestedEffectiveDateTimezone, req }), requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand: "", resendOf: parent.contractId, resendIteration: Number(parent.resendIteration || 0) + 1 });
    parent.supersededBy = child.contractId;
    parent.resentAt = new Date();
    parent.status = CONTRACT_STATUS.SUPERSEDED;
    parent.statusFlags.isSuperseded = true;
    await addActivity(parent, "system", "RESENT", { to: child.contractId, by: req.user?.email || "system" });
    await parent.save();
    await Campaign.updateOne(campaignQuery(parent.campaignId), { $set: { isContracted: 1, contractId: child.contractId, isAccepted: 0 } });
    await safeStartReminder(child, "influencer");
    await safeClearReminder(child.contractId, "brand");
    return respondOK(res, { message: "Resent contract created", contract: await hydrateContract(child) }, 201);
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "RESEND_ERROR");
    return respondError(res, err.message || "resend error", err.status || 500, err);
  }
};

exports.initiateBulk = async (req, res) => {
  try {
    const { brandId, campaignId, influencerIds = [], content: contentInput = {}, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand = "", signatureId = "" } = req.body;
    assertRequired(req.body, ["brandId", "campaignId"]);
    if (!Array.isArray(influencerIds) || !influencerIds.length) return respondError(res, "influencerIds is required", 400);
    const [campaign, brandDoc] = await Promise.all([Campaign.findById(campaignId), Brand.findById(brandId)]);
    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);
    const admin = buildAdmin({ campaign, requestedEffectiveDateTimezone, req });
    const results = await Promise.allSettled(influencerIds.map(async (influencerId) => {
      const [influencerDoc, modashDoc] = await Promise.all([Influencer.findById(influencerId), Modash.findOne({ influencerId: String(influencerId) })]);
      if (!influencerDoc) throw new Error(`Influencer not found: ${influencerId}`);
      const resolvedHandle = modashDoc?.handle || modashDoc?.username || modashDoc?.instagramHandle || modashDoc?.instagram?.username || influencerDoc?.handle || influencerDoc?.profileUrl || "";
      const safeContentInput = JSON.parse(JSON.stringify(contentInput || {}));
      delete safeContentInput.influencer;
      if (safeContentInput?.scheduleA?.deliverables) safeContentInput.scheduleA.deliverables = safeContentInput.scheduleA.deliverables.map((row, index) => ({ ...row, srNo: Number(row?.srNo ?? index + 1), platformHandle: resolvedHandle || row?.platformHandle || "" }));
      const content = createDefaultContent({ campaign, brandDoc, influencerDoc: { ...(influencerDoc.toObject ? influencerDoc.toObject() : influencerDoc), handle: resolvedHandle }, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, contentInput: safeContentInput });
      content.influencer.postingHandleUrl = resolvedHandle;
      validateContractFlowContent(content, campaign);
      const other = buildOtherProfile({ brandDoc, influencerDoc, resolvedHandle });
      const contract = await createContractRecord({ req, brandId, influencerId, campaignId, campaign, brandDoc, influencerDoc, content, other, admin, requestedEffectiveDate, requestedEffectiveDateTimezone, signatureBrand, signatureId });
      await syncApplyCampaignAfterSend(contract, false);
      return await hydrateContract(contract);
    }));
    const created = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const failed = results.filter((r) => r.status === "rejected").map((r) => r.reason?.message || "Unknown error");
    await Campaign.updateOne(campaignQuery(campaignId), { $set: { isContracted: created.length ? 1 : 0 } });
    return respondOK(res, { message: "Bulk initiate completed", created, failed }, created.length ? 201 : 400);
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "INITIATE_BULK_ERROR");
    return respondError(res, err.message || "initiateBulk error", err.status || 500, err);
  }
};

exports.listTimezones = async (_req, res) => respondOK(res, { timezones: loadTimezones() });
exports.getTimezone = async (req, res) => {
  const tz = findTimezoneByValueOrUTC(req.params?.key || req.query?.key || req.body?.key);
  return tz ? respondOK(res, { timezone: tz }) : respondError(res, "Timezone not found", 404);
};
exports.listCurrencies = async (_req, res) => respondOK(res, { currencies: loadCurrencies() });
exports.getCurrency = async (req, res) => {
  const key = String(req.params?.key || req.query?.key || req.body?.key || "").toUpperCase();
  const currencies = loadCurrencies();
  const currency = currencies[key] || (Array.isArray(currencies) ? currencies.find((c) => String(c.code || c.value || "").toUpperCase() === key) : null);
  return currency ? respondOK(res, { currency }) : respondError(res, "Currency not found", 404);
};

async function uploadSavedSignature({ req, res, role }) {
  const ownerField = role === "brand" ? "brandId" : "influencerId";
  const Model = role === "brand" ? BrandSignature : InfluencerSignature;
  const ownerId = req.body[ownerField];
  let signature = String(req.body.signature || req.body.signatureDataUrl || "").trim();
  if (!signature && req.file?.buffer) {
    const mime = req.file.mimetype || "image/png";
    signature = `data:${mime};base64,${req.file.buffer.toString("base64")}`;
  }
  assertRequired({ [ownerField]: ownerId, signature }, [ownerField, "signature"]);
  await Model.deactivateForOwner(ownerId);
  const row = await Model.create({ [ownerField]: ownerId, signature, originalName: req.body.originalName || "", createdBy: req.user?.id || "", updatedBy: req.user?.id || "" });
  return respondOK(res, { message: `${role} signature saved`, signature: row }, 201);
}

exports.uploadBrandSignature = async (req, res) => {
  try { return await uploadSavedSignature({ req, res, role: "brand" }); }
  catch (err) { await saveErrorLog(req, err, err?.status || 500, "UPLOAD_BRAND_SIGNATURE_ERROR"); return respondError(res, err.message, err.status || 500, err); }
};
exports.getBrandSignature = async (req, res) => {
  try {
    const brandId = req.params?.brandId || req.query?.brandId || req.body?.brandId;
    assertRequired({ brandId }, ["brandId"]);
    const signature = await BrandSignature.findActive(brandId);
    if (!signature) return respondError(res, "Active brand signature not found", 404);
    return respondOK(res, signature.toObject ? signature.toObject() : signature);
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_BRAND_SIGNATURE_ERROR"); return respondError(res, err.message, err.status || 500, err); }
};
exports.uploadInfluencerSignature = async (req, res) => {
  try { return await uploadSavedSignature({ req, res, role: "influencer" }); }
  catch (err) { await saveErrorLog(req, err, err?.status || 500, "UPLOAD_INFLUENCER_SIGNATURE_ERROR"); return respondError(res, err.message, err.status || 500, err); }
};
exports.getInfluencerSignature = async (req, res) => {
  try {
    const influencerId = req.params?.influencerId || req.query?.influencerId || req.body?.influencerId;
    assertRequired({ influencerId }, ["influencerId"]);
    const signature = await InfluencerSignature.findActive(influencerId);
    if (!signature) return respondError(res, "Active influencer signature not found", 404);
    return respondOK(res, signature.toObject ? signature.toObject() : signature);
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_INFLUENCER_SIGNATURE_ERROR"); return respondError(res, err.message, err.status || 500, err); }
};

exports.viewContractPdf = async (req, res) => {
  try {
    const { contractId } = req.body;
    assertRequired(req.body, ["contractId"]);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    return renderHydratedContractPdf({ contract, res, filename: `Contract-${contract.contractId}.pdf` });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "VIEW_CONTRACT_PDF_ERROR");
    return respondError(res, err.message || "viewContractPdf error", err.status || 500, err);
  }
};

async function getLatestContractByInfluencerAndCampaign(req) {
  const influencerId = req.params?.influencerId || req.query?.influencerId || req.body?.influencerId;
  const campaignId = req.params?.campaignId || req.query?.campaignId || req.body?.campaignId;
  assertRequired({ influencerId, campaignId }, ["influencerId", "campaignId"]);
  return Contract.findOne({ influencerId: String(influencerId), campaignId: String(campaignId) }).sort({ createdAt: -1 });
}

exports.getDeliverablesByInfluencerAndCampaign = async (req, res) => {
  try {
    const contract = await getLatestContractByInfluencerAndCampaign(req);
    if (!contract) return respondError(res, "Contract not found", 404);
    const hydrated = await hydrateContract(contract);
    return respondOK(res, { deliverables: hydrated.content?.scheduleA?.deliverables || [], contract: hydrated });
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_DELIVERABLES_ERROR"); return respondError(res, err.message || "Error fetching deliverables", err.status || 500, err); }
};

exports.getMilestonesByInfluencerAndCampaign = async (req, res) => {
  try {
    const contract = await getLatestContractByInfluencerAndCampaign(req);
    if (!contract) return respondError(res, "Contract not found", 404);
    const hydrated = await hydrateContract(contract);
    return respondOK(res, { milestones: hydrated.content?.scheduleA?.commercial?.milestones || [], contract: hydrated });
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_MILESTONES_ERROR"); return respondError(res, err.message || "Error fetching milestones", err.status || 500, err); }
};

exports.getScheduleADataByInfluencerAndCampaign = async (req, res) => {
  try {
    const contract = await getLatestContractByInfluencerAndCampaign(req);
    if (!contract) return respondError(res, "Contract not found", 404);
    const hydrated = await hydrateContract(contract);
    return respondOK(res, { scheduleA: hydrated.content?.scheduleA || {}, contract: hydrated });
  } catch (err) { await saveErrorLog(req, err, err?.status || 500, "GET_SCHEDULE_A_ERROR"); return respondError(res, err.message || "Error fetching Schedule A", err.status || 500, err); }
};

exports.influencerManage = async (req, res) => {
  try {
    const { contractId } = req.params;
    if (!contractId) return respondError(res, "contractId is required", 400);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    const modashData = await Modash.findOne({ influencerId: contract.influencerId });
    if (!modashData) return respondError(res, "Matching influencer not found in Modash", 404);
    return respondOK(res, { message: "Influencer data fetched successfully", contract: await hydrateContract(contract), modashData });
  } catch (error) {
    await saveErrorLog(req, error, error?.status || error?.statusCode || 500, "INFLUENCER_MANAGE_ERROR");
    return respondError(res, "Failed to fetch influencer data", 500, error);
  }
};

exports.getContractDetails = async (req, res) => {
  try {
    const contractId = req.params.contractId || req.query.contractId || req.body.contractId;
    if (!contractId) return respondError(res, "contractId is required", 400);
    const contract = await findContract(contractId);
    if (!contract) return respondError(res, "Contract not found", 404);
    return respondOK(res, { message: "Contract details fetched successfully", contract: await hydrateContract(contract) });
  } catch (err) {
    await saveErrorLog(req, err, err?.status || err?.statusCode || 500, "GET_CONTRACT_DETAILS_ERROR");
    return respondError(res, "Error fetching contract details", 500, err);
  }
};

exports.getOwnContractUploadUrl = async (req, res) => {
  try {
    const {
      brandId,
      influencerId,
      campaignId,
      fileName,
      contentType,
      sizeBytes,
    } = req.body;

    assertRequired(req.body, [
      "brandId",
      "influencerId",
      "campaignId",
      "fileName",
      "contentType",
      "sizeBytes",
    ]);

    if (!mongoose.Types.ObjectId.isValid(campaignId)) {
      return respondError(res, "Invalid campaignId", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return respondError(res, "Invalid brandId", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(influencerId)) {
      return respondError(res, "Invalid influencerId", 400);
    }

    const [campaign, brandDoc, influencerDoc] = await Promise.all([
      Campaign.findById(campaignId).select("_id").lean(),
      Brand.findById(brandId).select("_id").lean(),
      Influencer.findById(influencerId).select("_id").lean(),
    ]);

    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);
    if (!influencerDoc) return respondError(res, "Influencer not found", 404);

    const upload = await createContractUploadUrl({
      brandId,
      influencerId,
      campaignId,
      fileName,
      contentType,
      sizeBytes,
    });

    return respondOK(res, {
      message: "Contract upload URL created",
      upload,
    });
  } catch (err) {
    await saveErrorLog(
      req,
      err,
      err?.status || err?.statusCode || 500,
      "OWN_CONTRACT_UPLOAD_URL_ERROR"
    );

    return respondError(
      res,
      err.message || "Could not create contract upload URL",
      err.status || 500,
      err
    );
  }
};

exports.sendUploadedOwnContract = async (req, res) => {
  let uploadedKey = "";
  let shouldDeleteUploadedObject = true;

  try {
    const {
      brandId,
      influencerId,
      campaignId,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      uploadedContract,
      isResend = false,
      resendOf = "",
    } = req.body;

    assertRequired(req.body, ["brandId", "influencerId", "campaignId"]);

    assertRequired(uploadedContract || {}, [
      "key",
      "bucket",
      "originalName",
      "mimeType",
      "sizeBytes",
    ]);

    uploadedKey = uploadedContract.key;

    if (!mongoose.Types.ObjectId.isValid(campaignId)) {
      return respondError(res, "Invalid campaignId", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(brandId)) {
      return respondError(res, "Invalid brandId", 400);
    }

    if (!mongoose.Types.ObjectId.isValid(influencerId)) {
      return respondError(res, "Invalid influencerId", 400);
    }

    if (uploadedContract.bucket !== CONTRACT_BUCKET) {
      return respondError(res, "Invalid contract S3 bucket.", 400);
    }

    const expectedKeyPrefix = getExpectedContractKeyPrefix({
      brandId,
      campaignId,
      influencerId,
    });

    if (!String(uploadedContract.key || "").startsWith(expectedKeyPrefix)) {
      return respondError(res, "Invalid contract S3 key.", 400);
    }

    assertPdfUpload({
      fileName: uploadedContract.originalName,
      contentType: uploadedContract.mimeType,
      sizeBytes: uploadedContract.sizeBytes,
    });

    const [campaign, brandDoc, influencerDoc] = await Promise.all([
      Campaign.findById(campaignId),
      Brand.findById(brandId),
      Influencer.findById(influencerId),
    ]);

    if (!campaign) return respondError(res, "Campaign not found", 404);
    if (!brandDoc) return respondError(res, "Brand not found", 404);
    if (!influencerDoc) return respondError(res, "Influencer not found", 404);

    const admin = buildAdmin({
      campaign,
      requestedEffectiveDateTimezone,
      req,
    });

    const other = buildOtherProfile({
      brandDoc,
      influencerDoc,
    });

    const content = createDefaultContent({
      campaign,
      brandDoc,
      influencerDoc,
      admin,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      contentInput: {},
    });

    let parent = null;

    if (isResend && resendOf) {
      parent = await Contract.findOne({ contractId: resendOf });

      if (!parent) {
        return respondError(res, "resendOf contract not found", 404);
      }

      if (
        String(parent.brandId) !== String(brandId) ||
        String(parent.influencerId) !== String(influencerId) ||
        String(parent.campaignId) !== String(campaignId)
      ) {
        return respondError(
          res,
          "resendOf must belong to the same brand, influencer, and campaign",
          400
        );
      }

      if (isLockedContract(parent)) {
        return respondError(res, "Cannot resend a signed/locked contract", 400);
      }
    }

    const contract = await createContractRecord({
      req,
      brandId,
      influencerId,
      campaignId,
      campaign,
      brandDoc,
      influencerDoc,
      content,
      other,
      admin,
      requestedEffectiveDate,
      requestedEffectiveDateTimezone,
      signatureBrand: "",
      signatureId: "",
      resendOf: parent?.contractId || null,
      resendIteration: parent ? Number(parent.resendIteration || 0) + 1 : 0,
    });

    contract.contractSource = "uploaded";
    contract.status = CONTRACT_STATUS.BRAND_SENT_DRAFT;
    contract.awaitingRole = "influencer";
    contract.lastSentAt = new Date();
    await contract.save();

    await ContractDocument.findOneAndUpdate(
      { contractId: contract.contractId },
      {
        $set: {
          documentSource: "uploaded",
          pdfUrl: "",
          uploadedContract: {
            originalName: uploadedContract.originalName,
            bucket: CONTRACT_BUCKET,
            folder: CONTRACT_FOLDER,
            key: uploadedContract.key,
            mimeType: "application/pdf",
            sizeBytes: Number(uploadedContract.sizeBytes || 0),
            uploadedBy:
              req.user?.id ||
              req.user?._id ||
              req.user?.email ||
              String(brandId),
            uploadedAt: new Date(),
          },
          acknowledgement: {
            version: 1,
            title: "CollabGlam Uploaded Contract Acknowledgement",
            text: UPLOADED_CONTRACT_ACKNOWLEDGEMENT,
            appliesToUploadedContract: true,
          },
        },
      },
      { upsert: true, new: true }
    );

    shouldDeleteUploadedObject = false;

    if (parent) {
      parent.supersededBy = contract.contractId;
      parent.resentAt = new Date();
      parent.status = CONTRACT_STATUS.SUPERSEDED;
      parent.statusFlags = parent.statusFlags || {};
      parent.statusFlags.isSuperseded = true;

      await addActivity(parent, "system", "RESENT", {
        to: contract.contractId,
        by: req.user?.email || "system",
      });

      await parent.save();
    }

    await addActivity(contract, "brand", "UPLOADED_OWN_CONTRACT", {
      bucket: CONTRACT_BUCKET,
      folder: CONTRACT_FOLDER,
      key: uploadedContract.key,
      originalName: uploadedContract.originalName,
      sizeBytes: uploadedContract.sizeBytes,
      mimeType: uploadedContract.mimeType,
      acknowledgementVersion: 1,
    });

    await syncApplyCampaignAfterSend(contract, true);
    await syncApplyCampaignAfterSend(contract, false);

    await Campaign.updateOne(campaignQuery(campaignId), {
      $set: {
        isContracted: 1,
        contractId: contract.contractId,
        isAccepted: 0,
      },
    });

    await createAndEmit({
      recipientType: "influencer",
      influencerId: String(influencerId),
      type: "contract.initiated",
      title: `Contract initiated by ${brandDoc.name || "Brand"}`,
      message: `Brand uploaded a contract for "${
        campaign.productOrServiceName || campaign.campaignTitle || "Campaign"
      }". Please review the uploaded contract and CollabGlam acknowledgement.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: "/influencer/my-campaign",
      meta: { campaignId, brandId, influencerId },
    });

    await createAndEmit({
      recipientType: "brand",
      brandId: String(brandId),
      type: "contract.initiated.self",
      title: parent ? "Contract resent" : "Contract uploaded",
      message: `You uploaded and sent a contract to ${
        influencerDoc.name || "Influencer"
      }.`,
      entityType: "contract",
      entityId: String(contract.contractId),
      actionPath: `/brand/created-campaign/applied-inf?id=${campaignId}`,
      meta: { campaignId, influencerId },
    });

    const hydrated = await hydrateContract(contract);

    await safeSendEmail({
      contract: hydrated,
      templateKey: "contract_new_received_influencer",
      to: getEmailForRole({
        contract: hydrated,
        role: "influencer",
        influencerDoc,
      }),
      recipientRole: "influencer",
      recipientName: getNameForRole({
        contract: hydrated,
        role: "influencer",
        influencerDoc,
      }),
    });

    await safeStartReminder(contract, "influencer");
    await safeClearReminder(contract.contractId, "brand");

    return respondOK(
      res,
      {
        message: parent
          ? "Uploaded contract resent successfully"
          : "Uploaded contract sent successfully",
        contract: hydrated,
      },
      201
    );
  } catch (err) {
    if (shouldDeleteUploadedObject && uploadedKey) {
      await deleteContractFile(uploadedKey).catch(() => null);
    }

    await saveErrorLog(
      req,
      err,
      err?.status || err?.statusCode || 500,
      "SEND_UPLOADED_OWN_CONTRACT_ERROR"
    );

    return respondError(
      res,
      err.message || "send uploaded own contract error",
      err.status || 500,
      err
    );
  }
};