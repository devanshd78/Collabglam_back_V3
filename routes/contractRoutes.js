"use strict";

const express = require("express");
const router = express.Router();
const multer = require("multer");

const {
  initiate,
  viewed,
  influencerConfirm,
  brandConfirm,
  adminUpdate,
  finalize,
  preview,
  sign,
  viewContractPdf,

  brandUpdateFields,
  influencerUpdateFields,
  initiateBulk,

  getContract,
  reject,

  listTimezones,
  getTimezone,
  listCurrencies,
  getCurrency,
  resend,

  uploadBrandSignature,
  getBrandSignature,
  uploadInfluencerSignature,
  getInfluencerSignature,

  getDeliverablesByInfluencerAndCampaign,
  getMilestonesByInfluencerAndCampaign,
  getScheduleADataByInfluencerAndCampaign,
  influencerManage,
  getContractDetails,
  getSendContractRequirements,

  getOwnContractUploadUrl,
  sendUploadedOwnContract,
} = require("../controllers/contractController");

router.post("/initiate", initiate);
router.post("/viewed", viewed);

router.post("/influencer/confirm", influencerConfirm);
router.post("/brand/confirm", brandConfirm);

router.post("/brand/update", brandUpdateFields);
router.post("/influencer/update", influencerUpdateFields);

router.post("/admin/update", adminUpdate);
router.post("/finalize", finalize);

router.get("/preview", preview);
router.post("/sign", sign);
router.post("/viewPdf", viewContractPdf);

router.post("/getContract", getContract);
router.post("/reject", reject);
router.post("/initiate-bulk", initiateBulk);

router.get("/timezones", listTimezones);
router.get("/timezone", getTimezone);
router.get("/currencies", listCurrencies);
router.get("/currency", getCurrency);
router.post("/resend", resend);

router.get(
  "/:influencerId/:campaignId/deliverables",
  getDeliverablesByInfluencerAndCampaign
);

router.get(
  "/:influencerId/:campaignId/milestones",
  getMilestonesByInfluencerAndCampaign
);

router.get(
  "/:influencerId/:campaignId/scheduleA",
  getScheduleADataByInfluencerAndCampaign
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.post("/upload", upload.single("signature"), uploadBrandSignature);
router.get("/signature/:brandId", getBrandSignature);

router.post(
  "/upload-influencer",
  upload.single("signature"),
  uploadInfluencerSignature
);
router.get("/signature-influencer/:influencerId", getInfluencerSignature);

router.get("/manage/:contractId", influencerManage);

router.get("/get-contract-details/:contractId", getContractDetails);

router.post("/send-requirements", getSendContractRequirements);

router.post("/own/upload-url", getOwnContractUploadUrl);
router.post("/own/send-uploaded", sendUploadedOwnContract);

module.exports = router;