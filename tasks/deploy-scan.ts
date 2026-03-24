import { task } from 'hardhat/config'
import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { saveDeployment } from './utils'

task('deploy-scan', 'Deploy the SCAN protocol contracts').setAction(async (_, hre: HardhatRuntimeEnvironment) => {
	const { ethers, network } = hre

	console.log(`\n🚀 Deploying SCAN to ${network.name}...\n`)

	const [deployer] = await ethers.getSigners()
	console.log(`Deployer: ${deployer.address}`)
	const balance = await ethers.provider.getBalance(deployer.address)
	console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`)

	// 1. Deploy ConfidentialFanProfile
	console.log('Deploying ConfidentialFanProfile...')
	const FanProfile = await ethers.getContractFactory('ConfidentialFanProfile')
	const fanProfile = await FanProfile.deploy()
	await fanProfile.waitForDeployment()
	const fanProfileAddr = await fanProfile.getAddress()
	console.log(`ConfidentialFanProfile: ${fanProfileAddr}`)
	saveDeployment(network.name, 'ConfidentialFanProfile', fanProfileAddr)

	// 2. Deploy SCANCampaign
	console.log('\nDeploying SCANCampaign...')
	const Campaign = await ethers.getContractFactory('SCANCampaign')
	const campaign = await Campaign.deploy(fanProfileAddr)
	await campaign.waitForDeployment()
	const campaignAddr = await campaign.getAddress()
	console.log(`SCANCampaign: ${campaignAddr}`)
	saveDeployment(network.name, 'SCANCampaign', campaignAddr)

	console.log('\n✅ SCAN deployment complete!')
	console.log(`  FanProfile: ${fanProfileAddr}`)
	console.log(`  Campaign:   ${campaignAddr}`)
})
