# Plan: Draft Moov Compliance Response

The user needs a direct explanation for Moov's compliance questions regarding funding sources and customer acquisition.

## Proposed Response Content

### 1. Funding Source and Verification
*   **Source:** Funds originate from insurance carriers via claim checks issued to our customers (restoration contractors and public adjusters) or their clients (homeowners).
*   **Verification:** ChecksOps verifies the origin by processing the physical/digital check images through an OCR pipeline that validates carrier info, claim numbers, and payee details. 
*   **Account Linking:** Customers link their business bank accounts via Plaid (KYB verified). Funds move from the customer's verified business account to their own verified stakeholders (subcontractors/vendors).
*   **Relationship:** We act as the workflow layer for the *claimant* or their *contractor*, not the carrier.

### 2. Customer Sourcing
*   **Method:** We market directly to the restoration industry (trade shows, industry publications, direct sales to restoration companies and public adjusting firms).
*   **Independence:** We do not rely on insurance carriers or mortgage lenders for leads or partnerships. Our users seek us out to automate their internal manual check handling and payout workflows.

## Action Items
1. Present these points clearly to the user in the next response.
2. No code changes required for this specific request.
