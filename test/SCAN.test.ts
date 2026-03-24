import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import hre from 'hardhat'
import { cofhejs, Encryptable } from 'cofhejs/node'

describe('SCAN Protocol', function () {
	async function deploySCANFixture() {
		const [admin, sponsor, fan1, fan2, fan3] = await hre.ethers.getSigners()

		// Deploy ConfidentialFanProfile
		const FanProfile = await hre.ethers.getContractFactory('ConfidentialFanProfile')
		const fanProfile = await FanProfile.connect(admin).deploy()

		// Deploy SCANCampaign
		const Campaign = await hre.ethers.getContractFactory('SCANCampaign')
		const campaign = await Campaign.connect(admin).deploy(await fanProfile.getAddress())

		return { fanProfile, campaign, admin, sponsor, fan1, fan2, fan3 }
	}

	describe('ConfidentialFanProfile', function () {
		beforeEach(function () {
			if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
		})

		it('should register a fan profile with encrypted data', async function () {
			const { fanProfile, admin, fan1 } = await loadFixture(deploySCANFixture)

			// Initialize cofhejs for the admin (who submits the encrypted data)
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(admin))

			// Encrypt fan metrics: spend=1000, attendance=12, loyalty=3
			const [encSpend, encAttendance, encLoyalty] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([
					Encryptable.uint32(1000n),
					Encryptable.uint32(12n),
					Encryptable.uint32(3n),
				] as const)
			)

			// Register the fan profile
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
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(admin))

			const [encSpend, encAttendance, encLoyalty] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([
					Encryptable.uint32(500n),
					Encryptable.uint32(5n),
					Encryptable.uint32(1n),
				] as const)
			)

			await fanProfile.connect(admin).registerProfile(fan1.address, encSpend, encAttendance, encLoyalty)

			await expect(
				fanProfile.connect(admin).registerProfile(fan1.address, encSpend, encAttendance, encLoyalty)
			).to.be.revertedWith('Profile already exists')
		})

		it('should reject non-admin registration', async function () {
			const { fanProfile, fan1, fan2 } = await loadFixture(deploySCANFixture)
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(fan1))

			const [encSpend, encAttendance, encLoyalty] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([
					Encryptable.uint32(100n),
					Encryptable.uint32(1n),
					Encryptable.uint32(1n),
				] as const)
			)

			await expect(
				fanProfile.connect(fan1).registerProfile(fan2.address, encSpend, encAttendance, encLoyalty)
			).to.be.revertedWith('Only admin')
		})
	})

	describe('SCANCampaign - Blind Matching', function () {
		beforeEach(function () {
			if (!hre.cofhe.isPermittedEnvironment('MOCK')) this.skip()
		})

		it('should create a campaign and execute blind match', async function () {
			const { fanProfile, campaign, admin, sponsor, fan1 } = await loadFixture(deploySCANFixture)

			// --- Setup: Register a fan with spend=1000, attendance=12, loyalty=3 ---
			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(admin))

			const [encSpend, encAttendance, encLoyalty] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([
					Encryptable.uint32(1000n),
					Encryptable.uint32(12n),
					Encryptable.uint32(3n),
				] as const)
			)

			await fanProfile.connect(admin).registerProfile(
				fan1.address, encSpend, encAttendance, encLoyalty
			)

			// Grant campaign contract access to fan's encrypted data
			await fanProfile.connect(admin).grantCampaignAccess(
				fan1.address,
				await campaign.getAddress()
			)

			// --- Sponsor: Create campaign targeting spend>=500, attendance>=5, loyalty>=2 ---
			const rewardPerFan = hre.ethers.parseEther('0.01')
			await campaign.connect(sponsor).createCampaign(
				'Nike Spring Campaign',
				500,  // minSpend
				5,    // minAttendance
				2,    // minLoyalty
				rewardPerFan,
				{ value: hre.ethers.parseEther('1.0') }
			)

			// Verify campaign was created
			const stats = await campaign.getCampaignStats(0)
			expect(stats.sponsor).to.equal(sponsor.address)
			expect(stats.name).to.equal('Nike Spring Campaign')
			expect(stats.active).to.be.true

			// --- Execute Blind Match ---
			// Fan1 has spend=1000>=500, attendance=12>=5, loyalty=3>=2 → should match
			await campaign.blindMatch(0, fan1.address)
			expect(await campaign.matchComputed(0, fan1.address)).to.be.true
		})

		it('should match a qualifying fan and allow reward claim', async function () {
			const { fanProfile, campaign, admin, sponsor, fan1 } = await loadFixture(deploySCANFixture)

			await hre.cofhe.expectResultSuccess(hre.cofhe.initializeWithHardhatSigner(admin))

			// Register fan: spend=1000, attendance=12, loyalty=3
			const [encSpend, encAttendance, encLoyalty] = await hre.cofhe.expectResultSuccess(
				cofhejs.encrypt([
					Encryptable.uint32(1000n),
					Encryptable.uint32(12n),
					Encryptable.uint32(3n),
				] as const)
			)
			await fanProfile.connect(admin).registerProfile(fan1.address, encSpend, encAttendance, encLoyalty)
			await fanProfile.connect(admin).grantCampaignAccess(fan1.address, await campaign.getAddress())

			// Create campaign: spend>=500, attendance>=5, loyalty>=2
			const rewardPerFan = hre.ethers.parseEther('0.01')
			await campaign.connect(sponsor).createCampaign(
				'Adidas Loyalty Reward',
				500, 5, 2,
				rewardPerFan,
				{ value: hre.ethers.parseEther('1.0') }
			)

			// Blind match
			await campaign.blindMatch(0, fan1.address)

			// Fan requests decryption
			await campaign.connect(fan1).requestMatchResult(0)

			// Advance time to allow mock async decryption to complete
			await time.increase(15)
			const balanceBefore = await hre.ethers.provider.getBalance(fan1.address)
			const tx = await campaign.connect(fan1).claimReward(0)
			const receipt = await tx.wait()
			const gasUsed = receipt!.gasUsed * receipt!.gasPrice
			const balanceAfter = await hre.ethers.provider.getBalance(fan1.address)

			// Fan1 qualifies (1000>=500, 12>=5, 3>=2) → should receive reward
			// In mock mode, encrypted comparisons return true for gte when lhs >= rhs
			const stats = await campaign.getCampaignStats(0)
			expect(await campaign.rewardClaimed(0, fan1.address)).to.be.true
		})

		it('should handle campaign deactivation and refund', async function () {
			const { campaign, sponsor } = await loadFixture(deploySCANFixture)

			const budget = hre.ethers.parseEther('1.0')
			await campaign.connect(sponsor).createCampaign(
				'Test Campaign', 100, 1, 1,
				hre.ethers.parseEther('0.01'),
				{ value: budget }
			)

			const balanceBefore = await hre.ethers.provider.getBalance(sponsor.address)
			const tx = await campaign.connect(sponsor).deactivateCampaign(0)
			await tx.wait()

			const stats = await campaign.getCampaignStats(0)
			expect(stats.active).to.be.false
			expect(stats.remainingBudget).to.equal(0)
		})
	})
})
