const express = require("express");
const router = express.Router();

const {
  createInvitation,
  updateInvitationStatus,
  listInvitations,
  getInvitationList,
  getInvitationSendEligibility,
  sendInvitationFollowUp,
  getAllInvitations,
  getAllMissingEmailRecords,
  updateInfluencerEmailByChannelId
} = require("../controllers/NewInvitationsController");

router.post("/create", createInvitation);
router.post("/update", updateInvitationStatus);
router.post("/list", listInvitations);
router.post("/getList", getInvitationList);
router.post("/eligibility", getInvitationSendEligibility);
router.post("/followup", sendInvitationFollowUp);
router.post("/getall", getAllInvitations);
router.get("/getAllMissing", getAllMissingEmailRecords);
router.post(
  "/missing-email-records/:channelId/email",
  updateInfluencerEmailByChannelId
);

module.exports = router;