# SCAN — Akindo Submission Materials

> Copy-paste these into the Akindo submission form.

---

## Product Name

SCAN — SportsX Confidential Ad-Network

## Tagline / One-liner

Privacy-first advertising protocol where sponsors target fan segments on encrypted data — without ever seeing who matched.

## Description (Short)

SCAN bridges sports clubs, fans, and sponsors using Fully Homomorphic Encryption (FHE) via Fhenix. Sponsors define targeting criteria (e.g., "fans who spent >$500 and attended >5 matches"). The FHE engine runs blind matching on encrypted fan profiles — computing `FHE.gte()` and `FHE.and()` directly on ciphertexts. The result is an encrypted boolean: nobody knows who matched. Fans receive targeted ads privately; sponsors see only aggregate impression counts. Revenue is automatically split three ways: Club 60%, Fan 30%, Protocol 10%. Zero data points exposed. 100% GDPR compliant.

## Description (Detailed)

### The Problem

The $650B+ sports sponsorship industry runs on fan data, but:

- **Fans** don't want spending habits and behavior exposed on public blockchains
- **Clubs** face GDPR/PIPEDA compliance liability when sharing fan data with third-party ad networks
- **Sponsors** need precision targeting but can't access sensitive fan metrics under current privacy regulations

Traditional ad networks require clubs to hand over raw fan data. On-chain transparency makes it worse — anyone can dox a fan's financial status. The result: a stalemate where sponsors want precision, fans want privacy, and clubs want compliance.

### The Solution

SCAN uses Fhenix FHE to make fan data **"useful but invisible"**:

1. **Client-Side Encryption** — Fan metrics (total spend, match attendance, loyalty years) are encrypted before touching the blockchain using Fhenix's CoFHE SDK
2. **On-Chain Encrypted Storage** — Profiles stored as `euint32` ciphertexts in the `ConfidentialFanProfile` contract, with FHE ACL permissions ensuring only the fan can view their own data
3. **Blind Matching Engine** — The `SCANCampaign` contract runs `FHE.gte(fanSpend, threshold)` and `FHE.and()` on encrypted data. All comparisons happen on ciphertexts — no plaintext is ever revealed
4. **Privacy-Preserving Ad Delivery** — Matched fans receive targeted ads (video, links, promotions) through their club's mobile app. Sponsors see only aggregate impression counts, never individual identities.
5. **Automated Three-Way Revenue Split** — Every verified ad impression triggers on-chain settlement: Club 60%, Fan 30%, Protocol 10%. Sponsors pay per impression (CPM/CPI model).
6. **Sybil Resistance** — Encrypted profiles are anchored to real SportsX SaaS infrastructure, representing verified real-world fans

### Revenue Model

```
Sponsor deposits budget → FHE blind match → Ad delivered via club app
                                                    ↓
                                            Fan views/clicks ad
                                                    ↓
                                         Proof of View on-chain
                                                    ↓
                                    ┌──────────────────────────┐
                                    │  Automatic Settlement    │
                                    │  Club:     60%           │
                                    │  Fan:      30%           │
                                    │  Protocol: 10%           │
                                    └──────────────────────────┘
```

### Why FHE Over ZKP?

Zero-Knowledge Proofs can only *prove* a statement. FHE allows sponsors to perform **complex, weighted scoring** on fan data (multi-criteria matching, range comparisons) without ever seeing it. This is a fundamentally different — and more powerful — primitive for advertising.

### Technical Architecture

```
Fan (Client)          Fhenix (On-Chain FHE)          Sponsor
    │                        │                          │
    │ Encrypt metrics        │                          │
    │ via @cofhe/sdk         │                          │
    │───────────────────────>│                          │
    │                        │ Store euint32 profiles   │
    │                        │ (ConfidentialFanProfile) │
    │                        │                          │
    │                        │<─────────────────────────│
    │                        │ Create campaign          │
    │                        │ (targeting + ad content  │
    │                        │  + budget)               │
    │                        │                          │
    │                        │ Blind Match:             │
    │                        │ FHE.gte() + FHE.and()   │
    │                        │ → encrypted boolean      │
    │                        │                          │
    │ View ad in club app    │                          │
    │ → Proof of View        │                          │
    │───────────────────────>│                          │
    │                        │ Auto-settle:             │
    │ Receive 30% reward  <──│ Club 60% + Fan 30%      │──> Sponsor sees:
    │                        │ + Protocol 10%           │    "3,200 impressions"
```

### Smart Contracts

- **ConfidentialFanProfile.sol** — Encrypted fan profile storage with FHE ACL permissions, batch campaign access grants
- **SCANCampaign.sol** — Campaign creation, FHE blind matching engine, async decryption reward claims, campaign deactivation with budget refund

---

## Wave 1 Update (Current)

### What We Built

- Two production-ready Solidity contracts with full FHE integration
- 6/6 tests passing (registration, access control, blind match, reward claim, deactivation)
- Deployed to Arbitrum Sepolia
- Frontend MVP with Fan Portal, Sponsor Dashboard, and architecture explainer
- WalletConnect QR code integration for mobile wallet connection
- Live demo at https://sportsx-xyz.github.io/SCAN/
- Complete project documentation

---

## Wave 2 Milestone (3/30 → 4/13)

**Goal: CPM Ad Delivery Model + Three-Way Revenue Split**

