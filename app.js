const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const path = require("path");
const multer = require("multer");
const { Readable } = require("stream");

const { startReminderCron } = require("./services/reminderCron");
const unseenMessageNotifier = require("./jobs/unseenMessageNotifier");
const { startSubscriptionEmailJobs } = require("./jobs/subscriptionEmailJobs");

// sockets
const sockets = require("./sockets");
// routes
const influencerRoutes = require("./routes/influencerRoutes");
const countryRoutes = require("./routes/countryRoutes");
const brandRoutes = require("./routes/brandRoutes");
const campaignRoutes = require("./routes/campaignRoutes");
const categoryRoutes = require("./routes/categoryRoutes");
const audienceRoutes = require("./routes/audienceRoutes");
const applyCampaingRoutes = require("./routes/applyCampaingRoutes");
const contractRoutes = require("./routes/contractRoutes");
const milestoneRoutes = require("./routes/milestoneRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const chatRoutes = require("./routes/chatRoutes");
const adminRoutes = require("./routes/adminRoutes");
const policyRoutes = require("./routes/policyRoutes");
const contactRoutes = require("./routes/contactRoutes");
const faqsRoutes = require("./routes/faqsRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const platformRoutes = require("./routes/platformRoutes");
const audienceRangeRoutes = require("./routes/audiencerangeRoutes");
const filtersRoutes = require("./routes/filterRoutes");
const mediaKitRoutes = require("./routes/mediaKitRoutes");
const modashRoutes = require("./routes/modashRoutes");
const languageRoutes = require("./routes/languageRoutes");
const businessRoutes = require("./routes/businessRoutes");
const unsubscribeRoutes = require("./routes/unsubscribeRoutes");
const disputeRoutes = require("./routes/disputeRoutes");
const notificationsRoutes = require("./routes/notificationsRoutes");
const emailRoutes = require("./routes/emailRoutes");
const Invitationsroutes = require("./routes/Invitationsroutes");
const youtubeRoutes = require("./routes/youtubeRoutes");
const campaignInvitationRoutes = require("./routes/campaignInvitationRoutes");
const delieverableRoutes = require("./routes/delieverableRoute");
const listRoutes = require("./routes/listRoutes");
const brandWalletRoutes = require("./routes/brandWalletRoutes");
const masterRoutes = require("./routes/masterRoute");
const supportRoutes = require("./routes/supportRoutes");
const timezoneRoutes = require("./routes/timezoneRoutes");
const adminEmailRoutes = require("./routes/adminEmailRoute");
const groupChatRoutes = require("./routes/groupChatRoutes");
const pipelineRoutes = require("./routes/influencerPipeline");
const brandOuteachRoutes = require("./routes/brandOutreachRoutes");
const brandNetworkRoutes = require("./routes/brandNetworkRoutes");
const paymentDetailsRoutes = require("./routes/paymentDetailsRoutes");
const instantlytestRoutes = require("./routes/instantlyTestRoutes");
const matchedCreatorRoutes = require("./routes/matchedCreatorRoutes");
const campaignReviewRoutes = require("./routes/campaignReviewRoutes");
const youtubeInsightRoutes = require("./routes/youtubeInsightRoutes");
const errorLogRoutes = require("./routes/errorLog.routes");
const brandSignatureRoutes = require("./routes/brandSignatureRoutes");
const influencerSignatureRoutes = require("./routes/influencerSignatureRoutes");
const brandMemberRoutes = require("./routes/brandMemberRoutes");

const app = express();
const server = http.createServer(app);

const GridFSBucket = mongoose.mongo.GridFSBucket;
const { Types } = mongoose;

const PORT = process.env.PORT || 8000;
const JSON_LIMIT = process.env.JSON_LIMIT || "50mb";
const URLENCODED_LIMIT = process.env.URLENCODED_LIMIT || "50mb";
const FILE_SIZE_LIMIT_MB = Number(process.env.FILE_SIZE_LIMIT_MB || 100);
const GRIDFS_BUCKET_NAME = process.env.GRIDFS_BUCKET || "uploads";

const defaultCorsOrigins = [
  "https://collabglam.com",
  "https://www.collabglam.com",

  "https://collabglam.cloud",
  "https://www.collabglam.cloud",

  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:4000",
  "http://192.168.1.25:3000",

  "http://192.168.1.24:3000",
  "https://mhd.sharemitra.com",
];


/* =========================================================
   REALTIME SETUP
========================================================= */
const io = sockets.init(server);

app.set("io", io);
app.set("emitToBrand", sockets.emitToBrand);
app.set("emitToInfluencer", sockets.emitToInfluencer);
app.set("emitToAdmin", sockets.emitToAdmin);
app.set("broadcastToRoom", sockets.legacyBroadcastToRoom);
app.set("broadcastToGroupChatRoom", sockets.broadcastToGroupChatRoom);

/* =========================================================
   CORS
========================================================= */

const corsOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(",").map((item) => item.trim()).filter(Boolean)
  : defaultCorsOrigins;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);

      if (corsOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

/* =========================================================
   BODY PARSERS
   Keep JSON smaller. Large files should use multipart/form-data.
========================================================= */
app.use(express.json({ limit: JSON_LIMIT }));
app.use(
  express.urlencoded({
    extended: true,
    limit: URLENCODED_LIMIT,
    parameterLimit: 100000,
  })
);

/* =========================================================
   STATIC FILES
========================================================= */
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* =========================================================
   GRIDFS HELPERS
========================================================= */
function getGridFsBucket() {
  if (!mongoose.connection?.db) {
    throw new Error("MongoDB connection not ready");
  }

  return new GridFSBucket(mongoose.connection.db, {
    bucketName: GRIDFS_BUCKET_NAME,
  });
}

function setFileHeaders(res, doc) {
  const contentType =
    doc.contentType || doc.metadata?.mimeType || "application/octet-stream";

  res.set("Content-Type", contentType);
  res.set("Cache-Control", "public, max-age=31536000, immutable");

  if (!/^image\//.test(contentType)) {
    const safe = encodeURIComponent(doc.metadata?.originalName || doc.filename);
    res.set("Content-Disposition", `attachment; filename*=UTF-8''${safe}`);
  } else {
    res.set("Content-Disposition", "inline");
  }
}

async function streamGridFsFileByFilename(req, res) {
  try {
    const { filename } = req.params;
    const bucket = getGridFsBucket();

    const files = await bucket.find({ filename }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ message: "File not found." });
    }

    const doc = files[0];
    setFileHeaders(res, doc);

    const stream = bucket.openDownloadStreamByName(filename);

    stream.on("error", (err) => {
      console.error("Error streaming file from GridFS by filename:", err);
      if (!res.headersSent) {
        return res.status(404).json({ message: "File not found." });
      }
      res.end();
    });

    return stream.pipe(res);
  } catch (err) {
    console.error("Error handling /file/:filename:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function streamGridFsFileById(req, res) {
  try {
    const { id } = req.params;
    const bucket = getGridFsBucket();

    let _id;
    try {
      _id = new Types.ObjectId(id);
    } catch (error) {
      return res.status(400).json({ message: "Invalid file id." });
    }

    const files = await bucket.find({ _id }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ message: "File not found." });
    }

    const doc = files[0];
    setFileHeaders(res, doc);

    const stream = bucket.openDownloadStream(_id);

    stream.on("error", (err) => {
      console.error("Error streaming file from GridFS by id:", err);
      if (!res.headersSent) {
        return res.status(404).json({ message: "File not found." });
      }
      res.end();
    });

    return stream.pipe(res);
  } catch (err) {
    console.error("Error handling /file/id/:id:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
}

/* =========================================================
   MULTER CONFIG
   For actual file uploads, use multipart/form-data.
========================================================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: FILE_SIZE_LIMIT_MB * 1024 * 1024,
    files: 10,
  },
});

async function uploadBufferToGridFS(file, metadata = {}) {
  const bucket = getGridFsBucket();

  return new Promise((resolve, reject) => {
    const filename = `${Date.now()}-${file.originalname}`;
    const uploadStream = bucket.openUploadStream(filename, {
      contentType: file.mimetype,
      metadata: {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        ...metadata,
      },
    });

    Readable.from(file.buffer)
      .pipe(uploadStream)
      .on("error", reject)
      .on("finish", (uploadedFile) => {
        resolve(uploadedFile);
      });
  });
}

/* =========================================================
   HEALTH CHECK
========================================================= */
app.get("/", (req, res) => {
  return res.status(200).json({
    message: "Server is running",
  });
});

/* =========================================================
   FILE ROUTES
========================================================= */
app.get("/file/:filename", streamGridFsFileByFilename);
app.get("/file/id/:id", streamGridFsFileById);

/**
 * Single file upload
 * Frontend should send multipart/form-data with field name: file
 */
app.post("/file/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }

    const uploadedFile = await uploadBufferToGridFS(req.file, {
      uploadedBy: req.body.uploadedBy || null,
      folder: req.body.folder || null,
    });

    return res.status(201).json({
      message: "File uploaded successfully.",
      file: {
        id: uploadedFile._id,
        filename: uploadedFile.filename,
        contentType: req.file.mimetype,
        size: req.file.size,
        url: `/file/id/${uploadedFile._id}`,
      },
    });
  } catch (err) {
    console.error("Error uploading file:", err);
    return res.status(500).json({ message: "Failed to upload file." });
  }
});

