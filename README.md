# SCAN — SportsX Confidential Ad-Network

**Privacy-first advertising protocol for sports clubs, fans, and sponsors.**

Built with [Fhenix](https://fhenix.io) Fully Homomorphic Encryption (FHE) — sponsors can target fan segments without ever seeing the raw data.

## The Problem

- **Fans** don't want their spending and behavior data exposed
- **Clubs** face GDPR/PIPEDA compliance risks sharing fan data with sponsors
- **Sponsors** need precision targeting but can't access sensitive fan metrics

## The Solution

SCAN uses FHE to perform **blind matching** on encrypted fan data:

```
Fan Data (encrypted) → FHE Matching Engine → Encrypted Boolean Result
                         ↑
              Sponsor Thresholds (encrypted)
```

1. Fan metrics (spend, attendance, loyalty) are encrypted client-side
2. Encrypted profiles stored on-chain as FHE ciphertexts
3. Sponsors set targeting criteria (e.g., spend >= $500)
4. FHE engine runs `FHE.gte(fanSpend, threshold)` on encrypted data
5. Result is an **encrypted boolean** — nobody knows who matched
6. Matching fans claim rewards. Sponsor only sees aggregate count.

**Zero data points exposed. 100% GDPR compliant.**

## Architecture

```
┌──────────────┐     ┌───────────────────────┐     ┌──────────────┐
│   Fan        │     │   Fhenix FHE Engine    │     │   Sponsor    │
│              │     │                        │     │              │
│  Encrypt     │────>│  ConfidentialFanProfile │     │  Create      │
│  Metrics     │     │  (euint32 ciphertexts) │     │  Campaign    │
│  Client-side │     │                        │     │  (thresholds │
│              │     │  SCANCampaign          │<────│   + budget)  │
│  Claim       │<────│  Blind Match:          │     │              │
│  Reward      │     │  FHE.gte + FHE.and     │────>│  View Stats  │
│              │     │  → encrypted boolean   │     │  (count only)│
└──────────────┘     └───────────────────────┘     └──────────────┘
```

## Smart Contracts

### ConfidentialFanProfile.sol
- Stores encrypted fan metrics (spending, attendance, loyalty) as `euint32`
- Only fans can view their own data via FHE ACL permissions
- Admin registers/updates profiles with client-encrypted data

### SCANCampaign.sol
- Sponsors create campaigns with targeting thresholds + ETH budget
- **Blind Match Engine**: `FHE.gte()` + `FHE.and()` on encrypted data
- Async decryption flow: request → wait → claim
- Sponsor sees only aggregate match count

## Tech Stack

- **Encryption**: Fhenix CoFHE (Fully Homomorphic Encryption)
- **Smart Contracts**: Solidity 0.8.25 with `@fhenixprotocol/cofhe-contracts`
- **Chain**: Arbitrum Sepolia (EVM)
- **Dev Tools**: Hardhat + cofhe-hardhat-plugin
- **Frontend**: TypeScript + Vite + ethers.js

## Quick Start

```bash
# Install dependencies
pnpm install

# Compile contracts
pnpm exec hardhat compile

# Run tests (all 6 pass)
pnpm exec hardhat test

# Deploy to Arbitrum Sepolia
cp .env.example .env
# Add your PRIVATE_KEY to .env
pnpm exec hardhat deploy-scan --network arb-sepolia
```

### Frontend

```bash
cd frontend
pnpm install
pnpm dev
```

## Test Results

```
SCAN Protocol
  ConfidentialFanProfile
    ✔ should register a fan profile with encrypted data
    ✔ should reject duplicate profile registration
    ✔ should reject non-admin registration
  SCANCampaign - Blind Matching
    ✔ should create a campaign and execute blind match
    ✔ should match a qualifying fan and allow reward claim
    ✔ should handle campaign deactivation and refund

6 passing
```

## Competitive Advantages

- **Privacy-by-Design**: Data is "useful but invisible" — GDPR/PIPEDA compliant from day one
- **Computational Superiority**: Unlike ZKPs which only prove statements, FHE allows complex weighted scoring on encrypted data
- **Sybil Resistance**: Profiles anchored to SportsX SaaS represent real fans, not bots
- **Real Market Need**: $650B+ sports sponsorship market needs privacy-preserving targeting

## Resources

- [Fhenix Docs](https://cofhe-docs.fhenix.zone)
- [CoFHE SDK](https://www.npmjs.com/package/cofhejs)
- [SportsX](https://sportsx.xyz)

## License

MIT

---

Built by [Next Play AI](https://www.nextplayai.xyz) for the [Fhenix Privacy-by-Design dApp Buildathon](https://app.akindo.io/wave-hacks/Nm2qjzEBgCqJD90W)
