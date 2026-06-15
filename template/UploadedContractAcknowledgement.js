"use strict";

module.exports = `
COLLABGLAM UPLOADED CONTRACT ACKNOWLEDGEMENT

By accepting, confirming, or signing this acknowledgement, the Brand and Creator confirm that:

1. The Brand has uploaded a separate campaign agreement, contract, statement of work, order form, or similar document for this collaboration.

2. The Brand and Creator are responsible for reviewing the uploaded agreement before accepting or signing through the CollabGlam Platform.

3. This collaboration was initiated, tracked, and managed through the CollabGlam Platform.

4. Campaign communications, deliverable submissions, approvals, milestone tracking, funding activity, and payment release activity may be managed through CollabGlam.

5. The Brand and Creator are solely responsible for the commercial terms, obligations, representations, warranties, deliverables, usage rights, timelines, and performance requirements contained in the uploaded agreement.

6. CollabGlam is not a party to the uploaded agreement between the Brand and Creator. CollabGlam acts only as the platform operator, workflow administrator, marketplace facilitator, and, where applicable, payment facilitator.

7. For campaigns funded or paid through CollabGlam, marketplace fees, including the applicable CollabGlam marketplace fee, payment processing fees, payout fees, taxes, chargeback costs, or other platform-authorized deductions may apply in accordance with CollabGlam platform terms and applicable payment policies.

8. Platform records, messages, uploaded files, acknowledgements, acceptances, signatures, submissions, approvals, milestone activity, funding activity, and payment records maintained by CollabGlam may be used as evidence of campaign activity, approval status, and performance.

9. Acceptance or signature through CollabGlam does not modify the uploaded agreement unless the uploaded agreement or the Parties expressly state otherwise in writing.

10. If there is a conflict between this acknowledgement and the uploaded agreement, the uploaded agreement controls the commercial terms between the Brand and Creator, while this acknowledgement controls CollabGlam platform workflow, records, payment facilitation, and marketplace administration.

11. By accepting or signing, each Party confirms that it has authority to enter into this collaboration, has reviewed the uploaded agreement, and agrees to be bound by the uploaded agreement and this acknowledgement.

BRAND ACKNOWLEDGEMENT

I confirm that I have uploaded, reviewed, and accept the uploaded agreement and this CollabGlam Uploaded Contract Acknowledgement.

CREATOR ACKNOWLEDGEMENT

I confirm that I have reviewed and accept the uploaded agreement and this CollabGlam Uploaded Contract Acknowledgement.

COLLABGLAM CONTRACT FLOW - MVP

Purpose:
Provide a simple contract workflow between Brands and Creators without unnecessary complexity.

Overview:
Brands can either use the CollabGlam contract template or upload their own contract. Once both parties accept and sign, the collaboration can move into milestone creation, milestone funding, deliverable submission, approval, and payout release.

Contract Flow:
1. Brand creates or selects an influencer collaboration.
2. Brand chooses one option:
   a. Use CollabGlam Template
   b. Upload Own Contract
3. If the Brand uses the CollabGlam Template, the Brand fills in contract details such as deliverables, timeline, payment terms, usage rights, revisions, and campaign requirements.
4. If the Brand uploads its own contract, the PDF is uploaded to the CollabGlam S3 contract folder and linked to the contract record.
5. The contract is sent to the Creator for review.
6. The Creator can accept, sign, or reject.
7. The Brand can accept and sign when required by the workflow.
8. Once both required parties sign, the contract status becomes executed.
9. The Brand creates one or more milestones after contract execution.
10. The Brand funds milestone(s). Funds are reserved or held before the Creator begins milestone work.
11. The Creator completes the work and submits deliverables.
12. The Brand reviews and approves the submission.
13. Payment is released for the approved milestone.

Recommended Payment Logic:
Do not block or hold money at the time of contract signing. Funds should be blocked, reserved, or collected when milestones are created or funded. This keeps onboarding simple and aligns with marketplace workflow expectations.

UI Flow:
Contract Section:
- Use CollabGlam Template
- Upload Own Contract

After Selection:
- Preview Contract
- Send Contract
- Accept / Reject
- Sign
- Create Milestone after execution
- Fund Milestone
- Submit Deliverables
- Approve Deliverables
- Release Payment

Statuses:
Draft -> Sent -> Viewed -> Accepted -> Ready to Sign -> Signed / Executed -> Milestones Created

MVP Scope:
- Template Contract
- Uploaded Custom Contract
- PDF Preview / View
- E-signature with name, timestamp, and audit record
- Contract Status Tracking
- Milestone Creation after Contract Execution
- Milestone Funding after Contract Execution
`.trim();