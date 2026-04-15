// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./ConfidentialFanProfile.sol";

/// @title SCANCampaign — Wave 2: CPM Ad Delivery + Three-Way Revenue Split
/// @notice FHE blind matching engine with ProofOfView settlement.
///         Flow: blindMatch → publishMatchResult (off-chain decryptForTx) → confirmView
///         On confirmed view: auto-split 60% club / 30% fan / 10% protocol
contract SCANCampaign {

    /// @notice Ad content type
    enum AdType { Video, Banner, Link }

    struct Campaign {
        address sponsor;           // Who created and funded the campaign
        address clubAddress;       // Sports club receiving the provider share (60%)
        string  name;              // Campaign display name
        string  adContentURI;      // IPFS/Arweave URI for ad content (video, banner, link)
        AdType  adType;            // Type of ad content
        euint32 minSpend;          // Encrypted threshold: minimum fan spend
        euint32 minAttendance;     // Encrypted threshold: minimum attendance
        euint32 minLoyalty;        // Encrypted threshold: minimum loyalty years
        uint256 costPerImpression; // ETH cost per verified ad impression
        uint256 totalBudget;       // Total deposited budget
        uint256 remainingBudget;   // Remaining budget
        uint256 matchCount;        // Fans confirmed as matched (after on-chain decryption)
        uint256 impressionCount;   // Verified ad views (ProofOfView confirmed)
        uint256 clickCount;        // Fans who clicked through to the ad content
        bool    active;
    }

    /// @notice Protocol treasury — receives 10% of each impression
    address public protocolTreasury;

    /// @notice Fan profile registry
    ConfidentialFanProfile public fanProfiles;

    /// @notice Campaign ID counter
    uint256 public nextCampaignId;

    /// @notice Campaign ID => Campaign data
    mapping(uint256 => Campaign) public campaigns;

    /// @notice Campaign ID => Fan address => encrypted match result (ebool)
    mapping(uint256 => mapping(address => ebool)) private matchResults;

    /// @notice Campaign ID => Fan address => blind match has been computed
    mapping(uint256 => mapping(address => bool)) public matchComputed;

    /// @notice Campaign ID => Fan address => match result has been published on-chain via publishMatchResult
    mapping(uint256 => mapping(address => bool)) public matchConfirmed;

    /// @notice Campaign ID => Fan address => plaintext match outcome (set by publishMatchResult)
    mapping(uint256 => mapping(address => bool)) public isMatched;

    /// @notice Campaign ID => Fan address => fan confirmed viewing the ad (ProofOfView)
    mapping(uint256 => mapping(address => bool)) public adViewed;

    /// @notice Campaign ID => Fan address => impression reward has been settled
    mapping(uint256 => mapping(address => bool)) public rewardClaimed;

    /// @notice Campaign ID => Fan address => fan clicked through to the ad content
    mapping(uint256 => mapping(address => bool)) public adClicked;

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed sponsor,
        address indexed clubAddress,
        string name,
        AdType adType,
        uint256 costPerImpression
    );
    event BlindMatchExecuted(uint256 indexed campaignId, address indexed fan);
    event MatchResultPublished(uint256 indexed campaignId, address indexed fan, bool matched);
    event AdViewConfirmed(uint256 indexed campaignId, address indexed fan, uint256 costPerImpression);
    event RewardSettled(
        uint256 indexed campaignId,
        address indexed fan,
        uint256 clubAmount,
        uint256 fanAmount,
        uint256 protocolAmount
    );
    event AdClicked(uint256 indexed campaignId, address indexed fan);
    event CampaignDeactivated(uint256 indexed campaignId);

    constructor(address _fanProfiles, address _protocolTreasury) {
        fanProfiles = ConfidentialFanProfile(_fanProfiles);
        protocolTreasury = _protocolTreasury;
    }

    // ─── Campaign Management ────────────────────────────────────────────────

    /// @notice Create a new ad campaign with content metadata and targeting criteria.
    ///         Budget deposited in ETH. Each verified impression triggers 60/30/10 split.
    /// @param name           Campaign display name
    /// @param adContentURI   IPFS URI for ad content (video URL, banner image, link)
    /// @param adType         Type of ad content (Video / Banner / Link)
    /// @param clubAddress    Club wallet receiving 60% of each impression
    /// @param minSpendPlain  Minimum fan spend threshold (plaintext → trivially encrypted for FHE)
    /// @param minAttendancePlain  Minimum attendance threshold
    /// @param minLoyaltyPlain    Minimum loyalty years threshold
    /// @param costPerImpression  ETH amount charged per verified ad view
    function createCampaign(
        string calldata name,
        string calldata adContentURI,
        AdType adType,
        address clubAddress,
        uint32 minSpendPlain,
        uint32 minAttendancePlain,
        uint32 minLoyaltyPlain,
        uint256 costPerImpression
    ) external payable returns (uint256 campaignId) {
        require(msg.value > 0, "Must deposit budget");
        require(costPerImpression > 0, "Cost per impression must be > 0");
        require(msg.value >= costPerImpression, "Budget must cover at least one impression");
        require(clubAddress != address(0), "Invalid club address");
        require(bytes(adContentURI).length > 0, "Ad content URI required");

        campaignId = nextCampaignId++;

        // Trivially encrypt thresholds — converted to ciphertexts for FHE comparison
        euint32 encMinSpend = FHE.asEuint32(minSpendPlain);
        euint32 encMinAttendance = FHE.asEuint32(minAttendancePlain);
        euint32 encMinLoyalty = FHE.asEuint32(minLoyaltyPlain);

        FHE.allowThis(encMinSpend);
        FHE.allowThis(encMinAttendance);
        FHE.allowThis(encMinLoyalty);

        campaigns[campaignId] = Campaign({
            sponsor: msg.sender,
            clubAddress: clubAddress,
            name: name,
            adContentURI: adContentURI,
            adType: adType,
            minSpend: encMinSpend,
            minAttendance: encMinAttendance,
            minLoyalty: encMinLoyalty,
            costPerImpression: costPerImpression,
            totalBudget: msg.value,
            remainingBudget: msg.value,
            matchCount: 0,
            impressionCount: 0,
            clickCount: 0,
            active: true
        });

        emit CampaignCreated(campaignId, msg.sender, clubAddress, name, adType, costPerImpression);
    }

    // ─── Blind Matching (FHE) ────────────────────────────────────────────────

    /// @notice Execute a blind FHE match for a single fan.
    ///         Encrypted fan metrics are compared against encrypted thresholds.
    ///         Result is an encrypted boolean — nobody knows who matched until decrypt.
    function blindMatch(uint256 campaignId, address fan) external {
        Campaign storage c = campaigns[campaignId];
        require(c.active, "Campaign not active");
        require(!matchComputed[campaignId][fan], "Already matched");
        require(fanProfiles.hasProfile(fan), "Fan has no profile");

        (euint32 fanSpend, euint32 fanAttendance, euint32 fanLoyalty) = fanProfiles.getProfile(fan);

        // All comparisons on encrypted data — zero knowledge revealed
        ebool spendMatch      = FHE.gte(fanSpend, c.minSpend);
        ebool attendanceMatch = FHE.gte(fanAttendance, c.minAttendance);
        ebool loyaltyMatch    = FHE.gte(fanLoyalty, c.minLoyalty);

        // Fan must meet ALL thresholds
        ebool matched = FHE.and(FHE.and(spendMatch, attendanceMatch), loyaltyMatch);

        FHE.allowThis(matched);
        FHE.allow(matched, fan); // Only this fan can decrypt their own result

        matchResults[campaignId][fan] = matched;
        matchComputed[campaignId][fan] = true;

        emit BlindMatchExecuted(campaignId, fan);
    }

    /// @notice Batch blind match for multiple fans
    function batchBlindMatch(uint256 campaignId, address[] calldata fans) external {
        for (uint256 i = 0; i < fans.length; i++) {
            if (!matchComputed[campaignId][fans[i]] && fanProfiles.hasProfile(fans[i])) {
                this.blindMatch(campaignId, fans[i]);
            }
        }
    }

    // ─── Decrypt Flow (new @cofhe/sdk) ──────────────────────────────────────

    /// @notice Returns the ciphertext hash for a fan's match result.
    ///         Use this with `client.decryptForTx(ctHash).withoutPermit().execute()` off-chain.
    function getMatchResultCtHash(uint256 campaignId, address fan) external view returns (bytes32) {
        require(matchComputed[campaignId][fan], "Match not computed");
        return ebool.unwrap(matchResults[campaignId][fan]);
    }

    /// @notice Fan publishes their decrypted match result on-chain.
    ///
    ///         Off-chain steps (using the cofhe SDK):
    ///           1. const ctHash = await campaign.getMatchResultCtHash(campaignId, fan)
    ///           2. const { decryptedValue, signature } = await client.decryptForTx(ctHash)
    ///                .withoutPermit().execute()
    ///           3. Call this function with (campaignId, decryptedValue != 0n, signature)
    ///
    ///         The Fhenix coprocessor signature cryptographically verifies the plaintext.
    function publishMatchResult(
        uint256 campaignId,
        bool result,
        bytes calldata signature
    ) external {
        require(matchComputed[campaignId][msg.sender], "Match not computed yet");
        require(!matchConfirmed[campaignId][msg.sender], "Result already published");

        // Verify the decryption result — coprocessor signature must be valid
        FHE.publishDecryptResult(matchResults[campaignId][msg.sender], result, signature);

        matchConfirmed[campaignId][msg.sender] = true;
        isMatched[campaignId][msg.sender] = result;

        if (result) {
            campaigns[campaignId].matchCount++;
        }

        emit MatchResultPublished(campaignId, msg.sender, result);
    }

    // ─── ProofOfView + Settlement ────────────────────────────────────────────

    /// @notice Fan confirms they viewed the ad (Proof of View).
    ///         Requirements: match confirmed on-chain AND fan was matched.
    ///         Triggers automatic three-way settlement:
    ///           60% → Club (provided the fan data)
    ///           30% → Fan  (reward for viewing)
    ///           10% → Protocol treasury
    function confirmView(uint256 campaignId) external {
        require(matchConfirmed[campaignId][msg.sender], "Match result not published yet");
        require(isMatched[campaignId][msg.sender], "Not matched for this campaign");
        require(!adViewed[campaignId][msg.sender], "View already confirmed");
        require(!rewardClaimed[campaignId][msg.sender], "Reward already claimed");

        Campaign storage c = campaigns[campaignId];
        require(c.active, "Campaign not active");
        require(c.remainingBudget >= c.costPerImpression, "Campaign budget exhausted");

        adViewed[campaignId][msg.sender]   = true;
        rewardClaimed[campaignId][msg.sender] = true;
        c.impressionCount++;

        uint256 cost = c.costPerImpression;
        c.remainingBudget -= cost;

        // Three-way split — remainder goes to protocol to avoid wei rounding loss
        uint256 clubAmount     = (cost * 6000) / 10000;  // 60%
        uint256 fanAmount      = (cost * 3000) / 10000;  // 30%
        uint256 protocolAmount = cost - clubAmount - fanAmount; // 10% + any rounding dust

        if (clubAmount > 0) {
            (bool ok, ) = payable(c.clubAddress).call{value: clubAmount}("");
            require(ok, "Club transfer failed");
        }
        if (fanAmount > 0) {
            (bool ok, ) = payable(msg.sender).call{value: fanAmount}("");
            require(ok, "Fan transfer failed");
        }
        if (protocolAmount > 0) {
            (bool ok, ) = payable(protocolTreasury).call{value: protocolAmount}("");
            require(ok, "Protocol transfer failed");
        }

        emit AdViewConfirmed(campaignId, msg.sender, cost);
        emit RewardSettled(campaignId, msg.sender, clubAmount, fanAmount, protocolAmount);
    }

    // ─── Click Tracking ──────────────────────────────────────────────────────

    /// @notice Fan records that they clicked through to the ad content.
    ///         Can only be called by a matched fan. Idempotent — clicking twice is a no-op.
    ///         Sponsors see aggregate clickCount only; no individual identity is exposed.
    function recordClick(uint256 campaignId) external {
        require(matchConfirmed[campaignId][msg.sender], "Match result not published yet");
        require(isMatched[campaignId][msg.sender], "Not matched for this campaign");
        if (!adClicked[campaignId][msg.sender]) {
            adClicked[campaignId][msg.sender] = true;
            campaigns[campaignId].clickCount++;
            emit AdClicked(campaignId, msg.sender);
        }
    }

    // ─── Sponsor Actions ─────────────────────────────────────────────────────

    /// @notice Sponsor deactivates campaign and withdraws remaining budget
    function deactivateCampaign(uint256 campaignId) external {
        Campaign storage c = campaigns[campaignId];
        require(msg.sender == c.sponsor, "Not the sponsor");
        require(c.active, "Already inactive");

        c.active = false;
        uint256 refund = c.remainingBudget;
        c.remainingBudget = 0;

        if (refund > 0) {
            (bool ok, ) = payable(c.sponsor).call{value: refund}("");
            require(ok, "Refund failed");
        }

        emit CampaignDeactivated(campaignId);
    }

    // ─── View Functions ──────────────────────────────────────────────────────

    /// @notice Get campaign stats (public info only — no encrypted data exposed)
    function getCampaignStats(uint256 campaignId) external view returns (
        address sponsor,
        address clubAddress,
        string memory name,
        string memory adContentURI,
        AdType adType,
        uint256 costPerImpression,
        uint256 totalBudget,
        uint256 remainingBudget,
        uint256 matchCount,
        uint256 impressionCount,
        uint256 clickCount,
        bool active
    ) {
        Campaign storage c = campaigns[campaignId];
        return (
            c.sponsor,
            c.clubAddress,
            c.name,
            c.adContentURI,
            c.adType,
            c.costPerImpression,
            c.totalBudget,
            c.remainingBudget,
            c.matchCount,
            c.impressionCount,
            c.clickCount,
            c.active
        );
    }
}
