import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { Encryptable } from '@cofhe/sdk'

describe('SCAN Protocol — Wave 2', function () {

	async function deploySCANFixture() {
		const [admin, sponsor, fan1, fan2, fan3, club, treasury] = await hre.ethers.getSigners()

		// Deploy ConfidentialFanProfile
		const FanProfile = await hre.ethers.getContractFactory('ConfidentialFanProfile')
		const fanProfile = await FanProfile.connect(admin).deploy()

		// Deploy SCANCampaign with protocol treasury
		const Campaign = await hre.ethers.getContractFactory('SCANCampaign')
		const campaign = await Campaign.connect(admin).deploy(
			await fanProfile.getAddress(),
			treasury.address
		)

		return { fanProfile, campaign, admin, sponsor, fan1, fan2, fan3, club, treasury }
	}

	// ──────────────────────────────────────────────────────────────────────────
	// ConfidentialFanProfile Tests
	// ──────────────────────────────────────────────────────────────────────────

	describe('ConfidentialFanProfile', function () {

		it('should register a fan profile with encrypted data', async function () {
			const { fanProfile, admin, fan1 } = await loadFixture(deploySCANFixture)

			// @cofhe/sdk: use createClientWithBatteries instead of initializeWithHardhatSigner
			const client = await hre.cofhe.createClientWithBatteries(admin)

			// Encrypt fan metrics: spend=1000, attendance=12, loyalty=3
			const [encSpend, encAttendance, encLoyalty] = await client.encryptInputs([
				Encryptable.uint32(1000n),
				Encryptable.uint32(12n),
				Encryptable.uint32(3n),
			]).execute()

			await fanProfile.connect(admin).registerProfile(
				fan1.address,
				encSpend,
				encAttendance,
				encLoyalty
			)

			expect(await fanProfile.hasProfile(fan1.address)).to.be.true
			expect(await fanProfile.getFanCount()).to.equal(1)
			expect(await fanProfile.getFanAt(0)).to.equal(fan1.address)
		})

		it('should reject duplicate profile registration', async function () {
			const { fanProfile, admin, fan1 } = await loadFixture(deploySCANFixture)
			const client = await hre.cofhe.createClientWithBatteries(admin)

			const [encSpend, encAttendance, encLoyalty] = await client.encryptInputs([
				Encryptable.uint32(500n),
				Encryptable.uint32(5n),
				Encryptable.uint32(1n),
			]).execute()

			await fanProfile.connect(admin).registerProfile(fan1.address, encSpend, encAttendance, encLoyalty)

			await expect(
				fanProfile.connect(admin).registerProfile(fan1.address, encSpend, encAttendance, encLoyalty)
			).to.be.revertedWith('Profile already exists')
		})

		it('should reject non-admin registration', async function () {
			const { fanProfile, fan1, fan2 } = await loadFixture(deploySCANFixture)
			const client = await hre.cofhe.createClientWithBatteries(fan1)

			const [encSpend, encAttendance, encLoyalty] = await client.encryptInputs([
				Encryptable.uint32(100n),
				Encryptable.uint32(1n),
				Encryptable.uint32(1n),
			]).execute()

			await expect(
				fanProfile.connect(fan1).registerProfile(fan2.address, encSpend, encAttendance, encLoyalty)
			).to.be.revertedWith('Only admin')
		})
	})

	// ──────────────────────────────────────────────────────────────────────────
	// SCANCampaign — Wave 2 Feature Tests
	// ──────────────────────────────────────────────────────────────────────────

	describe('SCANCampaign — Campaign Creation (Wave 2)', function () {

		it('should create a campaign with adContentURI, adType, and clubAddress', async function () {
			const { campaign, sponsor, club } = await loadFixture(deploySCANFixture)

			const costPerImpression = hre.ethers.parseEther('0.01')
			await campaign.connect(sponsor).createCampaign(
				'Nike Spring 2026',
				'ipfs://QmNike2026SportsBanner',
				0, // AdType.Video
				club.address,
				500,  // minSpend
				5,    // minAttendance
				2,    // minLoyalty
				costPerImpression,
				{ value: hre.ethers.parseEther('1.0') }
			)

			const stats = await campaign.getCampaignStats(0)
			expect(stats.sponsor).to.equal(sponsor.address)
			expect(stats.clubAddress).to.equal(club.address)
			expect(stats.name).to.equal('Nike Spring 2026')
			expect(stats.adContentURI).to.equal('ipfs://QmNike2026SportsBanner')
			expect(stats.adType).to.equal(0) // AdType.Video
			expect(stats.costPerImpression).to.equal(costPerImpression)
			expect(stats.active).to.be.true
			expect(stats.matchCount).to.equal(0)
			expect(stats.impressionCount).to.equal(0)
		})

		it('should reject campaign with zero budget', async function () {
			const { campaign, sponsor, club } = await loadFixture(deploySCANFixture)

			await expect(
				campaign.connect(sponsor).createCampaign(
					'Test', 'ipfs://test', 1, club.address, 100, 1, 1,
					hre.ethers.parseEther('0.01'),
					{ value: 0 }
				)
			).to.be.revertedWith('Must deposit budget')
		})

		it('should reject campaign with zero costPerImpression', async function () {
			const { campaign, sponsor, club } = await loadFixture(deploySCANFixture)

			await expect(
				campaign.connect(sponsor).createCampaign(
					'Test', 'ipfs://test', 0, club.address, 100, 1, 1,
					0, // zero cost
					{ value: hre.ethers.parseEther('1.0') }
				)
			).to.be.revertedWith('Cost per impression must be > 0')
		})
	})

	describe('SCANCampaign — Blind Matching', function () {

		it('should execute blind match for a qualifying fan', async function () {
			const { fanProfile, campaign, admin, sponsor, fan1, club } = await loadFixture(deploySCANFixture)

			const client = await hre.cofhe.createClientWithBatteries(admin)

			// Register fan: spend=1000, attendance=12, loyalty=3
			const [encSpend, encAttendance, encLoyalty] = await client.encryptInputs([
				Encryptable.uint32(1000n),
				Encryptable.uint32(12n),
				Encryptable.uint32(3n),
			]).execute()

			await fanProfile.connect(admin).registerProfile(fan1.address, encSpend, encAttendance, encLoyalty)
			await fanProfile.connect(admin).grantCampaignAccess(fan1.address, await campaign.getAddress())

			// Create campaign: spend>=500, attendance>=5, loyalty>=2
			const costPerImpression = hre.ethers.parseEther('0.01')
			await campaign.connect(sponsor).createCampaign(
				'Adidas Test', 'ipfs://QmAdidas', 0, club.address,
				500, 5, 2, costPerImpression,
				{ value: hre.ethers.parseEther('1.0') }
			)

			// Execute blind match — fan1 qualifies (1000>=500, 12>=5, 3>=2)
			await campaign.blindMatch(0, fan1.address)
			expect(await campaign.matchComputed(0, fan1.address)).to.be.true

			// Verify ctHash is available for off-chain decryption
			const ctHash = await campaign.getMatchResultCtHash(0, fan1.address)
			expect(ctHash).to.not.equal('0x' + '00'.repeat(32))
		})
	})

	describe('SCANCampaign — ProofOfView + Three-Way Settlement (Wave 2)', function () {

		it('Full flow: match → publishMatchResult → confirmView → three-way split', async function () {
			const { fanProfile, campaign, admin, sponsor, fan1, club, treasury } = await loadFixture(deploySCANFixture)

			// Setup: register fan and create campaign
			const adminClient = await hre.cofhe.createClientWithBatteries(admin)

			const [encSpend, encAttendance, encLoyalty] = await adminClient.encryptInputs([
				Encryptable.uint32(1000n),
				Encryptable.uint32(12n),
				Encryptable.uint32(3n),
			]).execute()

			await fanProfile.connect(admin).registerProfile(fan1.address, encSpend, encAttendance, encLoyalty)
			await fanProfile.connect(admin).grantCampaignAccess(fan1.address, await campaign.getAddress())

			const costPerImpression = hre.ethers.parseEther('0.01')
			await campaign.connect(sponsor).createCampaign(
				'Nike ProofOfView Test', 'ipfs://QmNikePov', 1 /* Banner */, club.address,
				500, 5, 2, costPerImpression,
				{ value: hre.ethers.parseEther('1.0') }
			)

			// Blind match
			await campaign.blindMatch(0, fan1.address)
			expect(await campaign.matchComputed(0, fan1.address)).to.be.true

			// Off-chain: fan gets ctHash and decrypts via new SDK
			const ctHash = await campaign.getMatchResultCtHash(0, fan1.address)
			const fan1Client = await hre.cofhe.createClientWithBatteries(fan1)
			const decryptResult = await fan1Client.decryptForTx(ctHash).withPermit().execute()

			// On-chain: fan publishes decrypted match result
			const matched = decryptResult.decryptedValue !== 0n
			await campaign.connect(fan1).publishMatchResult(0, matched, decryptResult.signature)

			expect(await campaign.matchConfirmed(0, fan1.address)).to.be.true
			expect(await campaign.isMatched(0, fan1.address)).to.be.true

			// Snapshot balances before confirmView
			const clubBefore     = await hre.ethers.provider.getBalance(club.address)
			const fan1Before     = await hre.ethers.provider.getBalance(fan1.address)
			const treasuryBefore = await hre.ethers.provider.getBalance(treasury.address)

			// ProofOfView: fan confirms they viewed the ad → triggers settlement
			const tx = await campaign.connect(fan1).confirmView(0)
			const receipt = await tx.wait()
			const gasUsed = receipt!.gasUsed * receipt!.gasPrice

			const clubAfter     = await hre.ethers.provider.getBalance(club.address)
			const fan1After     = await hre.ethers.provider.getBalance(fan1.address)
			const treasuryAfter = await hre.ethers.provider.getBalance(treasury.address)

			// Verify three-way split: 60% club / 30% fan / 10% protocol
			const expectedClub     = (costPerImpression * 6000n) / 10000n
			const expectedFan      = (costPerImpression * 3000n) / 10000n
			const expectedProtocol = costPerImpression - expectedClub - expectedFan

			expect(clubAfter - clubBefore).to.equal(expectedClub)
			expect(fan1After - fan1Before + gasUsed).to.equal(expectedFan)
			expect(treasuryAfter - treasuryBefore).to.equal(expectedProtocol)

			// Verify campaign counters
			const stats = await campaign.getCampaignStats(0)
			expect(stats.matchCount).to.equal(1)
			expect(stats.impressionCount).to.equal(1)

			// Cannot confirm view twice
			await expect(campaign.connect(fan1).confirmView(0)).to.be.revertedWith('View already confirmed')
		})

		it('should reject confirmView if match not published', async function () {
			const { fanProfile, campaign, admin, sponsor, fan1, club } = await loadFixture(deploySCANFixture)

			const client = await hre.cofhe.createClientWithBatteries(admin)
			const [enc1, enc2, enc3] = await client.encryptInputs([
				Encryptable.uint32(1000n), Encryptable.uint32(12n), Encryptable.uint32(3n),
			]).execute()
			await fanProfile.connect(admin).registerProfile(fan1.address, enc1, enc2, enc3)
			await fanProfile.connect(admin).grantCampaignAccess(fan1.address, await campaign.getAddress())

			await campaign.connect(sponsor).createCampaign(
				'Test', 'ipfs://test', 0, club.address, 500, 5, 2,
				hre.ethers.parseEther('0.01'),
				{ value: hre.ethers.parseEther('1.0') }
			)
			await campaign.blindMatch(0, fan1.address)

			// Attempt confirmView before publishing match result
			await expect(
				campaign.connect(fan1).confirmView(0)
			).to.be.revertedWith('Match result not published yet')
		})

		it('should reject confirmView if fan was not matched', async function () {
			const { fanProfile, campaign, admin, sponsor, fan2, club } = await loadFixture(deploySCANFixture)

			const client = await hre.cofhe.createClientWithBatteries(admin)
			// fan2 has LOW stats — will NOT match campaign thresholds
			const [enc1, enc2, enc3] = await client.encryptInputs([
				Encryptable.uint32(10n),  // spend too low
				Encryptable.uint32(1n),   // attendance too low
				Encryptable.uint32(0n),   // loyalty too low
			]).execute()
			await fanProfile.connect(admin).registerProfile(fan2.address, enc1, enc2, enc3)
			await fanProfile.connect(admin).grantCampaignAccess(fan2.address, await campaign.getAddress())

			const costPerImpression = hre.ethers.parseEther('0.01')
			await campaign.connect(sponsor).createCampaign(
				'High Bar Campaign', 'ipfs://highbar', 0, club.address,
				500, 5, 2, costPerImpression,
				{ value: hre.ethers.parseEther('1.0') }
			)

			await campaign.blindMatch(0, fan2.address)

			// Decrypt the match result — fan2 should NOT be matched
			const ctHash = await campaign.getMatchResultCtHash(0, fan2.address)
			const fan2Client = await hre.cofhe.createClientWithBatteries(fan2)
			const decryptResult = await fan2Client.decryptForTx(ctHash).withPermit().execute()
			const matched = decryptResult.decryptedValue !== 0n

			await campaign.connect(fan2).publishMatchResult(0, matched, decryptResult.signature)
			expect(await campaign.isMatched(0, fan2.address)).to.be.false

			await expect(
				campaign.connect(fan2).confirmView(0)
			).to.be.revertedWith('Not matched for this campaign')
		})

		it('should handle campaign deactivation and refund', async function () {
			const { campaign, sponsor, club } = await loadFixture(deploySCANFixture)

			const budget = hre.ethers.parseEther('1.0')
			await campaign.connect(sponsor).createCampaign(
				'Test Campaign', 'ipfs://test', 2 /* Link */, club.address, 100, 1, 1,
				hre.ethers.parseEther('0.01'),
				{ value: budget }
			)

			const balanceBefore = await hre.ethers.provider.getBalance(sponsor.address)
			const tx = await campaign.connect(sponsor).deactivateCampaign(0)
			const receipt = await tx.wait()
			const gasUsed = receipt!.gasUsed * receipt!.gasPrice
			const balanceAfter = await hre.ethers.provider.getBalance(sponsor.address)

			const stats = await campaign.getCampaignStats(0)
			expect(stats.active).to.be.false
			expect(stats.remainingBudget).to.equal(0)
			// Sponsor got budget back (minus gas)
			expect(balanceAfter - balanceBefore + gasUsed).to.equal(budget)
		})
	})
})