### Smart Contract Evolution
- Implement three-way revenue split contract: Club 60% / Fan 30% / Protocol 10%, triggered automatically on each verified ad impression
- Extend Campaign struct to support ad content binding: `adContentURI` (video URL, link, promotional content stored on IPFS), `costPerImpression`, `adType` (video / link / banner)
- Build `ProofOfView` mechanism: fans confirm ad view on-chain, triggering settlement
- Migrate from deprecated `cofhejs` to new `@cofhe/sdk` (mandatory — cofhejs EOL is April 13)

### Frontend + Integration
- Implement full client-side FHE encryption using `@cofhe/sdk` — fans encrypt their own data before submission
- Build admin dashboard for club operators: register fan profiles, grant campaign access, trigger batch blind matching
- Sponsor campaign creation with ad content upload (video URL, link, banner image)
- Privara SDK integration for confidential payment rails (USDC-based settlement)

### End-to-End Demo
- Complete flow on Arbitrum Sepolia: fan encrypts profile → sponsor creates campaign with ad → admin runs blind match → fan views ad in demo → auto three-way settlement
- Demo video walkthrough

**Deliverables:**
- Three-way revenue split contract (tested + deployed)
- Ad content binding in campaign creation
- ProofOfView mechanism
- Working end-to-end demo with real FHE encryption
- Admin dashboard UI
- Updated documentation with demo video

---

## Wave 3 Milestone (4/8 → 5/8)

**Goal: Club App Integration + Production-Ready Protocol**

### Club Mobile App Integration
- Build ad delivery SDK for SportsX club iOS app: dedicated ad slots (banner, interstitial, video) that display sponsor content to FHE-matched fans
- Auto-sync club membership data: fan profiles automatically encrypted and uploaded from SportsX SaaS platform to on-chain FHE storage (no manual input)
- In-app Proof of View: when a fan views/clicks an ad in the club app, the app calls `confirmView()` on-chain, triggering automatic three-way settlement
- Push notification integration: notify matched fans of new sponsor offers

### Advanced FHE Matching
- Weighted scoring engine: extend blind matching to support weighted fan scoring using `FHE.mul` and `FHE.add` on encrypted data (e.g., 40% spend weight + 30% attendance + 30% loyalty)
- Multi-club support: separate fan profile namespaces per club, cross-club campaign targeting for sponsors who want to reach fans across multiple clubs

### Sponsor Analytics + Dashboard
- Campaign performance dashboard: impression count, click-through rate, budget utilization, cost per impression — all aggregate, zero individual fan data
- Campaign A/B testing: run multiple ad variants against the same FHE-matched segment, compare performance
- ROI reporting for sponsors with exportable analytics

### Production Readiness
- Gas optimization: benchmark and optimize FHE batch matching operations
- Security audit preparation: document threat model, review ACL permissions, edge case testing
- Mainnet deployment preparation on Arbitrum

**Deliverables:**
- Club iOS app with ad delivery SDK and Proof of View
- Automated fan data sync from SportsX SaaS
- Weighted FHE scoring engine (contract + tests)
- Multi-club architecture
- Sponsor analytics dashboard
- Mainnet deployment plan

---

## Application Area

Confidential DeFi / Private Payments — Advertising & Fan Engagement vertical

## Built With

- Fhenix CoFHE (`@fhenixprotocol/cofhe-contracts`)
- Solidity 0.8.25
- Hardhat + cofhe-hardhat-plugin
- TypeScript, Vite, ethers.js, WalletConnect
- Arbitrum Sepolia

## Links

- **Live Demo**: https://sportsx-xyz.github.io/SCAN/
- **GitHub**: https://github.com/SportsX-xyz/SCAN
- **Deployed Contracts (Arbitrum Sepolia)**:
  - ConfidentialFanProfile: https://sepolia.arbiscan.io/address/0x35Bd9f53261AbD0314C6349492397DE0F4d07Ec3
  - SCANCampaign: https://sepolia.arbiscan.io/address/0xc2011a5942f12A67C7bdeDD08948C3F26564132e

## Team

- **Temple Dunn** — Founder/CEO, Next Play AI / SportsX
  - Building AI-native infrastructure for mid-tier sports clubs
  - Prior relationship with Fhenix team (met Lauren, DevRel, in NYC)

## Tags

#Solidity #EVM #privacy #Arbitrum #FHE #Fhenix #sports #advertising #GDPR

## Judging Criteria Alignment

| Criteria | How SCAN Addresses It |
|----------|----------------------|
| **Privacy Architecture** | End-to-end FHE: client-side encryption → on-chain ciphertext storage → blind matching → async decryption. Fan data never exists in plaintext on-chain. |
| **Innovation & Originality** | First privacy-preserving ad network for sports. FHE blind matching + CPM ad delivery with automated three-way revenue split. Sponsors compute on data they can't see. |
| **User Experience** | Fan Portal + Sponsor Dashboard + WalletConnect QR code. Ads delivered natively in club mobile app. Three-click flow for all personas. |
| **Technical Execution** | Two contracts, 6/6 tests, deployed on Arbitrum Sepolia, live demo. Full FHE integration with ACL permissions, batch operations, async decryption. |
| **Market Potential** | $650B+ sports sponsorship market. CPM model with 60/30/10 split aligns incentives for clubs, fans, and protocol. SportsX already has club relationships and iOS app. |
