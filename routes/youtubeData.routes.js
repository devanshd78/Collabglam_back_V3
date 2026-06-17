'use strict';

const express = require('express');
const router = express.Router();

const {
  browseCreators,
  recommendCreatorsForCampaign,
  getCreatorMediaKit,
  proxyImage,
} = require('../controllers/youtubeData.controller');

router.get('/creators', browseCreators);
router.post('/creators', browseCreators);

router.get('/campaign/:campaignId/creators', (req, res, next) => {
  req.query.campaignId = req.params.campaignId;
  return browseCreators(req, res, next);
});


router.get('/campaign/:campaignId/recommend-influencers', recommendCreatorsForCampaign);
router.post('/campaign/:campaignId/recommend-influencers', recommendCreatorsForCampaign);
router.post('/campaign-recommendations', recommendCreatorsForCampaign);

// Separate brand-facing media-kit API.
router.get('/media-kit/:channelId', getCreatorMediaKit);

// Backward-compatible route used by older frontend code.
router.get('/creators/:channelId/media-kit', getCreatorMediaKit);

router.get('/image-proxy', proxyImage);

module.exports = router;