/**
 * Multiple file upload
 * Frontend should send multipart/form-data with field name: files
 */
app.post("/file/uploads", upload.array("files", 10), async (req, res) => {
  try {
    const files = req.files || [];

    if (!files.length) {
      return res.status(400).json({ message: "No files uploaded." });
    }

    const uploadedFiles = [];
    for (const file of files) {
      const uploaded = await uploadBufferToGridFS(file, {
        uploadedBy: req.body.uploadedBy || null,
        folder: req.body.folder || null,
      });

      uploadedFiles.push({
        id: uploaded._id,
        filename: uploaded.filename,
        contentType: file.mimetype,
        size: file.size,
        url: `/file/id/${uploaded._id}`,
      });
    }

    return res.status(201).json({
      message: "Files uploaded successfully.",
      files: uploadedFiles,
    });
  } catch (err) {
    console.error("Error uploading multiple files:", err);
    return res.status(500).json({ message: "Failed to upload files." });
  }
});

/* =========================================================
   API ROUTES
========================================================= */
app.use("/influencer", influencerRoutes);
app.use("/country", countryRoutes);
app.use("/brand", brandRoutes);
app.use("/campaign", campaignRoutes);
app.use("/category", categoryRoutes);
app.use("/audience", audienceRoutes);
app.use("/apply", applyCampaingRoutes);
app.use("/contract", contractRoutes);
app.use("/milestone", milestoneRoutes);
app.use("/subscription", subscriptionRoutes);
app.use("/chat", chatRoutes);
app.use("/payment", paymentRoutes);
app.use("/admin", adminRoutes);
app.use("/policy", policyRoutes);
app.use("/contact", contactRoutes);
app.use("/faqs", faqsRoutes);
app.use("/dash", dashboardRoutes);
app.use("/platform", platformRoutes);
app.use("/audienceRange", audienceRangeRoutes);
app.use("/filters", filtersRoutes);
app.use("/media-kit", mediaKitRoutes);
app.use("/modash", modashRoutes);
app.use("/languages", languageRoutes);
app.use("/business", businessRoutes);
app.use("/unsubscribe", unsubscribeRoutes);
app.use("/dispute", disputeRoutes);
app.use("/notifications", notificationsRoutes);
app.use("/emails", emailRoutes);
app.use("/newinvitations", Invitationsroutes);
app.use("/youtube", youtubeRoutes);
app.use("/campaign-invitation", campaignInvitationRoutes);
app.use("/deliverable", delieverableRoutes);
app.use("/list", listRoutes);
app.use("/wallet", brandWalletRoutes);
app.use("/admins", masterRoutes);
app.use("/support", supportRoutes);
app.use("/timezone", timezoneRoutes);
app.use("/admin-email", adminEmailRoutes);
app.use("/group-chat", groupChatRoutes);
app.use("/pipeline", pipelineRoutes);
app.use("/brand-network", brandNetworkRoutes);
app.use("/brand-outreach", brandOuteachRoutes);
app.use("/pitch-folders", require("./routes/pitchFolderRoutes"));
app.use("/payment-details", paymentDetailsRoutes);
// app.use("/instantly", instantlytestRoutes);
app.use("/instantly/oauth", require("./routes/instantlyOAuthRoutes"));
app.use("/instantly", require("./routes/instantlyRoutes"));
app.use("/instantly/webhook", require("./routes/instantlyWebhookRoutes"));
app.use("/outreach", require("./routes/outreachRoutes"));
app.use("/matched-creators", matchedCreatorRoutes);
app.use("/campaign-reviews", campaignReviewRoutes);
app.use("/youtube-insights", youtubeInsightRoutes);
app.use("/campaign-intelligence", require("./routes/campaignIntelligenceRoutes"));
app.use("/error-logs", errorLogRoutes);
app.use("/", brandSignatureRoutes);
app.use("/", influencerSignatureRoutes);
app.use("/brand-members", brandMemberRoutes);

