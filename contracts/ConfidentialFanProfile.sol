// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @title ConfidentialFanProfile
/// @notice Stores encrypted fan metrics for the SCAN protocol.
///         Fan data (spending, attendance, loyalty) is encrypted client-side
///         and stored as FHE ciphertexts. Only the fan can view their own data.
contract ConfidentialFanProfile {

    struct EncryptedProfile {
        euint32 totalSpend;     // Lifetime spend in USD (encrypted)
        euint32 matchAttendance; // Number of matches attended (encrypted)
        euint32 loyaltyYears;   // Years as a club member (encrypted)
        bool    exists;
    }

    /// @notice Club admin who can register fans
    address public admin;

    /// @notice Fan address => encrypted profile
    mapping(address => EncryptedProfile) private profiles;

    /// @notice List of registered fan addresses (for campaign iteration)
    address[] public fanList;

    event ProfileRegistered(address indexed fan);
    event ProfileUpdated(address indexed fan);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    /// @notice Register a new fan profile with encrypted metrics.
    ///         Called by the club admin after the fan encrypts their data client-side.
    /// @param fan The fan's wallet address
    /// @param spend Encrypted total spend (InEuint32 from client)
    /// @param attendance Encrypted match attendance count
    /// @param loyalty Encrypted loyalty years
    function registerProfile(
        address fan,
        InEuint32 memory spend,
        InEuint32 memory attendance,
        InEuint32 memory loyalty
    ) external onlyAdmin {
        require(!profiles[fan].exists, "Profile already exists");

        euint32 encSpend = FHE.asEuint32(spend);
        euint32 encAttendance = FHE.asEuint32(attendance);
        euint32 encLoyalty = FHE.asEuint32(loyalty);

        // Allow this contract to operate on the encrypted values
        FHE.allowThis(encSpend);
        FHE.allowThis(encAttendance);
        FHE.allowThis(encLoyalty);

        // Allow the fan to view their own data
        FHE.allow(encSpend, fan);
        FHE.allow(encAttendance, fan);
        FHE.allow(encLoyalty, fan);

        profiles[fan] = EncryptedProfile({
            totalSpend: encSpend,
            matchAttendance: encAttendance,
            loyaltyYears: encLoyalty,
            exists: true
        });

        fanList.push(fan);
        emit ProfileRegistered(fan);
    }

    /// @notice Register a fan profile with plaintext values (admin only, for demo / club-side UI).
    ///         Values are trivially encrypted on-chain via FHE.asEuint32.
    ///         In production, replace with client-side encryption using the cofhe SDK.
    function adminRegisterPlain(
        address fan,
        uint32 spendPlain,
        uint32 attendancePlain,
        uint32 loyaltyPlain
    ) external onlyAdmin {
        require(!profiles[fan].exists, "Profile already exists");

        euint32 encSpend      = FHE.asEuint32(spendPlain);
        euint32 encAttendance = FHE.asEuint32(attendancePlain);
        euint32 encLoyalty    = FHE.asEuint32(loyaltyPlain);

        FHE.allowThis(encSpend);
        FHE.allowThis(encAttendance);
        FHE.allowThis(encLoyalty);
        FHE.allow(encSpend, fan);
        FHE.allow(encAttendance, fan);
        FHE.allow(encLoyalty, fan);

        profiles[fan] = EncryptedProfile({
            totalSpend: encSpend,
            matchAttendance: encAttendance,
            loyaltyYears: encLoyalty,
            exists: true
        });

        fanList.push(fan);
        emit ProfileRegistered(fan);
    }

    /// @notice Update an existing fan's encrypted profile
    function updateProfile(
        address fan,
        InEuint32 memory spend,
        InEuint32 memory attendance,
        InEuint32 memory loyalty
    ) external onlyAdmin {
        require(profiles[fan].exists, "Profile does not exist");

        euint32 encSpend = FHE.asEuint32(spend);
        euint32 encAttendance = FHE.asEuint32(attendance);
        euint32 encLoyalty = FHE.asEuint32(loyalty);

        FHE.allowThis(encSpend);
        FHE.allowThis(encAttendance);
        FHE.allowThis(encLoyalty);

        FHE.allow(encSpend, fan);
        FHE.allow(encAttendance, fan);
        FHE.allow(encLoyalty, fan);

        profiles[fan].totalSpend = encSpend;
        profiles[fan].matchAttendance = encAttendance;
        profiles[fan].loyaltyYears = encLoyalty;

        emit ProfileUpdated(fan);
    }

    /// @notice Get a fan's encrypted profile (only readable by permitted addresses)
    function getProfile(address fan) external view returns (
        euint32 totalSpend,
        euint32 matchAttendance,
        euint32 loyaltyYears
    ) {
        require(profiles[fan].exists, "Profile does not exist");
        EncryptedProfile storage p = profiles[fan];
        return (p.totalSpend, p.matchAttendance, p.loyaltyYears);
    }

    /// @notice Check if a fan has a registered profile
    function hasProfile(address fan) external view returns (bool) {
        return profiles[fan].exists;
    }

    /// @notice Get the total number of registered fans
    function getFanCount() external view returns (uint256) {
        return fanList.length;
    }

    /// @notice Get fan address by index (for campaign iteration)
    function getFanAt(uint256 index) external view returns (address) {
        require(index < fanList.length, "Index out of bounds");
        return fanList[index];
    }

    /// @notice Grant a campaign contract permission to read a fan's encrypted data.
    ///         Called by admin to enable blind matching.
    function grantCampaignAccess(address fan, address campaign) external onlyAdmin {
        require(profiles[fan].exists, "Profile does not exist");
        EncryptedProfile storage p = profiles[fan];
        FHE.allow(p.totalSpend, campaign);
        FHE.allow(p.matchAttendance, campaign);
        FHE.allow(p.loyaltyYears, campaign);
    }

    /// @notice Batch grant campaign access for multiple fans
    function batchGrantCampaignAccess(address[] calldata fans, address campaign) external onlyAdmin {
        for (uint256 i = 0; i < fans.length; i++) {
            if (profiles[fans[i]].exists) {
                EncryptedProfile storage p = profiles[fans[i]];
                FHE.allow(p.totalSpend, campaign);
                FHE.allow(p.matchAttendance, campaign);
                FHE.allow(p.loyaltyYears, campaign);
            }
        }
    }

    /// @notice Transfer admin role
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid address");
        admin = newAdmin;
    }
}
