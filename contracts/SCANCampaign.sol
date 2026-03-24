// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./ConfidentialFanProfile.sol";

/// @title SCANCampaign
/// @notice The FHE Matching Engine for SCAN. Sponsors create campaigns with
///         targeting criteria. The contract performs blind matching against
///         encrypted fan profiles — no one sees who matched until the fan claims.
contract SCANCampaign {

    struct Campaign {
        address sponsor;           // Who created (and funded) the campaign
        string  name;              // Campaign display name
        euint32 minSpend;          // Encrypted threshold: minimum fan spend
        euint32 minAttendance;     // Encrypted threshold: minimum attendance
        euint32 minLoyalty;        // Encrypted threshold: minimum loyalty years
        uint256 rewardPerFan;      // Reward amount per matched fan (in wei)
        uint256 totalBudget;       // Total deposited budget
        uint256 remainingBudget;   // Remaining budget
        uint256 matchCount;        // Number of successful matches (aggregate only)
        bool    active;
    }

    /// @notice Reference to the fan profile contract
    ConfidentialFanProfile public fanProfiles;

    /// @notice Campaign ID counter
    uint256 public nextCampaignId;

    /// @notice Campaign ID => Campaign data
    mapping(uint256 => Campaign) public campaigns;

    /// @notice Campaign ID => Fan address => encrypted match result
    mapping(uint256 => mapping(address => ebool)) private matchResults;

    /// @notice Campaign ID => Fan address => whether match has been computed
    mapping(uint256 => mapping(address => bool)) public matchComputed;

    /// @notice Campaign ID => Fan address => whether reward was claimed
    mapping(uint256 => mapping(address => bool)) public rewardClaimed;

    event CampaignCreated(uint256 indexed campaignId, address indexed sponsor, string name);
    event BlindMatchExecuted(uint256 indexed campaignId, address indexed fan);
    event RewardClaimed(uint256 indexed campaignId, address indexed fan, uint256 amount);
    event CampaignDeactivated(uint256 indexed campaignId);

    constructor(address _fanProfiles) {
        fanProfiles = ConfidentialFanProfile(_fanProfiles);
    }

    /// @notice Create a new campaign with targeting thresholds.
    ///         Thresholds are trivially encrypted on-chain (public values converted to ciphertexts)
    ///         so they can be compared with encrypted fan data via FHE operations.
    /// @param name Campaign display name
    /// @param minSpendPlain Minimum spend threshold (plaintext, will be trivially encrypted)
    /// @param minAttendancePlain Minimum attendance threshold
    /// @param minLoyaltyPlain Minimum loyalty years threshold
    /// @param rewardPerFan Amount of ETH reward per matched fan (in wei)
    function createCampaign(
        string calldata name,
        uint32 minSpendPlain,
        uint32 minAttendancePlain,
        uint32 minLoyaltyPlain,
        uint256 rewardPerFan
    ) external payable returns (uint256 campaignId) {
        require(msg.value > 0, "Must deposit budget");
        require(rewardPerFan > 0, "Reward must be > 0");

        campaignId = nextCampaignId++;

        // Trivially encrypt thresholds (these become ciphertexts for FHE comparison)
        euint32 encMinSpend = FHE.asEuint32(minSpendPlain);
        euint32 encMinAttendance = FHE.asEuint32(minAttendancePlain);
        euint32 encMinLoyalty = FHE.asEuint32(minLoyaltyPlain);

        FHE.allowThis(encMinSpend);
        FHE.allowThis(encMinAttendance);
        FHE.allowThis(encMinLoyalty);

        campaigns[campaignId] = Campaign({
            sponsor: msg.sender,
            name: name,
            minSpend: encMinSpend,
            minAttendance: encMinAttendance,
            minLoyalty: encMinLoyalty,
            rewardPerFan: rewardPerFan,
            totalBudget: msg.value,
            remainingBudget: msg.value,
            matchCount: 0,
            active: true
        });

        emit CampaignCreated(campaignId, msg.sender, name);
    }

    /// @notice Execute a blind match for a single fan against a campaign.
    ///         The FHE engine compares encrypted fan data against encrypted thresholds.
    ///         Result is an encrypted boolean — nobody knows who matched.
    /// @param campaignId The campaign to match against
    /// @param fan The fan address to evaluate
    function blindMatch(uint256 campaignId, address fan) external {
        Campaign storage c = campaigns[campaignId];
        require(c.active, "Campaign not active");
        require(!matchComputed[campaignId][fan], "Already matched");
        require(fanProfiles.hasProfile(fan), "Fan has no profile");

        // Fetch encrypted fan metrics
        (euint32 fanSpend, euint32 fanAttendance, euint32 fanLoyalty) = fanProfiles.getProfile(fan);

        // FHE Blind Match: compare encrypted fan data against encrypted thresholds
        // All comparisons happen on encrypted data — no plaintext is revealed
        ebool spendMatch = FHE.gte(fanSpend, c.minSpend);
        ebool attendanceMatch = FHE.gte(fanAttendance, c.minAttendance);
        ebool loyaltyMatch = FHE.gte(fanLoyalty, c.minLoyalty);

        // Combine all conditions: fan must meet ALL thresholds
        ebool isMatch = FHE.and(spendMatch, attendanceMatch);
        isMatch = FHE.and(isMatch, loyaltyMatch);

        // Store encrypted result — only the fan can later decrypt to check
        FHE.allowThis(isMatch);
        FHE.allow(isMatch, fan);

        matchResults[campaignId][fan] = isMatch;
        matchComputed[campaignId][fan] = true;

        emit BlindMatchExecuted(campaignId, fan);
    }

    /// @notice Execute blind match for a batch of fans
    function batchBlindMatch(uint256 campaignId, address[] calldata fans) external {
        for (uint256 i = 0; i < fans.length; i++) {
            if (!matchComputed[campaignId][fans[i]] && fanProfiles.hasProfile(fans[i])) {
                this.blindMatch(campaignId, fans[i]);
            }
        }
    }

    /// @notice Fan initiates decryption of their match result.
    ///         This triggers async decryption — result available in a later call.
    function requestMatchResult(uint256 campaignId) external {
        require(matchComputed[campaignId][msg.sender], "Match not computed");
        require(!rewardClaimed[campaignId][msg.sender], "Already claimed");

        ebool result = matchResults[campaignId][msg.sender];
        FHE.decrypt(result);
    }

    /// @notice Fan claims reward after decryption is ready.
    ///         The decrypted match result reveals whether the fan qualified.
    function claimReward(uint256 campaignId) external {
        require(matchComputed[campaignId][msg.sender], "Match not computed");
        require(!rewardClaimed[campaignId][msg.sender], "Already claimed");

        Campaign storage c = campaigns[campaignId];
        require(c.active, "Campaign not active");
        require(c.remainingBudget >= c.rewardPerFan, "Campaign budget exhausted");

        // Get the decrypted match result
        ebool result = matchResults[campaignId][msg.sender];
        (bool matched, bool isReady) = FHE.getDecryptResultSafe(result);
        require(isReady, "Decryption not ready yet");

        rewardClaimed[campaignId][msg.sender] = true;

        // If the fan matched, send reward
        if (matched) {
            c.remainingBudget -= c.rewardPerFan;
            c.matchCount++;

            (bool sent, ) = payable(msg.sender).call{value: c.rewardPerFan}("");
            require(sent, "Transfer failed");

            emit RewardClaimed(campaignId, msg.sender, c.rewardPerFan);
        }
    }

    /// @notice Sponsor can deactivate their campaign and withdraw remaining budget
    function deactivateCampaign(uint256 campaignId) external {
        Campaign storage c = campaigns[campaignId];
        require(msg.sender == c.sponsor, "Not the sponsor");
        require(c.active, "Already inactive");

        c.active = false;
        uint256 refund = c.remainingBudget;
        c.remainingBudget = 0;

        if (refund > 0) {
            (bool sent, ) = payable(c.sponsor).call{value: refund}("");
            require(sent, "Refund failed");
        }

        emit CampaignDeactivated(campaignId);
    }

    /// @notice Get campaign stats (public info only — no encrypted data exposed)
    function getCampaignStats(uint256 campaignId) external view returns (
        address sponsor,
        string memory name,
        uint256 rewardPerFan,
        uint256 totalBudget,
        uint256 remainingBudget,
        uint256 matchCount,
        bool active
    ) {
        Campaign storage c = campaigns[campaignId];
        return (
            c.sponsor,
            c.name,
            c.rewardPerFan,
            c.totalBudget,
            c.remainingBudget,
            c.matchCount,
            c.active
        );
    }
}