/* =========================================================
   404 HANDLER
========================================================= */
app.use((req, res) => {
  return res.status(404).json({
    message: "Route not found.",
  });
});

/* =========================================================
   ERROR HANDLER
========================================================= */
app.use((err, req, res, next) => {
  console.error("Global error:", err);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        message: `File too large. Max allowed size is ${FILE_SIZE_LIMIT_MB}MB.`,
      });
    }

    return res.status(400).json({
      message: err.message || "Upload error.",
    });
  }

  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({
      message:
        "Payload too large. Do not send large files in JSON. Use multipart/form-data upload instead.",
    });
  }

  return res.status(err.status || 500).json({
    message: err.message || "Internal server error.",
  });
});

/* =========================================================
   STARTUP
========================================================= */
async function bootstrap() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      autoIndex: false,
      maxPoolSize: 20,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });

    console.log("✅ Connected to MongoDB");

    const bucket = getGridFsBucket();
    app.set("gridfsBucket", bucket);

    startReminderCron();
    startSubscriptionEmailJobs();
    unseenMessageNotifier.start();

    console.log("✅ Started reminder cron");
    console.log("✅ Started subscription email jobs");
    console.log("✅ Started unseen message notifier job");

    server.listen(PORT, () => {
      console.log(`🚀 Server listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
}

bootstrap();

module.exports = app;