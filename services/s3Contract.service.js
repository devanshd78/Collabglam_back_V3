"use strict";

const crypto = require("crypto");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const CONTRACT_BUCKET =
  process.env.CONTRACT_S3_BUCKET ||
  process.env.AWS_S3_BUCKET ||
  "collabglam-campaign";

const CONTRACT_FOLDER =
  process.env.CONTRACT_S3_FOLDER || "collabglam-contract";

const AWS_REGION = process.env.AWS_REGION || "ap-south-1";

const MAX_CONTRACT_FILE_BYTES = Number(
  process.env.CONTRACT_FILE_MAX_BYTES || 15 * 1024 * 1024
);

const s3 = new S3Client({
  region: AWS_REGION,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

function sanitizeFileName(name = "contract.pdf") {
  return String(name || "contract.pdf")
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(-120);
}

function assertPdfUpload({ fileName, contentType, sizeBytes }) {
  const name = String(fileName || "").toLowerCase();
  const type = String(contentType || "").toLowerCase();
  const size = Number(sizeBytes || 0);

  if (!name.endsWith(".pdf") || type !== "application/pdf") {
    const error = new Error("Only PDF contract files are allowed.");
    error.status = 400;
    throw error;
  }

  if (!size || size > MAX_CONTRACT_FILE_BYTES) {
    const error = new Error(
      `Contract PDF must be ${Math.round(
        MAX_CONTRACT_FILE_BYTES / (1024 * 1024)
      )} MB or less.`
    );
    error.status = 400;
    throw error;
  }
}

function buildContractS3Key({
  brandId,
  campaignId,
  influencerId,
  originalName,
}) {
  const ext = path.extname(originalName || "").toLowerCase() || ".pdf";
  const random = crypto.randomBytes(12).toString("hex");

  return [
    CONTRACT_FOLDER,
    String(brandId),
    String(campaignId),
    String(influencerId),
    `${Date.now()}-${random}${ext}`,
  ].join("/");
}

function getExpectedContractKeyPrefix({ brandId, campaignId, influencerId }) {
  return `${CONTRACT_FOLDER}/${brandId}/${campaignId}/${influencerId}/`;
}

async function createContractUploadUrl({
  brandId,
  campaignId,
  influencerId,
  fileName,
  contentType,
  sizeBytes,
}) {
  assertPdfUpload({ fileName, contentType, sizeBytes });

  const key = buildContractS3Key({
    brandId,
    campaignId,
    influencerId,
    originalName: fileName,
  });

  const command = new PutObjectCommand({
    Bucket: CONTRACT_BUCKET,
    Key: key,
    ContentType: "application/pdf",
    Metadata: {
      brandId: String(brandId),
      campaignId: String(campaignId),
      influencerId: String(influencerId),
      originalName: sanitizeFileName(fileName),
    },
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: 60 * 5,
  });

  return {
    uploadUrl,
    bucket: CONTRACT_BUCKET,
    folder: CONTRACT_FOLDER,
    key,
    originalName: sanitizeFileName(fileName),
    mimeType: "application/pdf",
    sizeBytes: Number(sizeBytes || 0),
    expiresIn: 300,
  };
}

async function createContractReadUrl(key, fileName = "Contract.pdf") {
  const command = new GetObjectCommand({
    Bucket: CONTRACT_BUCKET,
    Key: key,
    ResponseContentType: "application/pdf",
    ResponseContentDisposition: `inline; filename="${sanitizeFileName(fileName)}"`,
  });

  return getSignedUrl(s3, command, {
    expiresIn: 60 * 5,
  });
}

async function getContractObjectStream(key) {
  return s3.send(
    new GetObjectCommand({
      Bucket: CONTRACT_BUCKET,
      Key: key,
    })
  );
}

async function deleteContractFile(key) {
  if (!key) return;

  await s3.send(
    new DeleteObjectCommand({
      Bucket: CONTRACT_BUCKET,
      Key: key,
    })
  );
}

module.exports = {
  CONTRACT_BUCKET,
  CONTRACT_FOLDER,
  createContractUploadUrl,
  createContractReadUrl,
  getContractObjectStream,
  getExpectedContractKeyPrefix,
  deleteContractFile,
  assertPdfUpload,
};