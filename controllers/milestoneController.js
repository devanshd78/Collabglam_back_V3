const mongoose = require("mongoose");

const Milestone = require("../models/milestone");
const Campaign = require("../models/campaign");
const Brand = require("../models/brand");
const { InfluencerModel: Influencer } = require("../models/influencer");
const Contract = require("../models/contract");
const ContractSignature = require("../models/contractSignature");
const { BrandWalletModel } = require("../models/brandWallet");

const { createAndEmit } = require("../utils/notifier");
const saveErrorLog = require("../services/errorLog.service");
const { CONTRACT_STATUS } = require("../constants/contract");

const {
  sendMilestoneCreatedEmail,
  sendMilestoneReleasedEmail,
  sendMilestonePaidEmail,
} = require("../emails/milestonetemplet");

const APP_BASE_URL = process.env.APP_BASE_URL || "";

// ---------------- wallet helpers ----------------

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

const syncUsableBalance = (wallet) => {
  wallet.walletBalance = Math.max(0, roundMoney(wallet.walletBalance));
  wallet.escrowBalance = Math.max(
    0,
    roundMoney(wallet.escrowBalance ?? wallet.frozenBalance ?? 0)
  );

  // frozenBalance is kept as a backward-compatible alias for escrowBalance.
  wallet.frozenBalance = wallet.escrowBalance;

  // In the single-wallet model, usable balance is the available walletBalance.
  wallet.usableBalance = wallet.walletBalance;

  return {
    walletBalance: wallet.walletBalance,
    escrowBalance: wallet.escrowBalance,
    frozenBalance: wallet.frozenBalance,
    usableBalance: wallet.usableBalance,
  };
};

const addEscrowHistory = (wallet, payload = {}) => {
  wallet.escrowHistories = Array.isArray(wallet.escrowHistories)
    ? wallet.escrowHistories
    : [];

  wallet.escrowHistories.push({
    brandId: String(payload.brandId || wallet.brandId || ""),
    type: String(payload.type || "milestone_escrow"),
    amount: roundMoney(payload.amount),
    currency: String(payload.currency || "usd").toLowerCase(),
    campaignId: String(payload.campaignId || ""),
    influencerId: String(payload.influencerId || ""),
    contractId: String(payload.contractId || ""),
    milestoneId: String(payload.milestoneId || ""),
    milestoneHistoryId: String(payload.milestoneHistoryId || ""),
    milestoneTitle: String(payload.milestoneTitle || ""),
    walletBalanceBefore: roundMoney(payload.walletBalanceBefore),
    walletBalanceAfter: roundMoney(payload.walletBalanceAfter),
    escrowBalanceBefore: roundMoney(payload.escrowBalanceBefore),
    escrowBalanceAfter: roundMoney(payload.escrowBalanceAfter),
    note: String(payload.note || ""),
    createdAt: new Date(),
  });

  wallet.markModified("escrowHistories");
};

const moveAmountToEscrow = (wallet, payload = {}) => {
  const amount = roundMoney(payload.amount);
  const before = syncUsableBalance(wallet);

  if (!amount || amount <= 0) {
    const err = new Error("amount must be > 0");
    err.status = 400;
    throw err;
  }

  if (before.walletBalance < amount) {
    const err = new Error(
      "Insufficient brand wallet balance. Please top up the remaining amount."
    );
    err.status = 402;
    err.extra = {
      walletBalance: before.walletBalance,
      escrowBalance: before.escrowBalance,
      frozenBalance: before.frozenBalance,
      usableBalance: before.usableBalance,
      requiredAmount: amount,
      needToAdd: roundMoney(amount - before.walletBalance),
    };
    throw err;
  }

  wallet.walletBalance = roundMoney(before.walletBalance - amount);
  wallet.escrowBalance = roundMoney(before.escrowBalance + amount);
  wallet.frozenBalance = wallet.escrowBalance;
  wallet.usableBalance = wallet.walletBalance;

  const after = syncUsableBalance(wallet);

  addEscrowHistory(wallet, {
    ...payload,
    type: payload.type || "milestone_escrow",
    amount,
    walletBalanceBefore: before.walletBalance,
    walletBalanceAfter: after.walletBalance,
    escrowBalanceBefore: before.escrowBalance,
    escrowBalanceAfter: after.escrowBalance,
  });

  return after;
};

const refundAmountFromEscrow = (wallet, payload = {}) => {
  const amount = roundMoney(payload.amount);
  const before = syncUsableBalance(wallet);
  const refundAmount = Math.min(amount, before.escrowBalance);

  if (!refundAmount || refundAmount <= 0) return before;

  wallet.walletBalance = roundMoney(before.walletBalance + refundAmount);
  wallet.escrowBalance = roundMoney(before.escrowBalance - refundAmount);
  wallet.frozenBalance = wallet.escrowBalance;
  wallet.usableBalance = wallet.walletBalance;

  const after = syncUsableBalance(wallet);

  addEscrowHistory(wallet, {
    ...payload,
    type: payload.type || "milestone_escrow_refund",
    amount: refundAmount,
    walletBalanceBefore: before.walletBalance,
    walletBalanceAfter: after.walletBalance,
    escrowBalanceBefore: before.escrowBalance,
    escrowBalanceAfter: after.escrowBalance,
  });

  return after;
};

const releaseAmountFromEscrow = (wallet, payload = {}) => {
  const amount = roundMoney(payload.amount);
  const before = syncUsableBalance(wallet);

  if (!amount || amount <= 0) {
    const err = new Error("amount must be > 0");
    err.status = 400;
    throw err;
  }

  if (before.escrowBalance < amount) {
    const err = new Error("Escrow balance is less than milestone amount.");
    err.status = 400;
    err.extra = {
      escrowBalance: before.escrowBalance,
      frozenBalance: before.frozenBalance,
      releaseAmount: amount,
    };
    throw err;
  }

  wallet.escrowBalance = roundMoney(before.escrowBalance - amount);
  wallet.frozenBalance = wallet.escrowBalance;
  wallet.usableBalance = wallet.walletBalance;

  const after = syncUsableBalance(wallet);

  addEscrowHistory(wallet, {
    ...payload,
    type: "milestone_release",
    amount,
    walletBalanceBefore: before.walletBalance,
    walletBalanceAfter: after.walletBalance,
    escrowBalanceBefore: before.escrowBalance,
    escrowBalanceAfter: after.escrowBalance,
  });

  return after;
};

const getOrCreateBrandWallet = async (brandId, session = null) => {
  let query = BrandWalletModel.findOne({ brandId });
  if (session) query = query.session(session);

  let wallet = await query;

  if (!wallet) {
    wallet = new BrandWalletModel({
      brandId,
      walletBalance: 0,
      escrowBalance: 0,
      frozenBalance: 0,
      usableBalance: 0,
      topups: [],
      escrowHistories: [],
      withdrawHistories: [],
      freezes: [],
    });
  }

  syncUsableBalance(wallet);

  if (session) {
    await wallet.save({ session });
  } else {
    await wallet.save();
  }

  return wallet;
};

const normalizeDeliverableLinks = (input = []) => {
  const list = Array.isArray(input) ? input : input ? [input] : [];

  return list
    .map((item, index) => {
      if (typeof item === "string") {
        return {
          label: "",
          url: String(item || "").trim(),
        };
      }

      return {
        label: String(item?.label || item?.name || `Link ${index + 1}`).trim(),
        url: String(item?.url || item?.link || "").trim(),
      };
    })
    .filter((item) => item.url);
};

const getWalletSnapshotByBrandId = async (brandId) => {
  const wallet = await BrandWalletModel.findOne({ brandId });

  if (!wallet) {
    return {
      walletBalance: 0,
      escrowBalance: 0,
      frozenBalance: 0,
      usableBalance: 0,
      escrowHistories: [],
    };
  }

  const snap = syncUsableBalance(wallet);
  await wallet.save();

  return {
    walletBalance: snap.walletBalance,
    escrowBalance: snap.escrowBalance,
    frozenBalance: snap.frozenBalance,
    usableBalance: snap.usableBalance,
    escrowHistories: wallet.escrowHistories || [],
  };
};

const calcFrozenAll = (_freezes = []) => 0;
const syncCampaignFreeze = (freeze) => freeze || null;

const clean = (value) => String(value || "").trim();

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
};

const toDateOrNull = (value) => {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return date;
};

const boolValue = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  }
  return false;
};

const isOid = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

const sameId = (a, b) => {
  if (!a || !b) return false;
  return String(a) === String(b);
};

const idVariants = (value) => {
  const raw = clean(value);

  if (!raw) return [];

  const values = [raw];

  if (isOid(raw)) {
    values.push(toObjectId(raw));
  }

  return values;
};

