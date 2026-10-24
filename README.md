# EvidenceLens

**A source-linked, human-reviewed workspace for PayPal Sandbox dispute evidence.**

Review a dispute against its original sources, retain contradictory evidence, and export a reviewable draft. EvidenceLens does not decide disputes, submit evidence to PayPal, issue refunds, or process payments.

> Hackathon prototype, not production-ready. The sample uses a sanitized historical Sandbox reconstruction with synthetic replacement identifiers and separately labeled synthetic evidence. It is not a live account record. Never submit demonstration material as genuine evidence.

## Try the workflow

[Open the live public demo](https://evidencelens-preview.goodchick14.chatgpt.site) — no ChatGPT login required.

1. Open the app and choose **Review sample**. No ChatGPT login is required.
2. Compare the seller's claim of ten delivered files with the buyer's report of four present and six missing.
3. Inspect exact source quotations, contradictions, and missing evidence.
4. Edit the draft and complete human-review controls before exporting.
5. Download your draft before leaving: refreshing clears the page-memory workspace.

The default sample uses deterministic local rules and makes no AI calls. Optional model review and PNG/JPEG transcription require an explicit action and consent, may incur provider charges, and do not replace human review. Exact quotation matches and hashes do not prove authenticity or semantic support. PDF intake is not implemented.

## Run locally

Requirements: **Node.js 24+, npm, and Python 3** (Python is needed only for parity tests). No third-party dependencies or install step are needed.

```sh
node --version
npm test
npm run test:parity
npm run test:artifact
npm start
```

Open **http://127.0.0.1:8787**; stop with Ctrl+C. Without credentials, the deterministic sample works for free, while external integrations report missing configuration. The development bridge binds only to loopback, checks the Host header, and strips claimed platform identity. Do not expose it publicly.

`npm test` builds and runs 116 automated tests. Parity tests compare 13 complete Python/JavaScript snapshots using the included `tests/oracle/engine.py`. Artifact checks exercise the built Worker without live calls. `npm run build` creates `dist/server/index.js`; generated bundles are not source-controlled.

### Optional backend integrations

Copy `.env.example` to `.env` and enter your own Sandbox/provider credentials locally. `npm start` loads this file into the **server process only**. Never put credentials in browser code, source control, screenshots, exports, or a demo video.

```dotenv
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
```

- PayPal endpoints are fixed to `https://api-m.sandbox.paypal.com`: Sandbox OAuth and read-only dispute retrieval only.
- The selected low-cost configuration is DeepSeek Flash with `reasoning: { effort: "none" }`. This is a configuration choice, not a current-price comparison.
- Public test mode requires **no visitor login**. When backend credentials exist, visitors can explicitly invoke integrations. There are **no paid-call count or spending caps**, as approved for this public prototype. Payload/cache limits are not spending limits. Deployers are responsible for provider billing and exposure.
- An unpredictable per-page bearer capability separates transient results and recovery. It is not identity authentication, an account, or durable storage. Reloading creates a new capability. Do not share it.
- Calls are not silently retried or redirected to another provider. `store:false` is requested, not a guarantee about third-party retention.
- Screenshot extraction is staged for correction and explicit admission. The reviewer explicitly marks simulated/test screenshots so derived evidence and exports retain the synthetic label. Original image bytes, machine transcription, and corrected text remain linked; authenticity is not verified.

For a Worker-compatible host, deploy the built ESM fetch handler and configure environment bindings through that host's secret controls. Create your own hosting configuration; no platform identity manifest is included or needed for the local demo.

## Verification status — October 24, 2026

| Component | Evidence / limit |
| --- | --- |
| Clean public source | 116 automated tests, 13 parity snapshots, and artifact checks pass |
| Direct real DeepSeek text adapter | Passed; output accepted by citation/adverse-evidence validation, not human-approved |
| Direct real DeepSeek image extraction | Passed on a four-line synthetic fixture; preserved four present and six missing |
| Hosted public website, desktop browser | v20 passed the combined Sandbox → evidence → real screenshot OCR → synthetic-labeled admission → real AI review → review controls → JSON/TXT export path at 09:59–10:00 UTC |
| PayPal | Real Sandbox test-case read passed through the hosted website; read-only, no submission or payment |
| License | MIT, copyright © 2026 SimithXu |

The final hosted desktop-browser check read a real Sandbox test case, imported four simulated records, and ran actual OCR on a synthetic PNG. Its four extracted lines were inspected, explicitly marked synthetic, and admitted after checking the transcription-review control. An actual DeepSeek review was accepted with five claims, two contradictions, and three gaps. A partial-delivery AI claim was added as unreviewed and its exact derived-text citation inspected. Checking one of six draft claims recorded 1/6 reviewed; editing that claim reset the count to 0/6. Both JSON and TXT drafts were downloaded.

The parsed JSON contained six draft claims and six sources. Current-isolate AI response-origin provenance was verified, but semantic support remained false and `review_complete` remained false. The image-derived source retained `synthetic: true`, its original-image hash, `reviewed: true`, `corrected: false`, and authenticity unverified. This was an **automated demonstration of review controls**, not independent human validation, completed review, or permission to submit.

Earlier model attempts were rejected by validation; the final acceptance does not guarantee future model output will pass or establish semantic correctness. Citation, provenance, and adverse-evidence guards remain enforced. Direct real-provider text and image checks also passed separately. Mobile/browser-matrix checks are not claimed. The v20 source passed 116 automated tests, 13 parity snapshots, and built-artifact checks. Tests use mocks where appropriate. No provider credentials are bundled. Configured credentials, accepted model output, browser workflow success, and human approval are separate milestones.

## Architecture

- `public/`: English-first interface with a Chinese toggle.
- `worker/engine.js`: deterministic import, analysis, source/citation integrity, export.
- `worker/adapters.js`: fixed-endpoint PayPal Sandbox and model adapters.
- `worker/server.js`: fetch handler, origin guards, capability-isolated transient cache.
- `worker/images.js`, `worker/image-validation.js`: bounded image-intake path.
- `fixtures/`: sanitized/synthetic demo records and test screenshot.
- `scripts/`: dependency-free build, loopback server, artifact validation.
- `tests/`: behavior checks and self-contained Python parity oracle.

## Limits and data handling

There is no database or saved workspace. Server recovery is a bounded in-memory cache: 30-minute retention, at most 64 entries and 16 MiB per Worker isolate. Restarting, redeploying, eviction, another isolate, or losing the page capability can make results unavailable. Unknown does not mean an earlier operation did nothing or incurred no charge; recovery never automatically resubmits.

Source annotations and deterministic heuristics are not semantic proof. Model suggestions remain separate from the editable draft; citation and adverse-evidence guards can reject output. A review checkbox is local history, not an authenticated signature. Exports retain unresolved issues and do not authorize submission. Do not upload real customer or sensitive records to an unreviewed public prototype.

## License

[MIT](LICENSE). Copyright © 2026 SimithXu.