const getFirstPositiveNumber = (...values) => {
  for (const value of values) {
    const num = Number(value);

    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return 0;
};

const isSigned = (value) => {
  if (typeof value === "boolean") return value;
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
};

const isContractStatusSigned = (status) => {
  const normalized = String(status || "").trim().toUpperCase();

  return [
    String(CONTRACT_STATUS.CONTRACT_SIGNED || "").toUpperCase(),
    String(CONTRACT_STATUS.MILESTONES_CREATED || "").toUpperCase(),
    "CONTRACT_SIGNED",
    "MILESTONES_CREATED",
    "SIGNED",
    "LOCKED",
  ].includes(normalized);
};

const isRoleSignedOnContract = (contractDoc = {}, role) => {
  const legacyKey = role === "brand" ? "signatureBrand" : "signatureInfluencer";
  const roleSignature = contractDoc.signatures?.[role] || {};

  return Boolean(
    isSigned(contractDoc?.[legacyKey]) ||
      roleSignature.signed === true ||
      roleSignature.signed === 1 ||
      roleSignature.at
  );
};

const isContractFullySignedForMilestone = async (contractDoc = {}) => {
  if (!contractDoc) return false;

  if (contractDoc.lockedAt || isContractStatusSigned(contractDoc.status)) {
    return true;
  }

  const brandSignedOnContract = isRoleSignedOnContract(contractDoc, "brand");
  const influencerSignedOnContract = isRoleSignedOnContract(contractDoc, "influencer");

  if (brandSignedOnContract && influencerSignedOnContract) {
    return true;
  }

  const contractId = String(contractDoc.contractId || contractDoc._id || "").trim();
  if (!contractId) return false;

  const signedRows = await ContractSignature.find({
    contractId,
    role: { $in: ["brand", "influencer"] },
    signed: true,
  })
    .select("role signed")
    .lean();

  const signedRoles = new Set((signedRows || []).map((row) => String(row.role || "").toLowerCase()));

  return signedRoles.has("brand") && signedRoles.has("influencer");
};

const getContractSourceType = (contractDoc = {}) => {
  const rawSource = clean(
    contractDoc?.contractSource ||
      contractDoc?.documentSource ||
      contractDoc?.document?.documentSource ||
      contractDoc?.contractDocument?.documentSource ||
      contractDoc?.document?.uploadedContract?.documentSource ||
      contractDoc?.contractDocument?.uploadedContract?.documentSource ||
      contractDoc?.uploadedContract?.documentSource ||
      ""
  ).toLowerCase();

  const uploadedMarkers = [
    contractDoc?.uploadedContract,
    contractDoc?.documentUploadedContract,
    contractDoc?.signedUploadedContract,
    contractDoc?.document?.uploadedContract,
    contractDoc?.document?.signedUploadedContract,
    contractDoc?.contractDocument?.uploadedContract,
    contractDoc?.contractDocument?.signedUploadedContract,
  ];

  const hasUploadedFile = uploadedMarkers.some((item) => {
    if (!item) return false;
    if (typeof item === "string") return Boolean(clean(item));
    if (typeof item === "object") {
      return Boolean(
        clean(
          item.key ||
            item.url ||
            item.originalName ||
            item.fileName ||
            item.name ||
            item.path
        )
      );
    }
    return false;
  });

  if (
    ["uploaded", "own", "brand_uploaded", "uploaded_contract"].includes(
      rawSource
    ) ||
    hasUploadedFile
  ) {
    return "uploaded";
  }

  return "template";
};

const isUploadedContractSource = (contractDoc = {}) =>
  getContractSourceType(contractDoc) === "uploaded";

const normalizeAttachments = (input = []) => {
  return toArray(input)
    .map((item) => {
      if (typeof item === "string") {
        return {
          name: "",
          url: clean(item),
          type: "",
          size: 0,
          key: "",
        };
      }

      return {
        name: clean(item?.name || item?.fileName || item?.label),
        url: clean(item?.url || item?.link || item?.path),
        type: clean(item?.type || item?.mimeType),
        size: Number(item?.size || 0),
        key: clean(item?.key),
      };
    })
    .filter((item) => item.url || item.name);
};

const normalizeDeliverables = (input = [], bodyDeliverableLink = "") => {
  return toArray(input)
    .map((item) => {
      const deliverableName = clean(
        item?.deliverableName ||
          item?.name ||
          item?.title ||
          item?.deliverableTitle ||
          item?.deliverableFormat
      );

      const deliveries = toArray(
        item?.deliveries ||
          item?.delivery ||
          item?.deliveryTypes ||
          item?.contentFormats ||
          item?.deliverableFormat
      )
        .map(clean)
        .filter(Boolean);

      const platforms = toArray(
        item?.platforms || item?.platform || item?.contentPlatforms || item?.platformHandle
      )
        .map(clean)
        .filter(Boolean);

      const quantityNum = Number(
        item?.quantity || item?.qty || item?.count || 1
      );

      const draftRequired = boolValue(
        item?.draftRequired || item?.needDraftFirst || item?.requiresDraft
      );

      const preShootScriptRequired = boolValue(item?.preShootScriptRequired);

      return {
        deliverableName,
        deliveries,
        aspectRatio: clean(item?.aspectRatio || item?.ratio),
        platforms,
        quantity:
          Number.isFinite(quantityNum) && quantityNum > 0 ? quantityNum : 1,

        deliverableLinks: normalizeDeliverableLinks(
          item?.deliverableLinks ||
            item?.submissionLinks ||
            item?.deliverableLink ||
            item?.link ||
            item?.url ||
            bodyDeliverableLink ||
            []
        ),
        submissionName: clean(item?.submissionName),
        submissionNotes: clean(item?.submissionNotes || item?.additionalNotes || item?.notes),
        additionalNotes: clean(item?.additionalNotes || item?.submissionNotes || item?.notes),
        submittedAt: item?.submittedAt || null,
        submittedByInfluencerId: clean(item?.submittedByInfluencerId),

        draftRequired,
        needDraftFirst: draftRequired,
        requiresDraft: draftRequired,
        draftDue: toDateOrNull(item?.draftDue || item?.draftDate),
        draftDate: toDateOrNull(item?.draftDate || item?.draftDue),
        draftLinks: normalizeDeliverableLinks(
          item?.draftLinks || item?.draftUrl || item?.draftLink || []
        ),
        draftNotes: clean(item?.draftNotes),
        draftSubmittedAt: item?.draftSubmittedAt || null,

        preShootScriptRequired,
        preShootScriptDue: toDateOrNull(item?.preShootScriptDue),
        preShootScriptLinks: normalizeDeliverableLinks(
          item?.preShootScriptLinks || item?.preShootScriptUrl || item?.preShootScriptLink || []
        ),

        contentSpecification: clean(item?.contentSpecification || item?.specification),
        liveDate: toDateOrNull(item?.liveDate),

        status: clean(item?.status) || "pending",
        comments: clean(item?.comments),
        approvedRole: clean(item?.approvedRole),
        approvalId: clean(item?.approvalId),
        approvedAt: item?.approvedAt || null,
        revisionRequestedAt: item?.revisionRequestedAt || null,
        revisions: Array.isArray(item?.revisions) ? item.revisions : [],
      };
    })
    .filter((item) => item.deliverableName);
};

exports.createMilestone = async (req, res) => {
  const session = await mongoose.startSession();

  const abort = (status, message, extra = {}) => {
    const err = new Error(message);
    err.status = status;
    err.extra = extra;
    throw err;
  };

  const clean = (value) => String(value || "").trim();

  const toArray = (value) => {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === "") return [];
    return [value];
  };

  const toDateOrNull = (value) => {
    if (!value) return null;

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return null;

    return date;
  };

  const boolValue = (value) => {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value === 1;

    if (typeof value === "string") {
      return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
    }

    return false;
  };

  const isSigned = (value) => {
    if (typeof value === "boolean") return value;
    if (value == null) return false;
    if (typeof value === "string") return value.trim() !== "";
    return true;
  };

  const isOid = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));

  const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

  const sameId = (a, b) => {
    if (!a || !b) return false;
    return String(a) === String(b);
  };

  const idVariants = (value) => {
    const raw = clean(value);

    if (!raw) return [];

    const values = [raw];

    if (isOid(raw)) {
      values.push(toObjectId(raw));
    }

    return values;
  };

  const getFirstPositiveNumber = (...values) => {
    for (const value of values) {
      const num = Number(value);

      if (Number.isFinite(num) && num > 0) {
        return num;
      }
    }

    return 0;
  };

  const normalizeAttachments = (input = []) => {
    return toArray(input)
      .map((item) => {
        if (typeof item === "string") {
          return {
            name: "",
            url: clean(item),
            type: "",
            size: 0,
            key: "",
          };
        }

        return {
          name: clean(item?.name || item?.fileName || item?.label),
          url: clean(item?.url || item?.link || item?.path),
          type: clean(item?.type || item?.mimeType),
          size: Number(item?.size || 0),
          key: clean(item?.key),
        };
      })
      .filter((item) => item.url || item.name);
  };

  const normalizeDeliverableLinks = (input = []) => {
    return toArray(input)
      .map((item, index) => {
        if (typeof item === "string") {
          return {
            label: `Deliverable Link ${index + 1}`,
            url: clean(item),
          };
        }

        return {
          label: clean(item?.label || `Deliverable Link ${index + 1}`),
          url: clean(item?.url || item?.link || item?.href),
        };
      })
      .filter((item) => item.url);
  };

  const normalizeDeliverables = (input = [], bodyDeliverableLink = "") => {
  return toArray(input)
    .map((item) => {
      const deliverableName = clean(
        item?.deliverableName ||
          item?.name ||
          item?.title ||
          item?.deliverableTitle ||
          item?.deliverableFormat
      );

      const deliveries = toArray(
        item?.deliveries ||
          item?.delivery ||
          item?.deliveryTypes ||
          item?.contentFormats ||
          item?.deliverableFormat
      )
        .map(clean)
        .filter(Boolean);

      const platforms = toArray(
        item?.platforms || item?.platform || item?.contentPlatforms || item?.platformHandle
      )
        .map(clean)
        .filter(Boolean);

      const quantityNum = Number(
        item?.quantity || item?.qty || item?.count || 1
      );

      const draftRequired = boolValue(
        item?.draftRequired || item?.needDraftFirst || item?.requiresDraft
      );

      const preShootScriptRequired = boolValue(item?.preShootScriptRequired);

      return {
        deliverableName,
        deliveries,
        aspectRatio: clean(item?.aspectRatio || item?.ratio),
        platforms,
        quantity:
          Number.isFinite(quantityNum) && quantityNum > 0 ? quantityNum : 1,

        deliverableLinks: normalizeDeliverableLinks(
          item?.deliverableLinks ||
            item?.submissionLinks ||
            item?.deliverableLink ||
            item?.link ||
            item?.url ||
            bodyDeliverableLink ||
            []
        ),
        submissionName: clean(item?.submissionName),
        submissionNotes: clean(item?.submissionNotes || item?.additionalNotes || item?.notes),
        additionalNotes: clean(item?.additionalNotes || item?.submissionNotes || item?.notes),
        submittedAt: item?.submittedAt || null,
        submittedByInfluencerId: clean(item?.submittedByInfluencerId),

        draftRequired,
        needDraftFirst: draftRequired,
        requiresDraft: draftRequired,
        draftDue: toDateOrNull(item?.draftDue || item?.draftDate),
        draftDate: toDateOrNull(item?.draftDate || item?.draftDue),
        draftLinks: normalizeDeliverableLinks(
          item?.draftLinks || item?.draftUrl || item?.draftLink || []
        ),
        draftNotes: clean(item?.draftNotes),
        draftSubmittedAt: item?.draftSubmittedAt || null,

        preShootScriptRequired,
        preShootScriptDue: toDateOrNull(item?.preShootScriptDue),
        preShootScriptLinks: normalizeDeliverableLinks(
          item?.preShootScriptLinks || item?.preShootScriptUrl || item?.preShootScriptLink || []
        ),

        contentSpecification: clean(item?.contentSpecification || item?.specification),
        liveDate: toDateOrNull(item?.liveDate),

        status: clean(item?.status) || "pending",
        comments: clean(item?.comments),
        approvedRole: clean(item?.approvedRole),
        approvalId: clean(item?.approvalId),
        approvedAt: item?.approvedAt || null,
        revisionRequestedAt: item?.revisionRequestedAt || null,
        revisions: Array.isArray(item?.revisions) ? item.revisions : [],
      };
    })
    .filter((item) => item.deliverableName);
};

  try {
    const {
      brandId,
      influencerId,
      campaignId,
      contractId,

      adminId = "",
      source = "",
      createdByRole = "",
      createdByModel = "",

      milestoneName,
      milestoneTitle,
      milestoneDescription = "",

      milestoneBudget,
      amount,

      attachments = [],
      productImages = [],
      references = [],

      deliverables = [],

      startDate,
      endDate,
      graceDays = 0,
      submissionLink = "",
      needDraftFirst = false,
      draftDate = null,
    } = req.body || {};

    const resolvedTitle = clean(milestoneTitle || milestoneName);
    const resolvedContractId = clean(contractId);
    const resolvedAdminId = clean(adminId);

    const amountNum = Number(
      milestoneBudget !== undefined && milestoneBudget !== null
        ? milestoneBudget
        : amount
    );

    const normalizedAttachments = normalizeAttachments([
      ...toArray(attachments),
      ...toArray(productImages),
      ...toArray(references),
    ]);

    const normalizedDeliverables = normalizeDeliverables(deliverables);

    if (!brandId || !influencerId || !campaignId) {
      return res.status(400).json({
        message: "brandId, influencerId and campaignId are required",
      });
    }

    if (!resolvedTitle) {
      return res.status(400).json({
        message: "milestoneTitle is required",
      });
    }

    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        message: "milestoneBudget must be a valid number > 0",
      });
    }

    if (!normalizedDeliverables.length) {
      return res.status(400).json({
        message: "At least one deliverable is required",
      });
    }

    const parsedStartDate = toDateOrNull(startDate);
    const parsedEndDate = toDateOrNull(endDate);
    const parsedDraftDate = toDateOrNull(draftDate);
    const graceDaysNum = Number(graceDays || 0);
    const needsDraft = boolValue(needDraftFirst);

    if (startDate && !parsedStartDate) {
      return res.status(400).json({
        message: "Invalid startDate",
      });
    }

    if (endDate && !parsedEndDate) {
      return res.status(400).json({
        message: "Invalid endDate",
      });
    }

    if (parsedStartDate && parsedEndDate && parsedEndDate < parsedStartDate) {
      return res.status(400).json({
        message: "endDate cannot be before startDate",
      });
    }

    if (needsDraft && !parsedDraftDate) {
      return res.status(400).json({
        message: "draftDate is required when needDraftFirst is true",
      });
    }

    if (draftDate && !parsedDraftDate) {
      return res.status(400).json({
        message: "Invalid draftDate",
      });
    }

    let responsePayload = null;
    let emailData = null;
    let createdByAdmin = false;

    await session.withTransaction(async () => {
      const campaignOr = [{ campaignsId: String(campaignId) }];

      if (isOid(campaignId)) {
        campaignOr.push({ _id: toObjectId(campaignId) });
      }

      const camp = await Campaign.findOne({ $or: campaignOr })
        .session(session)
        .lean();

      if (!camp) {
        abort(404, "Campaign not found");
      }

      const campaignCreatedBy = camp?.createdBy || {};

      const campaignAdminId = clean(
        campaignCreatedBy?.userId ||
          campaignCreatedBy?._id ||
          campaignCreatedBy?.id ||
          ""
      );

      const campaignCreatedByRole = clean(
        campaignCreatedBy?.role
      ).toLowerCase();

      const finalAdminId = clean(resolvedAdminId || campaignAdminId);

      const finalCreatedByModel =
        clean(createdByModel) ||
        clean(campaignCreatedBy?.userModel) ||
        "Master";

      const isAdminMilestoneFinal =
        clean(source).toLowerCase() === "admin" ||
        clean(createdByRole).toLowerCase() === "admin" ||
        campaignCreatedByRole === "admin" ||
        Boolean(finalAdminId && !resolvedContractId);

      createdByAdmin = isAdminMilestoneFinal;

      if (!isAdminMilestoneFinal && !resolvedContractId) {
        abort(400, "contractId is required for brand milestone creation");
      }

      if (isAdminMilestoneFinal && !finalAdminId) {
        abort(400, "adminId is required for admin milestone creation");
      }

      if (isAdminMilestoneFinal && !isOid(finalAdminId)) {
        abort(400, "Invalid adminId");
      }

      let contractDoc = null;
      let influencerBudget = 0;
      let existingTotalForInfluencerContract = 0;
      let isUploadedContractFlow = false;

      if (!isAdminMilestoneFinal) {
        const contractOr = [{ contractId: resolvedContractId }];

        if (isOid(resolvedContractId)) {
          contractOr.push({ _id: toObjectId(resolvedContractId) });
        }

        contractDoc = await Contract.findOne({
          $or: contractOr,
          brandId: { $in: idVariants(brandId) },
          influencerId: { $in: idVariants(influencerId) },
          campaignId: { $in: idVariants(campaignId) },
        }).session(session);

        if (!contractDoc) {
          contractDoc = await Contract.findOne({
            brandId: { $in: idVariants(brandId) },
            influencerId: { $in: idVariants(influencerId) },
            campaignId: { $in: idVariants(campaignId) },
          })
            .sort({ createdAt: -1 })
            .session(session);
        }

        if (!contractDoc) {
          abort(
            400,
            "Contract not found for this brand, influencer and campaign."
          );
        }

        const contractMatchesRequest =
          sameId(contractDoc.brandId, brandId) &&
          sameId(contractDoc.influencerId, influencerId) &&
          sameId(contractDoc.campaignId, campaignId);

        if (!contractMatchesRequest) {
          abort(
            400,
            "Contract does not match this brand, influencer and campaign."
          );
        }

        const canCreateMilestone = await isContractFullySignedForMilestone(contractDoc);

        if (!canCreateMilestone) {
          abort(
            400,
            "Contract must be fully signed before creating milestones."
          );
        }

        isUploadedContractFlow = isUploadedContractSource(contractDoc);

        // Uploaded / own-contract flow does not have structured commercial terms,
        // so do not require influencer budget from Schedule A. Template contracts
        // keep the previous budget validation exactly as before.
        if (!isUploadedContractFlow) {
          const commercial = contractDoc?.content?.scheduleA?.commercial || {};

          influencerBudget = getFirstPositiveNumber(
            commercial?.totalCampaignFee,
            commercial?.influencerBudget,
            commercial?.feeAmount,
            contractDoc?.totalCampaignFee,
            contractDoc?.feeAmount,
            contractDoc?.influencerBudget,
            contractDoc?.amount
          );

          if (!influencerBudget) {
            abort(
              400,
              "Influencer budget not found in contract. Please update the contract amount first."
            );
          }

          if (amountNum > influencerBudget) {
            abort(
              400,
              "Milestone budget cannot exceed influencer contract budget.",
              {
                milestoneBudget: amountNum,
                influencerBudget,
              }
            );
          }
        }
      }

      let doc = await Milestone.findOne({ brandId }).session(session);

      if (!doc) {
        doc = new Milestone({
          brandId,
          totalAmount: 0,
          milestoneHistory: [],
        });
      }

      doc.totalAmount = Number(doc.totalAmount || 0);

      const previousMilestonesForInfluencerCampaign = (
        doc.milestoneHistory || []
      ).filter(
        (entry) =>
          sameId(entry.influencerId, influencerId) &&
          sameId(entry.campaignId, campaignId)
      );

      // Allow brand to create another milestone even if earlier milestones are not released.
      // Budget and campaign wallet checks below still protect against over-allocation.
      existingTotalForInfluencerContract =
        previousMilestonesForInfluencerCampaign.reduce(
          (sum, entry) =>
            sum +
            (Number(entry.milestoneBudget) || Number(entry.amount) || 0),
          0
        );

      if (
        !isAdminMilestoneFinal &&
        !isUploadedContractFlow &&
        existingTotalForInfluencerContract + amountNum > influencerBudget
      ) {
        abort(
          400,
          "Total milestone budget cannot exceed influencer contract budget.",
          {
            existingMilestoneBudget: existingTotalForInfluencerContract,
            newMilestoneBudget: amountNum,
            influencerBudget,
            remainingBudget: Math.max(
              0,
              influencerBudget - existingTotalForInfluencerContract
            ),
          }
        );
      }

      const campaignBudget = Number(camp.budget || camp.campaignBudget || 0);
      const hasCampaignBudget =
        Number.isFinite(campaignBudget) && campaignBudget > 0;

      if (hasCampaignBudget) {
        const existingTotalForCampaign = (doc.milestoneHistory || [])
          .filter((entry) => sameId(entry.campaignId, campaignId))
          .reduce(
            (sum, entry) =>
              sum +
              (Number(entry.milestoneBudget) || Number(entry.amount) || 0),
            0
          );

        if (existingTotalForCampaign >= campaignBudget) {
          abort(
            400,
            "You have added milestone equal to campaign budget. You cannot add a new milestone."
          );
        }

        if (existingTotalForCampaign + amountNum > campaignBudget) {
          abort(400, "Total milestone amount cannot exceed campaign budget");
        }
      }

      const wallet = await getOrCreateBrandWallet(brandId, session);
      const walletSnapBefore = syncUsableBalance(wallet);

      if (Number(walletSnapBefore.walletBalance || 0) < amountNum) {
        const needToAdd = Math.max(
          0,
          amountNum - Number(walletSnapBefore.walletBalance || 0)
        );

        abort(
          402,
          "Insufficient brand wallet balance. Please top up the remaining amount.",
          {
            walletBalance: walletSnapBefore.walletBalance,
            escrowBalance: walletSnapBefore.escrowBalance,
            frozenBalance: walletSnapBefore.frozenBalance,
            usableBalance: walletSnapBefore.usableBalance,
            requiredAmount: amountNum,
            needToAdd,
          }
        );
      }

      const walletSnapAfter = moveAmountToEscrow(wallet, {
        amount: amountNum,
        type: "milestone_escrow",
        brandId,
        campaignId,
        influencerId,
        contractId: isAdminMilestoneFinal
          ? ""
          : contractDoc?.contractId || resolvedContractId,
        milestoneTitle: resolvedTitle,
        note: "Milestone created; amount moved from brand wallet to escrow.",
      });

      doc.milestoneHistory.push({
        influencerId,
        campaignId,

        contractMongoId: isAdminMilestoneFinal
          ? null
          : contractDoc?._id || null,
        contractId: isAdminMilestoneFinal
          ? ""
          : contractDoc?.contractId || resolvedContractId,
        contractSource: isAdminMilestoneFinal
          ? ""
          : getContractSourceType(contractDoc),
        isUploadedContract: Boolean(!isAdminMilestoneFinal && isUploadedContractFlow),

        adminId: isAdminMilestoneFinal ? toObjectId(finalAdminId) : null,
        createdByRole: isAdminMilestoneFinal ? "admin" : "brand",
        createdByModel: isAdminMilestoneFinal ? finalCreatedByModel : "Brand",

        milestoneTitle: resolvedTitle,
        milestoneDescription: clean(milestoneDescription),

        milestoneBudget: amountNum,
        amount: amountNum,

        attachments: normalizedAttachments,
        deliverables: normalizedDeliverables,

        startDate: parsedStartDate,
        endDate: parsedEndDate,
        graceDays:
          Number.isFinite(graceDaysNum) && graceDaysNum > 0 ? graceDaysNum : 0,

        submissionLink: clean(submissionLink),

        needDraftFirst: needsDraft,
        draftDate: needsDraft ? parsedDraftDate : null,

        isAccepted: 0,

        released: false,
        releasedAt: null,
        payoutStatus: "pending",
        paidAt: null,
      });

      doc.totalAmount = doc.totalAmount + amountNum;

      await doc.save({ session });
      await wallet.save({ session });

      const createdEntry = doc.milestoneHistory[doc.milestoneHistory.length - 1];

      let updatedContract = null;

      if (!isAdminMilestoneFinal && contractDoc) {
        const alreadyMilestonesLocked =
          String(contractDoc.status || "").toUpperCase() ===
          CONTRACT_STATUS.MILESTONES_CREATED;

        if (!alreadyMilestonesLocked) {
          contractDoc.status = CONTRACT_STATUS.MILESTONES_CREATED;
          contractDoc.milestonesCreatedAt =
            contractDoc.milestonesCreatedAt || new Date();
          contractDoc.awaitingRole = null;

          contractDoc.statusFlags = contractDoc.statusFlags || {};
          contractDoc.statusFlags.awaitingCollabglam = false;
          contractDoc.statusFlags.hasMilestones = true;

          contractDoc.audit = contractDoc.audit || [];
          contractDoc.audit.push({
            type: "MILESTONES_CREATED",
            role: "system",
            details: {
              brandId,
              influencerId,
              campaignId,
              contractId: contractDoc.contractId || String(contractDoc._id),
              milestoneHistoryId: String(createdEntry._id),
              milestoneBudget: amountNum,
            },
            at: new Date(),
          });

          await contractDoc.save({ session });
        }

        updatedContract = contractDoc;

        await Campaign.updateOne(
          { _id: camp._id },
          {
            $set: {
              contractId: contractDoc._id || contractDoc.contractId,
              isContracted: 1,
              contractStatus: contractDoc.status,
              milestonesCreatedAt:
                contractDoc.milestonesCreatedAt || new Date(),
            },
          },
          { session }
        );
      }

      const campaignName =
        camp.productOrServiceName ||
        camp.campaignTitle ||
        camp.name ||
        "";

      responsePayload = {
        message: isAdminMilestoneFinal
          ? "Milestone created successfully by admin and amount moved to escrow"
          : "Milestone created and amount moved to escrow successfully",

        milestoneId: String(doc._id),
        milestoneHistoryId: String(createdEntry._id),
        totalAmount: doc.totalAmount,

        campaignName,

        source: isAdminMilestoneFinal ? "admin" : "brand",
        createdByRole:
          createdEntry.createdByRole ||
          (isAdminMilestoneFinal ? "admin" : "brand"),
        createdByModel: createdEntry.createdByModel || "",
        adminId: isAdminMilestoneFinal
          ? String(createdEntry.adminId || finalAdminId)
          : "",

        influencerBudget:
          isAdminMilestoneFinal || isUploadedContractFlow ? null : influencerBudget,
        usedInfluencerBudget:
          isAdminMilestoneFinal || isUploadedContractFlow
            ? null
            : existingTotalForInfluencerContract + amountNum,
        remainingInfluencerBudget:
          isAdminMilestoneFinal || isUploadedContractFlow
            ? null
            : Math.max(
                0,
                influencerBudget - existingTotalForInfluencerContract - amountNum
              ),

        entry: {
          milestoneHistoryId: String(createdEntry._id),
          influencerId: createdEntry.influencerId,
          campaignId: createdEntry.campaignId,

          contractId: createdEntry.contractId || "",
          contractSource: createdEntry.contractSource || "",
          isUploadedContract: Boolean(createdEntry.isUploadedContract),
          adminId: createdEntry.adminId ? String(createdEntry.adminId) : "",
          createdByRole: createdEntry.createdByRole || "",
          createdByModel: createdEntry.createdByModel || "",

          milestoneTitle: createdEntry.milestoneTitle,
          milestoneDescription: createdEntry.milestoneDescription,

          milestoneBudget: createdEntry.milestoneBudget,
          amount: createdEntry.amount,

          attachments: createdEntry.attachments,
          deliverables: (createdEntry.deliverables || []).map((item) => ({
            deliverableId: String(item._id),
            deliverableName: item.deliverableName,
            deliveries: item.deliveries || [],
            aspectRatio: item.aspectRatio || "",
            platforms: item.platforms || [],
            quantity: item.quantity || 1,
            deliverableLinks: item.deliverableLinks || [],
            status: item.status || "pending",
            submittedAt: item.submittedAt || null,
            submissionName: item.submissionName || "",
            submissionNotes: item.submissionNotes || item.additionalNotes || "",
            additionalNotes: item.additionalNotes || item.submissionNotes || "",
            draftRequired: Boolean(item.draftRequired || item.needDraftFirst || item.requiresDraft || item.preShootScriptRequired),
            draftLinks: item.draftLinks || [],
            draftSubmittedAt: item.draftSubmittedAt || null,
            preShootScriptRequired: Boolean(item.preShootScriptRequired),
            preShootScriptLinks: item.preShootScriptLinks || [],
          })),

          isAccepted: createdEntry.isAccepted || 0,

          startDate: createdEntry.startDate,
          endDate: createdEntry.endDate,
          graceDays: createdEntry.graceDays,
          submissionLink: createdEntry.submissionLink,
          needDraftFirst: createdEntry.needDraftFirst,
          draftDate: createdEntry.draftDate,

          released: createdEntry.released,
          releasedAt: createdEntry.releasedAt,
          payoutStatus: createdEntry.payoutStatus,
          paidAt: createdEntry.paidAt,
          createdAt: createdEntry.createdAt,
          updatedAt: createdEntry.updatedAt,
        },

        wallet: {
          walletBalance: walletSnapAfter.walletBalance,
          escrowBalance: walletSnapAfter.escrowBalance,
          frozenBalance: walletSnapAfter.frozenBalance,
          usableBalance: walletSnapAfter.usableBalance,
        },

        escrow: {
          amountMovedToEscrow: amountNum,
          escrowBalance: walletSnapAfter.escrowBalance,
        },

        contractStatus: updatedContract?.status || null,
        milestonesCreatedAt: updatedContract?.milestonesCreatedAt || null,
      };

      emailData = {
        brandId,
        influencerId,
        campaignName,
        milestoneTitle: resolvedTitle,
        amount: amountNum,
        milestoneDescription,
        isAdminMilestone: isAdminMilestoneFinal,
      };
    });

    session.endSession();

    createAndEmit({
      influencerId: req.body.influencerId,
      type: "milestone.created",
      title: `New milestone: ${resolvedTitle}`,
      message: `An amount of $${Number(amountNum).toFixed(
        2
      )} was created for this campaign.`,
      entityType: "campaign",
      entityId: String(req.body.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error("notify influencer (created) failed:", e));

    createAndEmit({
      brandId: req.body.brandId,
      type: "milestone.created",
      title: createdByAdmin
        ? `Milestone created by admin for influencer ${req.body.influencerId}`
        : `Milestone created for influencer ${req.body.influencerId}`,
      message: `${resolvedTitle} • $${Number(amountNum).toFixed(2)}`,
      entityType: "campaign",
      entityId: String(req.body.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error("notify brand (created) failed:", e));

    try {
      const [infDoc, brandDoc] = await Promise.all([
        Influencer.findById(emailData.influencerId, "name email").lean(),
        Brand.findById(emailData.brandId, "name").lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestoneCreatedEmail({
          to: infDoc.email,
          influencerName: infDoc.name || "",
          brandName: (brandDoc && brandDoc.name) || "",
          campaignName: emailData.campaignName,
          milestoneTitle: emailData.milestoneTitle,
          amount: emailData.amount,
          milestoneDescription: emailData.milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error("sendMilestoneCreatedEmail failed:", e));
      }
    } catch (emailErr) {
      console.error("Error preparing milestone created email:", emailErr);
    }

    return res.status(201).json(responsePayload);
  } catch (err) {
    await session.abortTransaction().catch(() => {});
    session.endSession();

    console.error("Error in createMilestone:", err);

    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "CREATE_MILESTONE_ERROR");if (err.status) {
      return res.status(err.status).json({
        message: err.message,
        ...(err.extra || {}),
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.editMilestone = async (req, res) => {
  const session = await mongoose.startSession();

  const abort = (status, message, extra = {}) => {
    const err = new Error(message);
    err.status = status;
    err.extra = extra;
    throw err;
  };

  try {
    const {
      milestoneId,
      milestoneHistoryId,

      milestoneName,
      milestoneTitle,
      milestoneDescription = "",

      milestoneBudget,
      amount,

      attachments = [],
      productImages = [],
      references = [],

      deliverables = [],

      startDate,
      endDate,
      graceDays = 0,
      submissionLink = "",
      needDraftFirst = false,
      draftDate = null,
    } = req.body || {};

    const resolvedMilestoneId = clean(milestoneId);
    const resolvedHistoryId = clean(milestoneHistoryId);
    const resolvedTitle = clean(milestoneTitle || milestoneName);

    if (!resolvedMilestoneId || !resolvedHistoryId) {
      return res.status(400).json({
        message: "milestoneId and milestoneHistoryId are required",
      });
    }

    if (!resolvedTitle) {
      return res.status(400).json({
        message: "milestoneTitle is required",
      });
    }

    const amountNum = Number(
      milestoneBudget !== undefined && milestoneBudget !== null
        ? milestoneBudget
        : amount
    );

    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.status(400).json({
        message: "milestoneBudget must be a valid number > 0",
      });
    }

    const normalizedAttachments = normalizeAttachments([
      ...toArray(attachments),
      ...toArray(productImages),
      ...toArray(references),
    ]);

    const normalizedDeliverables = normalizeDeliverables(deliverables);

    if (!normalizedDeliverables.length) {
      return res.status(400).json({
        message: "At least one deliverable is required",
      });
    }

    const parsedStartDate = toDateOrNull(startDate);
    const parsedEndDate = toDateOrNull(endDate);
    const parsedDraftDate = toDateOrNull(draftDate);
    const graceDaysNum = Number(graceDays || 0);
    const needsDraft = boolValue(needDraftFirst);

    if (startDate && !parsedStartDate) {
      return res.status(400).json({
        message: "Invalid startDate",
      });
    }

    if (endDate && !parsedEndDate) {
      return res.status(400).json({
        message: "Invalid endDate",
      });
    }

    if (parsedStartDate && parsedEndDate && parsedEndDate < parsedStartDate) {
      return res.status(400).json({
        message: "endDate cannot be before startDate",
      });
    }

    if (needsDraft && !parsedDraftDate) {
      return res.status(400).json({
        message: "draftDate is required when needDraftFirst is true",
      });
    }

    if (draftDate && !parsedDraftDate) {
      return res.status(400).json({
        message: "Invalid draftDate",
      });
    }

    let responsePayload = null;

    await session.withTransaction(async () => {
      const doc = await Milestone.findById(resolvedMilestoneId).session(session);

      if (!doc) {
        abort(404, "Milestone not found");
      }

      const entry = doc.milestoneHistory.id(resolvedHistoryId);

      if (!entry) {
        abort(404, "Milestone history not found");
      }

      if (Number(entry.isAccepted || 0) === 1) {
        abort(403, "Milestone has been accepted. Brand cannot edit this milestone.");
      }

      if (entry.released === true || String(entry.payoutStatus || "") !== "pending") {
        abort(400, "Released or paid milestone cannot be edited.");
      }

      const influencerId = entry.influencerId;
      const campaignId = entry.campaignId;
      const oldAmount = Number(entry.milestoneBudget || entry.amount || 0);
      const amountDelta = amountNum - oldAmount;

      const contractOr = [];

      if (entry.contractId) {
        contractOr.push({ contractId: String(entry.contractId) });
      }

      if (entry.contractMongoId) {
        contractOr.push({ _id: entry.contractMongoId });
      }

      let contractDoc = null;
      let isUploadedContractFlow = false;

      if (contractOr.length) {
        contractDoc = await Contract.findOne({
          $or: contractOr,
        }).session(session);
      }

      if (!contractDoc) {
        contractDoc = await Contract.findOne({
          brandId: doc.brandId,
          influencerId,
          campaignId,
        })
          .sort({ createdAt: -1 })
          .session(session);
      }

      if (!contractDoc) {
        abort(400, "Contract not found for this milestone.");
      }

      isUploadedContractFlow = isUploadedContractSource(contractDoc);

      let influencerBudget = 0;

      if (!isUploadedContractFlow) {
        const commercial = contractDoc?.content?.scheduleA?.commercial || {};

        influencerBudget = getFirstPositiveNumber(
          commercial?.totalCampaignFee,
          commercial?.influencerBudget,
          commercial?.feeAmount,
          contractDoc?.totalCampaignFee,
          contractDoc?.feeAmount,
          contractDoc?.influencerBudget,
          contractDoc?.amount
        );

        if (!influencerBudget) {
          abort(
            400,
            "Influencer budget not found in contract. Please update the contract amount first."
          );
        }
      }

      const existingTotalExcludingCurrent = (doc.milestoneHistory || [])
        .filter(
          (item) =>
            String(item._id) !== String(entry._id) &&
            sameId(item.influencerId, influencerId) &&
            sameId(item.campaignId, campaignId)
        )
        .reduce(
          (sum, item) =>
            sum + (Number(item.milestoneBudget) || Number(item.amount) || 0),
          0
        );

      if (!isUploadedContractFlow && existingTotalExcludingCurrent + amountNum > influencerBudget) {
        abort(
          400,
          "Total milestone budget cannot exceed influencer contract budget.",
          {
            influencerBudget,
            existingMilestoneBudget: existingTotalExcludingCurrent,
            newMilestoneBudget: amountNum,
            remainingBudget: Math.max(
              0,
              influencerBudget - existingTotalExcludingCurrent
            ),
          }
        );
      }

      if (amountDelta !== 0) {
        const wallet = await getOrCreateBrandWallet(doc.brandId, session);
        const walletSnapBefore = syncUsableBalance(wallet);

        if (amountDelta > 0) {
          if (Number(walletSnapBefore.walletBalance || 0) < amountDelta) {
            const needToAdd = Math.max(
              0,
              amountDelta - Number(walletSnapBefore.walletBalance || 0)
            );

            abort(
              402,
              "Insufficient brand wallet balance. Please top up the remaining amount.",
              {
                walletBalance: walletSnapBefore.walletBalance,
                escrowBalance: walletSnapBefore.escrowBalance,
                frozenBalance: walletSnapBefore.frozenBalance,
                usableBalance: walletSnapBefore.usableBalance,
                requiredAmount: amountDelta,
                needToAdd,
              }
            );
          }

          moveAmountToEscrow(wallet, {
            amount: amountDelta,
            type: "milestone_escrow_adjustment",
            brandId: doc.brandId,
            campaignId,
            influencerId,
            contractId: contractDoc?.contractId || entry.contractId || "",
            milestoneId: resolvedMilestoneId,
            milestoneHistoryId: resolvedHistoryId,
            milestoneTitle: resolvedTitle,
            note: "Milestone amount increased; additional amount moved to escrow.",
          });
        } else {
          refundAmountFromEscrow(wallet, {
            amount: Math.abs(amountDelta),
            type: "milestone_escrow_refund",
            brandId: doc.brandId,
            campaignId,
            influencerId,
            contractId: contractDoc?.contractId || entry.contractId || "",
            milestoneId: resolvedMilestoneId,
            milestoneHistoryId: resolvedHistoryId,
            milestoneTitle: resolvedTitle,
            note: "Milestone amount reduced before release; difference returned from escrow to wallet.",
          });
        }

        syncUsableBalance(wallet);
        await wallet.save({ session });

        doc.totalAmount = Math.max(0, Number(doc.totalAmount || 0) + amountDelta);
      }

      entry.milestoneTitle = resolvedTitle;
      entry.milestoneDescription = clean(milestoneDescription);
      entry.milestoneBudget = amountNum;
      entry.amount = amountNum;
      entry.attachments = normalizedAttachments;
      entry.deliverables = normalizedDeliverables;
      entry.startDate = parsedStartDate;
      entry.endDate = parsedEndDate;
      entry.graceDays =
        Number.isFinite(graceDaysNum) && graceDaysNum > 0 ? graceDaysNum : 0;
      entry.submissionLink = clean(submissionLink);
      entry.contractSource = getContractSourceType(contractDoc);
      entry.isUploadedContract = Boolean(isUploadedContractFlow);
      entry.needDraftFirst = needsDraft;
      entry.draftDate = needsDraft ? parsedDraftDate : null;

      await doc.save({ session });

      responsePayload = {
        message: "Milestone updated successfully",
        milestoneId: String(doc._id),
        milestoneHistoryId: String(entry._id),
        entry: {
          milestoneHistoryId: String(entry._id),
          influencerId: entry.influencerId,
          campaignId: entry.campaignId,
          contractId: entry.contractId,
          contractSource: entry.contractSource || "",
          isUploadedContract: Boolean(entry.isUploadedContract),

          milestoneTitle: entry.milestoneTitle,
          milestoneDescription: entry.milestoneDescription,

          milestoneBudget: entry.milestoneBudget,
          amount: entry.amount,

          attachments: entry.attachments,
          deliverables: (entry.deliverables || []).map((item) => ({
            deliverableId: String(item._id),
            deliverableName: item.deliverableName,
            deliveries: item.deliveries,
            aspectRatio: item.aspectRatio,
            platforms: item.platforms,
            quantity: item.quantity,
            status: item.status,
            submissionName: item.submissionName || "",
            submissionNotes: item.submissionNotes || item.additionalNotes || "",
            additionalNotes: item.additionalNotes || item.submissionNotes || "",
            submittedAt: item.submittedAt || null,
          })),

          startDate: entry.startDate,
          endDate: entry.endDate,
          graceDays: entry.graceDays,
          submissionLink: entry.submissionLink,
          needDraftFirst: entry.needDraftFirst,
          draftDate: entry.draftDate,
          isAccepted: entry.isAccepted || 0,
          released: entry.released,
          payoutStatus: entry.payoutStatus,
          updatedAt: entry.updatedAt,
        },
      };
    });

    session.endSession();

    return res.status(200).json(responsePayload);
  } catch (err) {
    await session.abortTransaction().catch(() => { });
    session.endSession();

    console.error("Error in editMilestone:", err);

    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "EDIT_MILESTONE_ERROR");if (err.status) {
      return res.status(err.status).json({
        message: err.message,
        ...(err.extra || {}),
      });
    }

    return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/listByCampaign
// body: { campaignId }
// ======================================================================
exports.getMilestonesByCampaign = async (req, res) => {
  const { campaignId } = req.body;

  if (!campaignId) {
    return res.status(400).json({ message: "campaignId is required" });
  }

  try {
    const docs = await Milestone.find({
      "milestoneHistory.campaignId": String(campaignId),
    }).lean();

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => String(e.campaignId) === String(campaignId))
        .map((e) => {
          const deliverablesCount = Array.isArray(e.deliverables)
            ? e.deliverables.length
            : 0;

          return {
            ...e,
            milestoneHistoryId: String(e._id),
            brandId: String(doc.brandId),
            milestoneId: String(doc._id),
            deliverablesCount,
          };
        })
    );

    const influencerIds = [
      ...new Set(
        entries
          .map((e) => e.influencerId)
          .filter(Boolean)
          .map((id) => String(id))
      ),
    ];

    let influencers = [];

    if (influencerIds.length) {
      influencers = await Influencer.find(
        {
          $or: [
            { influencerId: { $in: influencerIds } },
            { _id: { $in: influencerIds } },
          ],
        },
        "_id influencerId name fullName username email"
      ).lean();
    }

    const influencerMap = new Map();

    influencers.forEach((inf) => {
      const displayName =
        inf.name || inf.fullName || inf.username || inf.email || "Unknown Influencer";

      if (inf.influencerId) {
        influencerMap.set(String(inf.influencerId), displayName);
      }

      if (inf._id) {
        influencerMap.set(String(inf._id), displayName);
      }
    });

    const contractPairs = [
      ...new Map(
        entries
          .filter((e) => e.influencerId && e.campaignId)
          .map((e) => [`${String(e.influencerId)}_${String(e.campaignId)}`, e])
      ).values(),
    ];

    const contracts = await Promise.all(
      contractPairs.map((e) =>
        Contract.findOne(
          {
            influencerId: String(e.influencerId),
            campaignId: String(e.campaignId),
          },
          {
            influencerId: 1,
            campaignId: 1,
            contractId: 1,
            paymentType: 1,
            currency: 1,
            "content.scheduleA.commercial.currency": 1,
            "content.scheduleA.commercial.totalCampaignFee": 1,
            "content.scheduleA.commercial.milestones": 1,
          }
        ).lean()
      )
    );

    const contractMap = new Map();

    contracts.forEach((contract) => {
      if (contract?.influencerId && contract?.campaignId) {
        const key = `${String(contract.influencerId)}_${String(contract.campaignId)}`;
        contractMap.set(key, contract);
      }
    });

    const entriesWithNames = entries.map((e) => {
      const contractKey = `${String(e.influencerId || "")}_${String(e.campaignId || "")}`;
      const contract = contractMap.get(contractKey) || null;

      return {
        ...e,
        influencerName: e.influencerId
          ? influencerMap.get(String(e.influencerId)) || "Unknown Influencer"
          : "Unknown Influencer",
        contractId: contract?.contractId || "",
        paymentType: contract?.paymentType || "",
        currency:
          contract?.currency ||
          contract?.content?.scheduleA?.commercial?.currency ||
          "",
        totalCampaignFee:
          contract?.content?.scheduleA?.commercial?.totalCampaignFee || 0,
        milestones:
          contract?.content?.scheduleA?.commercial?.milestones || [],
      };
    });

    entriesWithNames.sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    return res.status(200).json({
      message: "Milestones fetched by campaign",
      milestones: entriesWithNames,
    });
  } catch (err) {
    console.error("Error in getMilestonesByCampaign:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "GET_MILESTONES_BY_CAMPAIGN_ERROR");return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/listByInfluencerAndCampaign
// body: { influencerId, campaignId, brandId? }
// ======================================================================

exports.getMilestonesByInfluencerAndCampaign = async (req, res) => {
  const { influencerId, campaignId, brandId } = req.body;

  if (!influencerId || !campaignId) {
    return res
      .status(400)
      .json({ message: "influencerId and campaignId are required" });
  }

  try {
    const filter = {
      milestoneHistory: {
        $elemMatch: {
          influencerId: String(influencerId),
          campaignId: String(campaignId),
        },
      },
    };

    if (brandId) {
      filter.brandId = String(brandId);
    }

    const [docs, campaignDoc, influencerDoc] = await Promise.all([
      Milestone.find(filter).lean(),

      Campaign.findOne({
        $or: [{ _id: campaignId }, { campaignId: String(campaignId) }],
      })
        .select("campaignTitle title")
        .lean(),

      Influencer.findOne({
        $or: [{ _id: influencerId }, { influencerId: String(influencerId) }],
      })
        .select("name fullName influencerName")
        .lean(),
    ]);

    const campaignTitle =
      campaignDoc?.campaignTitle || campaignDoc?.title || "";

    const influencerName =
      influencerDoc?.name ||
      influencerDoc?.fullName ||
      influencerDoc?.influencerName ||
      "";

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter(
          (e) =>
            String(e.influencerId) === String(influencerId) &&
            String(e.campaignId) === String(campaignId)
        )
        .map((e) => {
          let payoutStatus = e.payoutStatus;
          if (!payoutStatus) {
            payoutStatus = e.released ? "initiated" : "pending";
          }

          return {
            ...e,
            milestoneHistoryId: String(e._id),
            payoutStatus,
            brandId: doc.brandId,
            milestoneId: String(doc._id),
            campaignTitle,
            influencerName,
          };
        })
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Milestones fetched by influencer and campaign",
      campaignTitle,
      influencerName,
      milestones: entries,
    });
  } catch (err) {
    console.error("Error in getMilestonesByInfluencerAndCampaign:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "GET_MILESTONES_BY_INFLUENCER_AND_CAMPAIGN_ERROR");return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/listByInfluencer
// body: { influencerId }
// ======================================================================
exports.getMilestonesByInfluencer = async (req, res) => {
  const { influencerId } = req.body;
  if (!influencerId) {
    return res.status(400).json({ message: "influencerId is required" });
  }

  try {
    const docs = await Milestone.find({
      "milestoneHistory.influencerId": String(influencerId),
    }).lean();

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => String(e.influencerId) === String(influencerId))
        .map((e) => ({
          ...e,
          milestoneHistoryId: String(e._id),
          brandId: doc.brandId,
          milestoneId: String(doc._id),
        }))
    );

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Milestones fetched by influencer",
      milestones: entries,
    });
  } catch (err) {
    console.error("Error in getMilestonesByInfluencer:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "GET_MILESTONES_BY_INFLUENCER_ERROR");return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/listByBrand
// body: { brandId }
// ======================================================================
exports.getMilestonesByBrand = async (req, res) => {
  const { brandId } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: "brandId is required" });
  }

  try {
    const [doc, wallet] = await Promise.all([
      Milestone.findOne({ brandId }).lean(),
      getWalletSnapshotByBrandId(brandId),
    ]);

    if (!doc) {
      return res.status(200).json({
        message: "No milestones found for this brand",
        wallet,
        milestones: [],
      });
    }

    const entries = (doc.milestoneHistory || []).map((e) => ({
      ...e,
      milestoneHistoryId: String(e._id),
      brandId: doc.brandId,
      milestoneId: String(doc._id),
    }));

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Milestones fetched by brand",
      wallet,
      totalAmount: Number(doc.totalAmount || 0),
      milestones: entries,
    });
  } catch (err) {
    console.error("Error in getMilestonesByBrand:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "GET_MILESTONES_BY_BRAND_ERROR");return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/balance
// body: { brandId }
// ======================================================================
exports.getWalletBalance = async (req, res) => {
  const { brandId } = req.body;
  if (!brandId) {
    return res.status(400).json({ message: "brandId is required" });
  }

  try {
    const wallet = await getWalletSnapshotByBrandId(brandId);

    return res.status(200).json({
      message: "Wallet balance fetched",
      brandId,
      walletBalance: wallet.walletBalance,
      frozenBalance: wallet.frozenBalance,
      usableBalance: wallet.usableBalance,
    });
  } catch (err) {
    console.error("Error in getWalletBalance:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "GET_WALLET_BALANCE_ERROR");return res.status(500).json({ message: "Internal server error" });
  }
};


// ======================================================================
// POST /milestone/submitMilestone
// body: { milestoneId, milestoneHistoryId, influencerId }
// Allows influencer to submit a milestone only after all deliverables under it are submitted.
// ======================================================================
exports.submitMilestone = async (req, res) => {
  try {
    const { milestoneId, milestoneHistoryId, influencerId } = req.body || {};

    if (!milestoneId || !milestoneHistoryId || !influencerId) {
      return res.status(400).json({
        success: false,
        message: "milestoneId, milestoneHistoryId and influencerId are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(milestoneId))) {
      return res.status(400).json({ success: false, message: "Invalid milestoneId" });
    }

    if (!mongoose.Types.ObjectId.isValid(String(milestoneHistoryId))) {
      return res.status(400).json({ success: false, message: "Invalid milestoneHistoryId" });
    }

    const milestoneDoc = await Milestone.findById(milestoneId);

    if (!milestoneDoc) {
      return res.status(404).json({ success: false, message: "Milestone not found" });
    }

    const milestoneHistory = milestoneDoc.milestoneHistory.id(milestoneHistoryId);

    if (!milestoneHistory) {
      return res.status(404).json({ success: false, message: "Milestone history not found" });
    }

    if (!sameId(milestoneHistory.influencerId, influencerId)) {
      return res.status(403).json({
        success: false,
        message: "This milestone does not belong to this influencer",
      });
    }

    if (!canSubmitMilestoneHistory(milestoneHistory)) {
      return res.status(400).json({
        success: false,
        message: "Submit all deliverables under this milestone before submitting the milestone.",
        totalDeliverables: Array.isArray(milestoneHistory.deliverables) ? milestoneHistory.deliverables.length : 0,
        submittedDeliverables: Array.isArray(milestoneHistory.deliverables)
          ? milestoneHistory.deliverables.filter(isDeliverableSubmittedForMilestone).length
          : 0,
      });
    }

    milestoneHistory.status = "submitted";
    milestoneHistory.submissionStatus = "submitted";
    milestoneHistory.milestoneSubmissionStatus = "submitted";
    milestoneHistory.isMilestoneSubmitted = true;
    milestoneHistory.submittedAt = milestoneHistory.submittedAt || new Date();
    milestoneHistory.milestoneSubmittedAt =
      milestoneHistory.milestoneSubmittedAt || milestoneHistory.submittedAt;
    milestoneHistory.submittedByInfluencerId = String(influencerId);

    milestoneDoc.markModified("milestoneHistory");
    await milestoneDoc.save();

    createAndEmit({
      brandId: milestoneDoc.brandId,
      type: "milestone.submitted",
      title: `Milestone submitted: ${milestoneHistory.milestoneTitle || "Milestone"}`,
      message: "Influencer has submitted all deliverables under this milestone.",
      entityType: "campaign",
      entityId: String(milestoneHistory.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error("notify brand (milestone submitted) failed:", e));

    return res.status(200).json({
      success: true,
      message: "Milestone submitted successfully",
      milestoneId: String(milestoneDoc._id),
      milestoneHistoryId: String(milestoneHistory._id),
      status: milestoneHistory.status,
      submissionStatus: milestoneHistory.submissionStatus,
      isMilestoneSubmitted: milestoneHistory.isMilestoneSubmitted,
      submittedAt: milestoneHistory.submittedAt,
      milestoneSubmittedAt: milestoneHistory.milestoneSubmittedAt,
      submittedByInfluencerId: milestoneHistory.submittedByInfluencerId,
    });
  } catch (err) {
    console.error("Error in submitMilestone:", err);
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "SUBMIT_MILESTONE_ERROR");

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// ======================================================================
// POST /milestone/release
// body: { milestoneId, milestoneHistoryId }
// ======================================================================
exports.releaseMilestone = async (req, res) => {
  const { milestoneId, milestoneHistoryId } = req.body;

  if (!milestoneId || !milestoneHistoryId) {
    return res.status(400).json({
      message: "milestoneId and milestoneHistoryId are required.",
    });
  }

  if (!mongoose.Types.ObjectId.isValid(milestoneId)) {
    return res.status(400).json({ message: "Invalid milestoneId." });
  }

  try {
    const doc = await Milestone.findById(milestoneId);
    if (!doc) {
      return res.status(404).json({ message: "Milestone not found." });
    }

    const entry = doc.milestoneHistory.id(milestoneHistoryId);
    if (!entry) {
      return res.status(404).json({ message: "Milestone history entry not found." });
    }

    if (entry.released) {
      return res.status(400).json({ message: "This milestone has already been released." });
    }

    const milestoneSubmittedByInfluencer = hasMilestoneBeenSubmittedByInfluencer(entry);

    if (!milestoneSubmittedByInfluencer) {
      return res.status(400).json({
        message:
          "Influencer must submit the milestone before payment can be released.",
      });
    }

    if (!areAllDeliverablesApprovedForRelease(entry)) {
      return res.status(400).json({
        message:
          "All deliverables and revisions must be approved before payment can be released.",
      });
    }

    const wallet = await getOrCreateBrandWallet(doc.brandId);
    const releaseAmount = Number(entry.amount || 0);

    let walletSnap;
    try {
      walletSnap = releaseAmountFromEscrow(wallet, {
        amount: releaseAmount,
        brandId: doc.brandId,
        campaignId: entry.campaignId,
        influencerId: entry.influencerId,
        contractId: entry.contractId || "",
        milestoneId,
        milestoneHistoryId,
        milestoneTitle: entry.milestoneTitle || "",
        note: "Milestone released; escrow amount marked for payout.",
      });
    } catch (releaseErr) {
      return res.status(releaseErr.status || 400).json({
        message: releaseErr.message,
        ...(releaseErr.extra || {}),
      });
    }

    await wallet.save();

    entry.released = true;
    entry.releasedAt = new Date();
    entry.payoutStatus = "initiated";

    await doc.save();

    createAndEmit({
      influencerId: entry.influencerId,
      type: "milestone.initiated",
      title: `Milestone payout initiated${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ""}`,
      message:
        `Brand has released $${Number(entry.amount).toFixed(2)} for this campaign. ` +
        `It should be received within 24 - 48 hrs.`,
      entityType: "campaign",
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error("notify influencer (initiated) failed:", e));

    createAndEmit({
      brandId: doc.brandId,
      type: "milestone.released",
      title: `Milestone released${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ""}`,
      message: `You released $${Number(entry.amount).toFixed(2)} for this campaign.`,
      entityType: "campaign",
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error("notify brand (released) failed:", e));

    try {
      const [infDoc, brandDoc, campDoc] = await Promise.all([
        Influencer.findOne({ influencerId: entry.influencerId }, "name email").lean(),
        Brand.findOne({ brandId: doc.brandId }, "name").lean(),
        Campaign.findOne(
          { campaignsId: entry.campaignId },
          "productOrServiceName"
        ).lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestoneReleasedEmail({
          to: infDoc.email,
          influencerName: infDoc.name || "",
          brandName: (brandDoc && brandDoc.name) || "",
          campaignName: (campDoc && campDoc.productOrServiceName) || "",
          milestoneTitle: entry.milestoneTitle,
          amount: entry.amount,
          milestoneDescription: entry.milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error("sendMilestoneReleasedEmail failed:", e));
      }
    } catch (emailErr) {
      console.error("Error preparing milestone released email:", emailErr);
    }

    return res.status(200).json({
      message: "Milestone released successfully (payout initiated).",
      releasedAmount: entry.amount,
      payoutStatus: entry.payoutStatus,
      milestone: mapMilestoneHistoryForResponse(doc, entry),
      wallet: {
        walletBalance: walletSnap.walletBalance,
        escrowBalance: walletSnap.escrowBalance,
        frozenBalance: walletSnap.frozenBalance,
        usableBalance: walletSnap.usableBalance,
      },
    });
  } catch (err) {
    console.error("Error in releaseMilestone:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "RELEASE_MILESTONE_ERROR");return res.status(500).json({ message: "Internal server error." });
  }
};

// ======================================================================
// POST /milestone/paidTotal
// body: { influencerId }
// ======================================================================
exports.getInfluencerPaidTotal = async (req, res) => {
  const { influencerId } = req.body;

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId is required." });
  }

  if (!mongoose.Types.ObjectId.isValid(influencerId)) {
    return res.status(400).json({ message: "Invalid influencerId." });
  }

  try {
    const result = await Milestone.aggregate([
      { $unwind: "$milestoneHistory" },
      {
        $match: {
          "milestoneHistory.influencerId": new mongoose.Types.ObjectId(influencerId),
        },
      },
      {
        $group: {
          _id: null,
          totalPaid: {
            $sum: {
              $cond: [
                { $eq: ["$milestoneHistory.payoutStatus", "paid"] },
                "$milestoneHistory.amount",
                0,
              ],
            },
          },
          totalUpcoming: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$milestoneHistory.payoutStatus", "pending"] },
                    { $eq: ["$milestoneHistory.released", false] },
                  ],
                },
                "$milestoneHistory.amount",
                0,
              ],
            },
          },
          totalInitiated: {
            $sum: {
              $cond: [
                { $eq: ["$milestoneHistory.payoutStatus", "initiated"] },
                "$milestoneHistory.amount",
                0,
              ],
            },
          },
        },
      },
    ]);

    const summary = result[0] || {
      totalPaid: 0,
      totalUpcoming: 0,
      totalInitiated: 0,
    };

    return res.status(200).json({
      influencerId,
      totalPaid: summary.totalPaid,
      totalPending: summary.totalPending,
      totalUpcoming: summary.totalUpcoming,
      totalInitiated: summary.totalInitiated,
    });
  } catch (err) {
    console.error("Error getting influencer payout totals:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "GET_INFLUENCER_PAID_TOTAL_ERROR");return res.status(500).json({ message: "Internal server error." });
  }
};

// ======================================================================
// POST /milestone/adminListPayouts
// body: { status = 'all' | 'initiated' | 'paid' | [...], page, limit }
// ======================================================================
exports.adminListPayouts = async (req, res) => {
  try {
    const { status = "all", page = 1, limit = 20, search = "" } = req.body || {};

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Number(limit) || 20);
    const searchText = String(search || "").trim().toLowerCase();

    let statusFilter;
    if (status === "all" || status === undefined || status === null || status === "") {
      statusFilter = "all";
    } else if (Array.isArray(status)) {
      statusFilter = status.map(String);
    } else {
      statusFilter = [String(status)];
    }

    const docs = await Milestone.find({ "milestoneHistory.released": true }).lean();

    let entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => e.released)
        .map((e) => ({
          ...e,
          milestoneHistoryId: String(e._id),
          brandId: String(doc.brandId || ""),
          milestoneId: String(doc._id),
        }))
    );

    if (statusFilter !== "all") {
      entries = entries.filter((e) =>
        statusFilter.includes(String(e.payoutStatus || "initiated"))
      );
    }

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const brandIds = [...new Set(entries.map((e) => String(e.brandId || "")).filter(Boolean))];
    const influencerIds = [...new Set(entries.map((e) => String(e.influencerId || "")).filter(Boolean))];
    const campaignIds = [...new Set(entries.map((e) => String(e.campaignId || "")).filter(Boolean))];

    const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

    const brandObjectIds = brandIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));
    const influencerObjectIds = influencerIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));
    const campaignObjectIds = campaignIds.filter(isValidObjectId).map((id) => new mongoose.Types.ObjectId(id));

    const [brands, influencers, campaigns] = await Promise.all([
      Brand.find(
        {
          $or: [
            { brandId: { $in: brandIds } },
            { _id: { $in: brandObjectIds } },
          ],
        },
        "_id brandId name email companyName"
      ).lean(),
      Influencer.find(
        {
          $or: [
            { influencerId: { $in: influencerIds } },
            { _id: { $in: influencerObjectIds } },
          ],
        },
        "_id influencerId name fullName username email"
      ).lean(),
      Campaign.find(
        {
          $or: [
            { campaignsId: { $in: campaignIds } },
            { _id: { $in: campaignObjectIds } },
          ],
        },
        "_id campaignsId campaignTitle productOrServiceName brandName"
      ).lean(),
    ]);

    const brandMap = new Map();
    brands.forEach((b) => {
      const displayName = b.name || b.companyName || b.email || "Unknown Brand";
      if (b.brandId) brandMap.set(String(b.brandId), displayName);
      if (b._id) brandMap.set(String(b._id), displayName);
    });

    const influencerMap = new Map();
    influencers.forEach((i) => {
      const displayName =
        i.name || i.fullName || i.username || i.email || "Unknown Influencer";

      const value = {
        name: displayName,
        email: i.email || null,
      };

      if (i.influencerId) influencerMap.set(String(i.influencerId), value);
      if (i._id) influencerMap.set(String(i._id), value);
    });

    const campaignMap = new Map();
    campaigns.forEach((c) => {
      const value = {
        title: c.campaignTitle || c.productOrServiceName || "Untitled Campaign",
        brandName: c.brandName || null,
      };

      if (c.campaignsId) campaignMap.set(String(c.campaignsId), value);
      if (c._id) campaignMap.set(String(c._id), value);
    });

    let items = entries.map((e) => {
      const inf = influencerMap.get(String(e.influencerId || "")) || {};
      const campaign = campaignMap.get(String(e.campaignId || "")) || {};

      return {
        milestoneId: e.milestoneId,
        milestoneHistoryId: e.milestoneHistoryId,
        milestoneTitle: e.milestoneTitle || null,
        milestoneDescription: e.milestoneDescription || null,
        brandId: e.brandId,
        brandName: brandMap.get(String(e.brandId || "")) || campaign.brandName || null,
        influencerId: e.influencerId,
        influencerName: inf.name || null,
        influencerEmail: inf.email || null,
        campaignId: e.campaignId,
        campaignTitle: campaign.title || null,
        amount: Number(e.amount || 0),
        payoutStatus: e.payoutStatus || "initiated",
        releasedAt: e.releasedAt || null,
        paidAt: e.paidAt || null,
        createdAt: e.createdAt,
      };
    });

    if (searchText) {
      items = items.filter((item) =>
        [
          item.brandName,
          item.influencerName,
          item.influencerEmail,
          item.campaignTitle,
          item.milestoneTitle,
          item.brandId,
          item.influencerId,
          item.campaignId,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(searchText))
      );
    }

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    const start = (pageNum - 1) * limitNum;
    const pagedItems = items.slice(start, start + limitNum);

    return res.status(200).json({
      message: "Milestone payouts for admin",
      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
      items: pagedItems,
    });
  } catch (err) {
    console.error("Error in adminListPayouts:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "ADMIN_LIST_PAYOUTS_ERROR");return res.status(500).json({ message: "Internal server error" });
  }
};

// ======================================================================
// POST /milestone/adminMarkMilestonePaid
// body: { milestoneId, milestoneHistoryId }
// ======================================================================
exports.adminMarkMilestonePaid = async (req, res) => {
  const { milestoneId, milestoneHistoryId } = req.body;

  if (!milestoneId || !milestoneHistoryId) {
    return res.status(400).json({
      message: "milestoneId and milestoneHistoryId are required.",
    });
  }

  if (!mongoose.Types.ObjectId.isValid(milestoneId)) {
    return res.status(400).json({ message: "Invalid milestoneId." });
  }

  try {
    const doc = await Milestone.findById(milestoneId);
    if (!doc) {
      return res.status(404).json({ message: "Milestone not found." });
    }

    const entry = doc.milestoneHistory.id(milestoneHistoryId);
    if (!entry) {
      return res.status(404).json({ message: "Milestone history entry not found." });
    }

    if (!entry.released) {
      return res.status(400).json({ message: "Milestone not released yet." });
    }

    if (entry.payoutStatus === "paid") {
      return res.status(400).json({
        message: "This milestone is already marked as paid.",
      });
    }

    entry.payoutStatus = "paid";
    entry.paidAt = new Date();

    await doc.save();

    createAndEmit({
      influencerId: entry.influencerId,
      type: "milestone.paid",
      title: `Milestone paid${entry.milestoneTitle ? `: ${entry.milestoneTitle}` : ""}`,
      message: `Your payout of $${Number(entry.amount).toFixed(
        2
      )} has been approved and marked as paid.`,
      entityType: "campaign",
      entityId: String(entry.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) => console.error("notify influencer (paid) failed:", e));

    createAndEmit({
      brandId: doc.brandId,
      type: "milestone.paid",
      title: "Payout completed",
      message: `${entry.milestoneTitle || "Milestone"} of $${Number(
        entry.amount
      ).toFixed(2)} has been marked as paid.`,
      entityType: "campaign",
      entityId: String(entry.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error("notify brand (paid) failed:", e));

    try {
      const [infDoc, brandDoc, campDoc] = await Promise.all([
        Influencer.findOne({ influencerId: entry.influencerId }, "name email").lean(),
        Brand.findOne({ brandId: doc.brandId }, "name").lean(),
        Campaign.findOne(
          { campaignsId: entry.campaignId },
          "productOrServiceName"
        ).lean(),
      ]);

      if (infDoc && infDoc.email) {
        sendMilestonePaidEmail({
          to: infDoc.email,
          influencerName: infDoc.name || "",
          brandName: (brandDoc && brandDoc.name) || "",
          campaignName: (campDoc && campDoc.productOrServiceName) || "",
          milestoneTitle: entry.milestoneTitle,
          amount: entry.amount,
          milestoneDescription: entry.milestoneDescription,
          dashboardUrl: `${APP_BASE_URL}/influencer/my-campaign`,
        }).catch((e) => console.error("sendMilestonePaidEmail failed:", e));
      }
    } catch (emailErr) {
      console.error("Error preparing milestone paid email:", emailErr);
    }

    return res.status(200).json({
      message: "Milestone marked as paid.",
      payoutStatus: entry.payoutStatus,
    });
  } catch (err) {
    console.error("Error in adminMarkMilestonePaid:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "ADMIN_MARK_MILESTONE_PAID_ERROR");return res.status(500).json({ message: "Internal server error." });
  }
};

exports.getPayoutDetailsByInfluencer = async (req, res) => {
  const { influencerId } = req.body;

  if (!influencerId) {
    return res.status(400).json({ message: "influencerId is required" });
  }

  try {
    const docs = await Milestone.find({
      "milestoneHistory.influencerId": String(influencerId),
    }).lean();

    const entries = docs.flatMap((doc) =>
      (doc.milestoneHistory || [])
        .filter((e) => String(e.influencerId) === String(influencerId))
        .map((e) => ({
          campaignId: String(e.campaignId),
          amount: Number(e.amount || 0),
          payoutStatus: e.payoutStatus || (e.released ? "initiated" : "pending"),
          createdAt: e.createdAt,
        }))
    );

    const campaignIds = [
      ...new Set(entries.map((e) => e.campaignId).filter(Boolean)),
    ];

    let campaigns = [];
    if (campaignIds.length) {
      campaigns = await Campaign.find(
        {
          $or: [
            { _id: { $in: campaignIds } },
            { campaignsId: { $in: campaignIds } },
          ],
        },
        "_id campaignsId campaignTitle title productOrServiceName"
      ).lean();
    }

    const campaignMap = new Map();
    campaigns.forEach((camp) => {
      const title =
        camp.campaignTitle || camp.title || camp.productOrServiceName || "";

      if (camp._id) {
        campaignMap.set(String(camp._id), title);
      }
      if (camp.campaignsId) {
        campaignMap.set(String(camp.campaignsId), title);
      }
    });

    const payoutList = entries
      .map((e) => ({
        campaignId: e.campaignId,
        campaignTitle: campaignMap.get(String(e.campaignId)) || "",
        amount: e.amount,
        payoutStatus: e.payoutStatus,
        createdAt: e.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      message: "Payout details fetched successfully",
      influencerId,
      payouts: payoutList,
    });
  } catch (err) {
    console.error("Error in getPayoutDetailsByInfluencer:", err);
    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "GET_PAYOUT_DETAILS_BY_INFLUENCER_ERROR");return res.status(500).json({ message: "Internal server error" });
  }
};




const normalizeObjectIdString = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (value?._id) return normalizeObjectIdString(value._id);
  return String(value || "");
};

const isDeliverableSubmittedForMilestone = (deliverable) => {
  const status = String(deliverable?.status || "").trim().toLowerCase();

  if (["revision", "pending", "draft_submitted"].includes(status)) {
    return false;
  }

  const links = Array.isArray(deliverable?.deliverableLinks)
    ? deliverable.deliverableLinks.filter((item) => clean(item?.url)).length
    : 0;

  return (
    ["submitted", "approved", "completed", "complete", "paid"].some((item) =>
      status.includes(item)
    ) && links > 0
  );
};

const isDeliverableApprovedForRelease = (deliverable) => {
  const status = String(deliverable?.status || "").trim().toLowerCase();
  if (status !== "approved") return false;

  const revisions = Array.isArray(deliverable?.revisions)
    ? deliverable.revisions
    : [];

  return revisions.every((revision) => {
    const revisionStatus = String(revision?.status || "").trim().toLowerCase();
    return revisionStatus === "approved" || revisionStatus === "";
  });
};

const canSubmitMilestoneHistory = (milestoneHistory = {}) => {
  const deliverables = Array.isArray(milestoneHistory.deliverables)
    ? milestoneHistory.deliverables
    : [];

  return deliverables.length > 0 && deliverables.every(isDeliverableSubmittedForMilestone);
};

const areAllDeliverablesApprovedForRelease = (milestoneHistory = {}) => {
  const deliverables = Array.isArray(milestoneHistory.deliverables)
    ? milestoneHistory.deliverables
    : [];

  return deliverables.length > 0 && deliverables.every(isDeliverableApprovedForRelease);
};

const hasMilestoneBeenSubmittedByInfluencer = (milestoneHistory = {}) => {
  const submissionStatus = String(
    milestoneHistory?.submissionStatus || milestoneHistory?.milestoneSubmissionStatus || ""
  )
    .trim()
    .toLowerCase();

  const status = String(milestoneHistory?.status || "").trim().toLowerCase();

  return Boolean(
    milestoneHistory?.isMilestoneSubmitted === true ||
      submissionStatus === "submitted" ||
      submissionStatus === "milestone_submitted" ||
      status === "submitted" ||
      milestoneHistory?.milestoneSubmittedAt ||
      milestoneHistory?.submittedAt ||
      clean(milestoneHistory?.submittedByInfluencerId)
  );
};

const resetMilestoneSubmissionAfterRevision = (milestoneHistory = {}) => {
  milestoneHistory.status = "revision";
  milestoneHistory.submissionStatus = "pending";
  milestoneHistory.milestoneSubmissionStatus = "pending";
  milestoneHistory.isMilestoneSubmitted = false;
  milestoneHistory.submittedAt = null;
  milestoneHistory.milestoneSubmittedAt = null;
  milestoneHistory.submittedByInfluencerId = "";
};

const markMilestoneReadyForBrandReview = (milestoneHistory = {}) => {
  if (hasMilestoneBeenSubmittedByInfluencer(milestoneHistory)) return;

  milestoneHistory.status = "ready_for_brand_review";
  milestoneHistory.submissionStatus = "pending";
  milestoneHistory.milestoneSubmissionStatus = "pending";
  milestoneHistory.isMilestoneSubmitted = false;
  milestoneHistory.submittedAt = null;
  milestoneHistory.milestoneSubmittedAt = null;
  milestoneHistory.submittedByInfluencerId = "";
};

const syncMilestoneStatusAfterApproval = (milestoneHistory = {}) => {
  const allApproved = areAllDeliverablesApprovedForRelease(milestoneHistory);

  if (allApproved && hasMilestoneBeenSubmittedByInfluencer(milestoneHistory)) {
    milestoneHistory.status = "approved";
    return;
  }

  if (canSubmitMilestoneHistory(milestoneHistory) && !hasMilestoneBeenSubmittedByInfluencer(milestoneHistory)) {
    milestoneHistory.status = "ready_for_brand_review";
  }
};

const mapRevisionForResponse = (revision, fallbackDeliverableId = "") => ({
  revisionId: String(revision?._id || ""),
  deliverableId: String(revision?.deliverableId || fallbackDeliverableId || ""),
  issueName: revision?.issueName || "",
  revisionType: revision?.revisionType || "free",
  revisionBudget: Number(revision?.revisionBudget || 0),
  deliveryName: revision?.deliveryName || "",
  issueDeliverableLink: revision?.issueDeliverableLink || "",
  notes: revision?.notes || "",
  attachments: revision?.attachments || [],
  submissionDate: revision?.submissionDate || null,
  status: revision?.status || "pending",
  submittedAt: revision?.submittedAt || null,
  approvedAt: revision?.approvedAt || null,
  approvedRole: revision?.approvedRole || "",
  approvalId: revision?.approvalId || "",
  comments: revision?.comments || "",
  raisedByRole: revision?.raisedByRole || "Brand",
  raisedAt: revision?.raisedAt || null,
  createdAt: revision?.createdAt || null,
  updatedAt: revision?.updatedAt || null,
});

const mapDeliverableForResponse = (item, milestoneDoc, milestoneHistory) => ({
  deliverableId: String(item._id),

  milestoneId: String(milestoneDoc._id),
  milestoneHistoryId: String(milestoneHistory._id),

  brandId: String(milestoneDoc.brandId || ""),
  influencerId: String(milestoneHistory.influencerId || ""),
  campaignId: String(milestoneHistory.campaignId || ""),

  milestoneTitle: milestoneHistory.milestoneTitle || "",
  milestoneDescription: milestoneHistory.milestoneDescription || "",
  milestoneBudget: Number(milestoneHistory.milestoneBudget || milestoneHistory.amount || 0),
  amount: Number(milestoneHistory.amount || milestoneHistory.milestoneBudget || 0),
  milestoneStatus: milestoneHistory.status || milestoneHistory.payoutStatus || "pending",
  canSubmitMilestone: canSubmitMilestoneHistory(milestoneHistory),
  canReleaseMilestone:
    hasMilestoneBeenSubmittedByInfluencer(milestoneHistory) &&
    areAllDeliverablesApprovedForRelease(milestoneHistory),
  isMilestoneSubmitted: hasMilestoneBeenSubmittedByInfluencer(milestoneHistory),

  deliverableName: item.deliverableName || "",
  title: item.deliverableName || "",

  deliveries: item.deliveries || [],
  aspectRatio: item.aspectRatio || "",
  platforms: item.platforms || [],
  quantity: item.quantity || 1,

  deliverableLinks: Array.isArray(item.deliverableLinks)
    ? item.deliverableLinks.map((link) => ({
        linkId: String(link._id || ""),
        label: link.label || "",
        url: link.url || "",
      }))
    : [],

  submissionName: item.submissionName || item.deliverableName || "",
  submissionNotes: item.submissionNotes || item.additionalNotes || item.comments || "",
  additionalNotes: item.additionalNotes || item.submissionNotes || item.comments || "",
  submittedAt: item.submittedAt || null,
  submittedByInfluencerId: item.submittedByInfluencerId || "",
  hasSubmittedDeliverable: isDeliverableSubmittedForMilestone(item),
  deliverableSubmissionVisible: isDeliverableSubmittedForMilestone(item),

  draftRequired: Boolean(item.draftRequired || item.needDraftFirst || item.requiresDraft || item.preShootScriptRequired),
  needDraftFirst: Boolean(item.needDraftFirst || item.draftRequired),
  requiresDraft: Boolean(item.requiresDraft || item.draftRequired),
  draftDue: item.draftDue || item.draftDate || null,
  draftDate: item.draftDate || item.draftDue || null,
  draftLinks: Array.isArray(item.draftLinks)
    ? item.draftLinks.map((link) => ({
        linkId: String(link._id || ""),
        label: link.label || "",
        url: link.url || "",
      }))
    : [],
  draftNotes: item.draftNotes || "",
  draftSubmittedAt: item.draftSubmittedAt || null,

  preShootScriptRequired: Boolean(item.preShootScriptRequired),
  preShootScriptDue: item.preShootScriptDue || null,
  preShootScriptLinks: Array.isArray(item.preShootScriptLinks)
    ? item.preShootScriptLinks.map((link) => ({
        linkId: String(link._id || ""),
        label: link.label || "",
        url: link.url || "",
      }))
    : [],

  contentSpecification: item.contentSpecification || "",
  liveDate: item.liveDate || null,

  status: item.status || "pending",
  submittedStatus: item.status || "pending",

  comments: item.comments || "",
  approvedRole: item.approvedRole || "",
  approvalId: item.approvalId || "",
  approvedAt: item.approvedAt || null,
  revisionRequestedAt: item.revisionRequestedAt || null,

  revisions: Array.isArray(item.revisions)
    ? item.revisions.map((revision) => mapRevisionForResponse(revision, item._id))
    : [],

  createdAt: item.createdAt || null,
  updatedAt: item.updatedAt || null,
});

const mapMilestoneHistoryForResponse = (milestoneDoc, milestoneHistory) => ({
  milestoneId: String(milestoneDoc._id),
  milestoneHistoryId: String(milestoneHistory._id),
  brandId: String(milestoneDoc.brandId || ""),
  influencerId: String(milestoneHistory.influencerId || ""),
  campaignId: String(milestoneHistory.campaignId || ""),
  contractId: milestoneHistory.contractId || "",
  contractMongoId: milestoneHistory.contractMongoId || null,
  adminId: milestoneHistory.adminId ? String(milestoneHistory.adminId) : "",
  createdByRole: milestoneHistory.createdByRole || "",
  createdByModel: milestoneHistory.createdByModel || "",
  milestoneTitle: milestoneHistory.milestoneTitle || "",
  milestoneName: milestoneHistory.milestoneTitle || "",
  title: milestoneHistory.milestoneTitle || "",
  name: milestoneHistory.milestoneTitle || "",
  milestoneDescription: milestoneHistory.milestoneDescription || "",
  description: milestoneHistory.milestoneDescription || "",
  milestoneBudget: Number(milestoneHistory.milestoneBudget || milestoneHistory.amount || 0),
  amount: Number(milestoneHistory.amount || milestoneHistory.milestoneBudget || 0),
  budget: Number(milestoneHistory.milestoneBudget || milestoneHistory.amount || 0),
  attachments: milestoneHistory.attachments || [],
  deliverables: Array.isArray(milestoneHistory.deliverables)
    ? milestoneHistory.deliverables.map((item) => mapDeliverableForResponse(item, milestoneDoc, milestoneHistory))
    : [],
  deliverablesCount: Array.isArray(milestoneHistory.deliverables)
    ? milestoneHistory.deliverables.length
    : 0,
  startDate: milestoneHistory.startDate || null,
  endDate: milestoneHistory.endDate || null,
  dueDate: milestoneHistory.endDate || null,
  deadline: milestoneHistory.endDate || null,
  graceDays: Number(milestoneHistory.graceDays || 0),
  submissionLink: milestoneHistory.submissionLink || "",
  needDraftFirst: Boolean(milestoneHistory.needDraftFirst),
  draftDate: milestoneHistory.draftDate || null,
  isAccepted: milestoneHistory.isAccepted || 0,
  status: milestoneHistory.status || "pending",
  submissionStatus: milestoneHistory.submissionStatus || "pending",
  milestoneSubmissionStatus: milestoneHistory.milestoneSubmissionStatus || "pending",
  isMilestoneSubmitted: hasMilestoneBeenSubmittedByInfluencer(milestoneHistory),
  submittedAt: milestoneHistory.submittedAt || null,
  milestoneSubmittedAt: milestoneHistory.milestoneSubmittedAt || null,
  submittedByInfluencerId: milestoneHistory.submittedByInfluencerId || "",
  canSubmitMilestone: canSubmitMilestoneHistory(milestoneHistory),
  canReleaseMilestone:
    hasMilestoneBeenSubmittedByInfluencer(milestoneHistory) &&
    areAllDeliverablesApprovedForRelease(milestoneHistory),
  released: Boolean(milestoneHistory.released),
  releasedAt: milestoneHistory.releasedAt || null,
  payoutStatus: milestoneHistory.payoutStatus || "pending",
  paidAt: milestoneHistory.paidAt || null,
  createdAt: milestoneHistory.createdAt || null,
  updatedAt: milestoneHistory.updatedAt || null,
});

// ======================================================================
// POST /milestone/getAllDeliverables
// body: { milestoneId, milestoneHistoryId }
// ======================================================================
exports.getAllDeliverablesByMilestone = async (req, res) => {
  try {
    const { milestoneId, milestoneHistoryId } = req.body || {};

    if (!milestoneId || !milestoneHistoryId) {
      return res.status(400).json({
        success: false,
        message: "milestoneId and milestoneHistoryId are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(milestoneId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid milestoneId",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(milestoneHistoryId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid milestoneHistoryId",
      });
    }

    const milestoneDoc = await Milestone.findById(milestoneId).lean();

    if (!milestoneDoc) {
      return res.status(404).json({
        success: false,
        message: "Milestone not found",
      });
    }

    const milestoneHistory = (milestoneDoc.milestoneHistory || []).find(
      (item) => String(item._id) === String(milestoneHistoryId)
    );

    if (!milestoneHistory) {
      return res.status(404).json({
        success: false,
        message: "Milestone history not found",
      });
    }

    const data = (milestoneHistory.deliverables || []).map((item) =>
      mapDeliverableForResponse(item, milestoneDoc, milestoneHistory)
    );

    const submittedCount = data.filter((item) => item.hasSubmittedDeliverable).length;
    const canSubmitMilestone = data.length > 0 && submittedCount === data.length;

    return res.status(200).json({
      success: true,
      message: "Deliverables fetched successfully by milestone.",
      total: data.length,
      count: data.length,
      submittedCount,
      pendingCount: Math.max(0, data.length - submittedCount),
      canSubmitMilestone,
      data,
      filters: {
        milestoneId: String(milestoneDoc._id),
        milestoneHistoryId: String(milestoneHistory._id),
      },
    });
  } catch (err) {
    console.error("Error in getAllDeliverablesByMilestone:", err);

    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "GET_ALL_DELIVERABLES_BY_MILESTONE_ERROR");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};


exports.addRevision = async (req, res) => {
  const session = await mongoose.startSession();

  const abort = (status, message, extra = {}) => {
    const err = new Error(message);
    err.status = status;
    err.extra = extra;
    throw err;
  };

  try {
    const {
      milestoneId,
      milestoneHistoryId,
      deliverableId,

      issueName,
      revisionType = "free",
      revisionBudget = 0,
      deliveryName,
      issueDeliverableLink,
      notes = "",
      attachments = [],
      productImages = [],
      references = [],
      submissionDate,
      raisedByRole = "Brand",
    } = req.body || {};

    if (!milestoneId || !milestoneHistoryId || !deliverableId) {
      return res.status(400).json({
        success: false,
        message:
          "milestoneId, milestoneHistoryId and deliverableId are required",
      });
    }

    if (!issueName || !clean(issueName)) {
      return res.status(400).json({
        success: false,
        message: "issueName is required",
      });
    }

    if (!["free", "paid"].includes(String(revisionType).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "revisionType must be either free or paid",
      });
    }

    const normalizedRevisionType = String(revisionType).toLowerCase();

    const revisionBudgetNum =
      normalizedRevisionType === "paid" ? Number(revisionBudget) : 0;

    if (
      normalizedRevisionType === "paid" &&
      (!Number.isFinite(revisionBudgetNum) || revisionBudgetNum <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "revisionBudget is required when revisionType is paid",
      });
    }

    if (!deliveryName || !clean(deliveryName)) {
      return res.status(400).json({
        success: false,
        message: "deliveryName is required",
      });
    }

    if (!issueDeliverableLink || !clean(issueDeliverableLink)) {
      return res.status(400).json({
        success: false,
        message: "issueDeliverableLink is required",
      });
    }

    const parsedSubmissionDate = toDateOrNull(submissionDate);

    if (!parsedSubmissionDate) {
      return res.status(400).json({
        success: false,
        message: "submissionDate is required",
      });
    }

    const normalizedAttachments = normalizeAttachments([
      ...toArray(attachments),
      ...toArray(productImages),
      ...toArray(references),
    ]);

    let responsePayload = null;
    let walletPayload = null;

    await session.withTransaction(async () => {
      const milestoneDoc = await Milestone.findById(milestoneId).session(
        session
      );

      if (!milestoneDoc) {
        abort(404, "Milestone not found");
      }

      const milestoneHistory =
        milestoneDoc.milestoneHistory.id(milestoneHistoryId);

      if (!milestoneHistory) {
        abort(404, "Milestone history not found");
      }

      const deliverable = milestoneHistory.deliverables.id(deliverableId);

      if (!deliverable) {
        abort(404, "Deliverable not found");
      }

      if (milestoneHistory.released === true) {
        abort(400, "Released milestone cannot be revised.");
      }

      if (String(milestoneHistory.payoutStatus || "pending") !== "pending") {
        abort(400, "Milestone payout is already initiated. Revision cannot be raised.");
      }

      const contractOr = [];

      if (milestoneHistory.contractMongoId) {
        contractOr.push({ _id: milestoneHistory.contractMongoId });
      }

      if (milestoneHistory.contractId) {
        contractOr.push({ contractId: String(milestoneHistory.contractId) });
      }

      let contractDoc = null;
      let isUploadedContractFlow = false;

      if (contractOr.length > 0) {
        contractDoc = await Contract.findOne({
          $or: contractOr,
        }).session(session);
      }

      if (!contractDoc) {
        contractDoc = await Contract.findOne({
          brandId: milestoneDoc.brandId,
          influencerId: milestoneHistory.influencerId,
          campaignId: milestoneHistory.campaignId,
        })
          .sort({ createdAt: -1 })
          .session(session);
      }

      if (!contractDoc) {
        abort(400, "Contract not found for this milestone");
      }

      isUploadedContractFlow = isUploadedContractSource(contractDoc);

      let influencerBudget = 0;

      if (!isUploadedContractFlow) {
        const commercial = contractDoc?.content?.scheduleA?.commercial || {};

        influencerBudget = getFirstPositiveNumber(
          commercial?.totalCampaignFee,
          commercial?.influencerBudget,
          commercial?.feeAmount,
          contractDoc?.totalCampaignFee,
          contractDoc?.feeAmount,
          contractDoc?.influencerBudget,
          contractDoc?.amount
        );

        if (!influencerBudget) {
          abort(
            400,
            "Influencer budget not found in contract. Please update the contract amount first."
          );
        }
      }

      const currentMilestoneBudget = Number(
        milestoneHistory.milestoneBudget || milestoneHistory.amount || 0
      );

      const usedMilestoneBudgetBefore = (milestoneDoc.milestoneHistory || [])
        .filter(
          (entry) =>
            sameId(entry.influencerId, milestoneHistory.influencerId) &&
            sameId(entry.campaignId, milestoneHistory.campaignId)
        )
        .reduce(
          (sum, entry) =>
            sum + (Number(entry.milestoneBudget) || Number(entry.amount) || 0),
          0
        );

      const remainingInfluencerBudgetBefore = isUploadedContractFlow
        ? null
        : Math.max(0, influencerBudget - usedMilestoneBudgetBefore);

      if (
        !isUploadedContractFlow &&
        normalizedRevisionType === "paid" &&
        revisionBudgetNum > remainingInfluencerBudgetBefore
      ) {
        abort(
          400,
          "Revision budget cannot be greater than remaining influencer budget.",
          {
            influencerBudget,
            usedMilestoneBudget: usedMilestoneBudgetBefore,
            remainingBudget: remainingInfluencerBudgetBefore,
            requestedRevisionBudget: revisionBudgetNum,
          }
        );
      }

      milestoneHistory.contractSource = milestoneHistory.contractSource || getContractSourceType(contractDoc);
      milestoneHistory.isUploadedContract = Boolean(
        milestoneHistory.isUploadedContract || isUploadedContractFlow
      );

      if (normalizedRevisionType === "paid") {
        const wallet = await getOrCreateBrandWallet(
          milestoneDoc.brandId,
          session
        );

        const walletSnapBefore = syncUsableBalance(wallet);

        if (Number(walletSnapBefore.walletBalance || 0) < revisionBudgetNum) {
          const needToAdd = Math.max(
            0,
            revisionBudgetNum - Number(walletSnapBefore.walletBalance || 0)
          );

          abort(
            402,
            "Insufficient brand wallet balance. Please top up the remaining amount to raise revision.",
            {
              walletBalance: walletSnapBefore.walletBalance,
              escrowBalance: walletSnapBefore.escrowBalance,
              frozenBalance: walletSnapBefore.frozenBalance,
              usableBalance: walletSnapBefore.usableBalance,
              requiredAmount: revisionBudgetNum,
              needToAdd,
              requestedRevisionBudget: revisionBudgetNum,
            }
          );
        }

        const updatedMilestoneBudget =
          currentMilestoneBudget + revisionBudgetNum;

        milestoneHistory.milestoneBudget = updatedMilestoneBudget;
        milestoneHistory.amount = updatedMilestoneBudget;

        milestoneDoc.totalAmount =
          Number(milestoneDoc.totalAmount || 0) + revisionBudgetNum;

        const walletSnapAfter = moveAmountToEscrow(wallet, {
          amount: revisionBudgetNum,
          type: "milestone_escrow_adjustment",
          brandId: milestoneDoc.brandId,
          campaignId: milestoneHistory.campaignId,
          influencerId: milestoneHistory.influencerId,
          contractId: milestoneHistory.contractId || "",
          milestoneId: String(milestoneDoc._id),
          milestoneHistoryId: String(milestoneHistory._id),
          milestoneTitle: milestoneHistory.milestoneTitle || "",
          note: "Paid revision raised; revision amount moved from brand wallet to escrow.",
        });

        await wallet.save({ session });

        walletPayload = {
          wallet: {
            walletBalance: walletSnapAfter.walletBalance,
            escrowBalance: walletSnapAfter.escrowBalance,
            frozenBalance: walletSnapAfter.frozenBalance,
            usableBalance: walletSnapAfter.usableBalance,
          },
          escrow: {
            amountMovedToEscrow: revisionBudgetNum,
            escrowBalance: walletSnapAfter.escrowBalance,
          },
        };
      }

      deliverable.revisions.push({
        deliverableId: deliverable._id,

        issueName: clean(issueName),
        revisionType: normalizedRevisionType,
        revisionBudget: revisionBudgetNum,

        deliveryName: clean(deliveryName),
        issueDeliverableLink: clean(issueDeliverableLink),
        notes: clean(notes),

        attachments: normalizedAttachments,
        submissionDate: parsedSubmissionDate,

        status: "pending",
        raisedByRole,
        raisedAt: new Date(),
      });

      deliverable.status = "revision";
      deliverable.revisionRequestedAt = new Date();
      deliverable.comments = clean(notes) || deliverable.comments || "";
      resetMilestoneSubmissionAfterRevision(milestoneHistory);
      milestoneDoc.markModified("milestoneHistory");

      await milestoneDoc.save({ session });

      const createdRevision =
        deliverable.revisions[deliverable.revisions.length - 1];

      const updatedMilestoneBudget = Number(
        milestoneHistory.milestoneBudget || milestoneHistory.amount || 0
      );

      const usedMilestoneBudgetAfter =
        usedMilestoneBudgetBefore + revisionBudgetNum;

      responsePayload = {
        success: true,
        message:
          normalizedRevisionType === "paid"
            ? "Paid revision raised and added to milestone budget successfully"
            : "Revision raised successfully",

        milestoneId: String(milestoneDoc._id),
        milestoneHistoryId: String(milestoneHistory._id),
        deliverableId: String(deliverable._id),

        revision: {
          revisionId: String(createdRevision._id),
          deliverableId: String(createdRevision.deliverableId),

          issueName: createdRevision.issueName,
          revisionType: createdRevision.revisionType,
          revisionBudget: createdRevision.revisionBudget,

          deliveryName: createdRevision.deliveryName,
          issueDeliverableLink: createdRevision.issueDeliverableLink,
          notes: createdRevision.notes,

          attachments: createdRevision.attachments,
          submissionDate: createdRevision.submissionDate,

          status: createdRevision.status,
          raisedByRole: createdRevision.raisedByRole,
          raisedAt: createdRevision.raisedAt,

          createdAt: createdRevision.createdAt,
          updatedAt: createdRevision.updatedAt,
        },

        deliverable: mapDeliverableForResponse(deliverable, milestoneDoc, milestoneHistory),

        milestone: {
          ...mapMilestoneHistoryForResponse(milestoneDoc, milestoneHistory),
          milestoneBudget: updatedMilestoneBudget,
          amount: updatedMilestoneBudget,
          addedRevisionBudget:
            normalizedRevisionType === "paid" ? revisionBudgetNum : 0,
        },

        budget: {
          influencerBudget,
          usedMilestoneBudgetBefore,
          usedMilestoneBudgetAfter,
          remainingBudget: isUploadedContractFlow
            ? null
            : normalizedRevisionType === "paid"
              ? Math.max(0, influencerBudget - usedMilestoneBudgetAfter)
              : remainingInfluencerBudgetBefore,
          requestedRevisionBudget: revisionBudgetNum,
          contractSource: getContractSourceType(contractDoc),
        },

        wallet: walletPayload?.wallet || null,
        campaignWallet: walletPayload?.campaignWallet || null,
      };
    });

    session.endSession();

    return res.status(201).json(responsePayload);
  } catch (err) {
    await session.abortTransaction().catch(() => { });
    session.endSession();

    console.error("Error in addRevision:", err);

    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "ADD_REVISION_ERROR");if (err.status) {
      return res.status(err.status).json({
        success: false,
        message: err.message,
        ...(err.extra || {}),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};


exports.submitDeliverable = async (req, res) => {
  try {
    const {
      influencerId,
      milestoneId,
      milestoneHistoryId,
      deliverableId,
      revisionId,
      deliverableLinks,
      submissionType = "final",
      submissionName = "",
      notes = "",
      additionalNotes = "",
    } = req.body || {};

    const normalizedSubmissionType = String(submissionType || "final").toLowerCase() === "draft" ? "draft" : "final";

    if (!influencerId) {
      return res.status(400).json({ success: false, message: "influencerId is required" });
    }

    if (!milestoneId) {
      return res.status(400).json({ success: false, message: "milestoneId is required" });
    }

    if (!milestoneHistoryId) {
      return res.status(400).json({ success: false, message: "milestoneHistoryId is required" });
    }

    if (!deliverableId) {
      return res.status(400).json({ success: false, message: "deliverableId is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(String(milestoneId))) {
      return res.status(400).json({ success: false, message: "Invalid milestoneId" });
    }

    if (!mongoose.Types.ObjectId.isValid(String(milestoneHistoryId))) {
      return res.status(400).json({ success: false, message: "Invalid milestoneHistoryId" });
    }

    if (!mongoose.Types.ObjectId.isValid(String(deliverableId))) {
      return res.status(400).json({ success: false, message: "Invalid deliverableId" });
    }

    if (revisionId && !mongoose.Types.ObjectId.isValid(String(revisionId))) {
      return res.status(400).json({ success: false, message: "Invalid revisionId" });
    }

    const normalizedLinks = normalizeDeliverableLinks(
      Array.isArray(deliverableLinks) ? deliverableLinks : []
    );

    if (!normalizedLinks.length) {
      return res.status(400).json({
        success: false,
        message: "At least one deliverable link is required",
      });
    }

    const milestoneDoc = await Milestone.findById(milestoneId);

    if (!milestoneDoc) {
      return res.status(404).json({ success: false, message: "Milestone not found" });
    }

    const milestoneHistory = milestoneDoc.milestoneHistory.id(milestoneHistoryId);

    if (!milestoneHistory) {
      return res.status(404).json({ success: false, message: "Milestone history not found" });
    }

    if (String(milestoneHistory.influencerId) !== String(influencerId)) {
      return res.status(403).json({
        success: false,
        message: "This deliverable does not belong to this influencer",
      });
    }

    const deliverable = milestoneHistory.deliverables.id(deliverableId);

    if (!deliverable) {
      return res.status(404).json({ success: false, message: "Deliverable not found" });
    }

    if (String(deliverable.status || "").toLowerCase() === "approved" && normalizedSubmissionType === "final") {
      return res.status(400).json({
        success: false,
        message: "Approved deliverable cannot be submitted again",
      });
    }

    if (normalizedSubmissionType === "draft") {
      const draftAllowed = Boolean(
        deliverable.draftRequired ||
          deliverable.needDraftFirst ||
          deliverable.requiresDraft ||
          deliverable.preShootScriptRequired ||
          milestoneHistory.needDraftFirst
      );

      if (!draftAllowed) {
        return res.status(400).json({
          success: false,
          message: "Draft submission is not required for this deliverable.",
        });
      }

      deliverable.draftLinks = normalizedLinks;
      deliverable.draftNotes = clean(notes || additionalNotes);
      deliverable.draftSubmittedAt = new Date();
      deliverable.submissionName = clean(submissionName) || deliverable.deliverableName;

      if (!["submitted", "approved"].includes(String(deliverable.status || "").toLowerCase())) {
        deliverable.status = "draft_submitted";
      }

      await milestoneDoc.save();

      return res.status(200).json({
        success: true,
        message: "Draft submitted successfully",
        milestoneId: String(milestoneDoc._id),
        milestoneHistoryId: String(milestoneHistory._id),
        deliverableId: String(deliverable._id),
        milestone: mapMilestoneHistoryForResponse(milestoneDoc, milestoneHistory),
        deliverable: mapDeliverableForResponse(deliverable, milestoneDoc, milestoneHistory),
      });
    }

    const requiredLinks = Math.max(1, Number(deliverable.quantity || 1));

    if (normalizedLinks.length !== requiredLinks) {
      return res.status(400).json({
        success: false,
        message: `Please submit exactly ${requiredLinks} deliverable link${
          requiredLinks === 1 ? "" : "s"
        }.`,
      });
    }

    const previousDeliverableStatus = String(deliverable.status || "").toLowerCase();
    const isRevisionSubmission = previousDeliverableStatus === "revision";

    let updatedRevision = null;

    if (isRevisionSubmission) {
      const revisions = Array.isArray(deliverable.revisions) ? deliverable.revisions : [];

      if (revisionId) {
        updatedRevision = deliverable.revisions.id(revisionId) || null;
      } else {
        updatedRevision = [...revisions]
          .reverse()
          .find((item) => ["pending", "revision"].includes(String(item.status || "").toLowerCase())) || null;
      }

      if (updatedRevision) {
        updatedRevision.status = "submitted";
        updatedRevision.submittedAt = new Date();
      }
    }

    deliverable.deliverableLinks = normalizedLinks;
    deliverable.submissionName = clean(submissionName) || deliverable.deliverableName;
    deliverable.submissionNotes = clean(notes || additionalNotes);
    deliverable.additionalNotes = clean(additionalNotes || notes);
    deliverable.status = "submitted";
    deliverable.submittedAt = new Date();
    deliverable.submittedByInfluencerId = String(influencerId);

    const allSubmitted = canSubmitMilestoneHistory(milestoneHistory);
    if (allSubmitted && !hasMilestoneBeenSubmittedByInfluencer(milestoneHistory)) {
      markMilestoneReadyForBrandReview(milestoneHistory);
    }

    milestoneDoc.markModified("milestoneHistory");
    await milestoneDoc.save();

    return res.status(200).json({
      success: true,
      message: isRevisionSubmission
        ? "Revision deliverable submitted successfully"
        : "Deliverable submitted successfully",
      milestoneId: String(milestoneDoc._id),
      milestoneHistoryId: String(milestoneHistory._id),
      deliverableId: String(deliverable._id),
      revisionId: updatedRevision?._id ? String(updatedRevision._id) : "",
      canSubmitMilestone: canSubmitMilestoneHistory(milestoneHistory),
      milestone: mapMilestoneHistoryForResponse(milestoneDoc, milestoneHistory),
      deliverable: mapDeliverableForResponse(deliverable, milestoneDoc, milestoneHistory),
    });
  } catch (err) {
    console.error("Error in submitDeliverable:", err);

    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "SUBMIT_DELIVERABLE_ERROR");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

exports.approveDeliverable = async (req, res) => {
  try {
    const {
      deliverableId,
      milestoneId,
      milestoneHistoryId,
      comments = "",
      approvedRole = "Brand",
      approvalId = "",
    } = req.body || {};

    if (!deliverableId) {
      return res.status(400).json({
        success: false,
        message: "deliverableId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(deliverableId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid deliverableId",
      });
    }

    if (milestoneId && !mongoose.Types.ObjectId.isValid(String(milestoneId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid milestoneId",
      });
    }

    if (
      milestoneHistoryId &&
      !mongoose.Types.ObjectId.isValid(String(milestoneHistoryId))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid milestoneHistoryId",
      });
    }

    const query = milestoneId
      ? { _id: milestoneId, "milestoneHistory.deliverables._id": deliverableId }
      : { "milestoneHistory.deliverables._id": deliverableId };

    const milestoneDoc = await Milestone.findOne(query);

    if (!milestoneDoc) {
      return res.status(404).json({
        success: false,
        message: "Deliverable not found",
      });
    }

    let milestoneHistory = null;
    let deliverable = null;

    for (const history of milestoneDoc.milestoneHistory || []) {
      if (
        milestoneHistoryId &&
        String(history._id) !== String(milestoneHistoryId)
      ) {
        continue;
      }

      const foundDeliverable = history.deliverables.id(deliverableId);

      if (foundDeliverable) {
        milestoneHistory = history;
        deliverable = foundDeliverable;
        break;
      }
    }

    if (!milestoneHistory || !deliverable) {
      return res.status(404).json({
        success: false,
        message: "Deliverable not found in milestone history",
      });
    }

    const currentStatus = String(deliverable.status || "").toLowerCase();

    if (currentStatus === "approved") {
      return res.status(400).json({
        success: false,
        message: "Deliverable is already approved",
      });
    }

    if (currentStatus !== "submitted") {
      return res.status(400).json({
        success: false,
        message: "Only submitted deliverables can be approved",
      });
    }

    deliverable.status = "approved";
    deliverable.approvedAt = new Date();
    deliverable.approvedRole = approvedRole;
    deliverable.approvalId = approvalId;
    deliverable.comments = comments || deliverable.comments || "";

    const submittedRevision = Array.isArray(deliverable.revisions)
      ? [...deliverable.revisions]
          .reverse()
          .find(
            (revision) =>
              String(revision.status || "").toLowerCase() === "submitted"
          )
      : null;

    if (submittedRevision) {
      submittedRevision.status = "approved";
      submittedRevision.approvedAt = new Date();
      submittedRevision.approvedRole = approvedRole;
      submittedRevision.approvalId = approvalId;
      submittedRevision.comments = comments || submittedRevision.comments || "";
    }

    syncMilestoneStatusAfterApproval(milestoneHistory);
    milestoneDoc.markModified("milestoneHistory");
    await milestoneDoc.save();

    return res.status(200).json({
      success: true,
      message: submittedRevision
        ? "Revision deliverable approved successfully"
        : "Deliverable approved successfully",
      milestoneId: String(milestoneDoc._id),
      milestoneHistoryId: String(milestoneHistory._id),
      deliverableId: String(deliverable._id),
      milestone: mapMilestoneHistoryForResponse(milestoneDoc, milestoneHistory),
      deliverable: mapDeliverableForResponse(deliverable, milestoneDoc, milestoneHistory),
    });
  } catch (err) {
    console.error("Error in approveDeliverable:", err);

    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "APPROVE_DELIVERABLE_ERROR");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

exports.acceptMilestoneByInfluencer = async (req, res) => {
  try {
    const { milestoneId, milestoneHistoryId, influencerId } = req.body || {};

    if (!milestoneId || !milestoneHistoryId || !influencerId) {
      return res.status(400).json({
        success: false,
        message: "milestoneId, milestoneHistoryId and influencerId are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(milestoneId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid milestoneId",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(milestoneHistoryId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid milestoneHistoryId",
      });
    }

    const milestoneDoc = await Milestone.findById(milestoneId);

    if (!milestoneDoc) {
      return res.status(404).json({
        success: false,
        message: "Milestone not found",
      });
    }

    const milestoneHistory = milestoneDoc.milestoneHistory.id(milestoneHistoryId);

    if (!milestoneHistory) {
      return res.status(404).json({
        success: false,
        message: "Milestone history not found",
      });
    }

    if (!sameId(milestoneHistory.influencerId, influencerId)) {
      return res.status(403).json({
        success: false,
        message: "This milestone does not belong to this influencer",
      });
    }

    if (Number(milestoneHistory.isAccepted || 0) === 1) {
      return res.status(400).json({
        success: false,
        message: "Milestone is already accepted",
      });
    }

    if (milestoneHistory.released === true) {
      return res.status(400).json({
        success: false,
        message: "Released milestone cannot be accepted again",
      });
    }

    if (String(milestoneHistory.payoutStatus || "pending") !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Milestone payout is already initiated",
      });
    }

    milestoneHistory.isAccepted = 1;

    await milestoneDoc.save();

    createAndEmit({
      brandId: milestoneDoc.brandId,
      type: "milestone.accepted",
      title: `Milestone accepted: ${milestoneHistory.milestoneTitle || "Milestone"}`,
      message: "Influencer has accepted the milestone.",
      entityType: "campaign",
      entityId: String(milestoneHistory.campaignId),
      actionPath: `/brand/active-campaign`,
    }).catch((e) => console.error("notify brand (milestone accepted) failed:", e));

    createAndEmit({
      influencerId: milestoneHistory.influencerId,
      type: "milestone.accepted",
      title: `Milestone accepted: ${milestoneHistory.milestoneTitle || "Milestone"}`,
      message: "You have accepted this milestone.",
      entityType: "campaign",
      entityId: String(milestoneHistory.campaignId),
      actionPath: `/influencer/my-campaign`,
    }).catch((e) =>
      console.error("notify influencer (milestone accepted) failed:", e)
    );

    return res.status(200).json({
      success: true,
      message: "Milestone accepted successfully",
      milestoneId: String(milestoneDoc._id),
      milestoneHistoryId: String(milestoneHistory._id),
      isAccepted: milestoneHistory.isAccepted,
      milestone: {
        milestoneHistoryId: String(milestoneHistory._id),
        influencerId: String(milestoneHistory.influencerId || ""),
        campaignId: String(milestoneHistory.campaignId || ""),
        milestoneTitle: milestoneHistory.milestoneTitle || "",
        milestoneDescription: milestoneHistory.milestoneDescription || "",
        milestoneBudget: Number(
          milestoneHistory.milestoneBudget || milestoneHistory.amount || 0
        ),
        amount: Number(milestoneHistory.amount || milestoneHistory.milestoneBudget || 0),
        isAccepted: milestoneHistory.isAccepted,
        released: Boolean(milestoneHistory.released),
        payoutStatus: milestoneHistory.payoutStatus || "pending",
        updatedAt: milestoneHistory.updatedAt || null,
      },
    });
  } catch (err) {
    console.error("Error in acceptMilestoneByInfluencer:", err);

    
    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "ACCEPT_MILESTONE_BY_INFLUENCER_ERROR");return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};


exports.updateDeliverableStatus = async (req, res) => {
  try {
    const { deliverableId, status, comments = "" } = req.body || {};

    if (!deliverableId) {
      return res.status(400).json({
        success: false,
        message: "deliverableId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(String(deliverableId))) {
      return res.status(400).json({
        success: false,
        message: "Invalid deliverableId",
      });
    }

    const allowedStatuses = ["revision"];

    if (!allowedStatuses.includes(String(status || "").toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: "Only revision status is allowed from this API",
      });
    }

    const milestoneDoc = await Milestone.findOne({
      "milestoneHistory.deliverables._id": deliverableId,
    });

    if (!milestoneDoc) {
      return res.status(404).json({
        success: false,
        message: "Deliverable not found",
      });
    }

    let targetHistory = null;
    let targetDeliverable = null;

    for (const history of milestoneDoc.milestoneHistory || []) {
      const deliverable = history.deliverables.id(deliverableId);

      if (deliverable) {
        targetHistory = history;
        targetDeliverable = deliverable;
        break;
      }
    }

    if (!targetHistory || !targetDeliverable) {
      return res.status(404).json({
        success: false,
        message: "Deliverable not found",
      });
    }

    const currentStatus = String(targetDeliverable.status || "").toLowerCase();

    if (currentStatus !== "submitted") {
      return res.status(400).json({
        success: false,
        message: "Only submitted deliverables can be moved to revision",
      });
    }

    targetDeliverable.status = "revision";
    targetDeliverable.comments = String(comments || "").trim();
    targetDeliverable.revisionRequestedAt = new Date();

    const revisions = Array.isArray(targetDeliverable.revisions)
      ? targetDeliverable.revisions
      : [];

    const latestSubmittedRevision = [...revisions]
      .reverse()
      .find((item) => String(item.status || "").toLowerCase() === "submitted");

    if (latestSubmittedRevision) {
      latestSubmittedRevision.status = "revision";
      latestSubmittedRevision.updatedAt = new Date();
    }

    resetMilestoneSubmissionAfterRevision(targetHistory);
    milestoneDoc.markModified("milestoneHistory");
    await milestoneDoc.save();

    return res.status(200).json({
      success: true,
      message: "Deliverable moved to revision successfully",
      data: {
        milestoneId: String(milestoneDoc._id),
        milestoneHistoryId: String(targetHistory._id),
        deliverableId: String(targetDeliverable._id),
        status: targetDeliverable.status,
        comments: targetDeliverable.comments || "",
        revisionRequestedAt: targetDeliverable.revisionRequestedAt,
        updatedAt: targetDeliverable.updatedAt,
      },
      milestone: mapMilestoneHistoryForResponse(milestoneDoc, targetHistory),
      deliverable: mapDeliverableForResponse(targetDeliverable, milestoneDoc, targetHistory),
    });
  } catch (err) {
    console.error("Error in updateDeliverableStatus:", err);

    await saveErrorLog(req, err, err?.statusCode || err?.status || err?.statusCode || 500, "UPDATE_DELIVERABLE_STATUS_ERROR");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};