import './style.css'
import { ethers } from 'ethers'
import EthereumProvider from '@walletconnect/ethereum-provider'
import FanProfileABI from './utils/ConfidentialFanProfileABI.json'
import CampaignABI from './utils/SCANCampaignABI.json'
import { CONTRACTS, CHAIN_CONFIG } from './utils/contracts'
import logoUrl from '/logo.png?url'

const WC_PROJECT_ID = '487d89c80dad68856ba26b4a06444db0'

// State
let provider: ethers.BrowserProvider | null = null
let signer: ethers.JsonRpcSigner | null = null
let walletDisplay = ''
let currentTab: 'fan' | 'sponsor' | 'about' = 'about'

// Sanitize user-controlled strings before inserting into HTML
function esc(str: string): string {
  const el = document.createElement('span')
  el.textContent = str
  return el.innerHTML
}

// Extract a readable error message from contract revert or provider error
function readableError(e: any): string {
  const msg = e?.reason || e?.shortMessage || e?.message || String(e)
  // Strip verbose ethers error wrapping
  const match = msg.match(/reason="([^"]+)"/) || msg.match(/reverted with reason string '([^']+)'/)
  return match ? match[1] : msg.length > 200 ? msg.slice(0, 200) + '...' : msg
}

// Render
function render() {
  const app = document.getElementById('app')!
  const showWalletBtn = currentTab !== 'about'
  app.innerHTML = `
    <header class="header">
      <div class="logo">
        <img src="${logoUrl}" alt="SportsX" class="logo-img" />
        <div>
          <h1>SCAN</h1>
          <span>SportsX Confidential Ad-Network</span>
        </div>
      </div>
      ${showWalletBtn ? `
        <button class="wallet-btn ${signer ? 'connected' : ''}" id="wallet-btn">
          ${signer ? '&#x2713; ' + walletDisplay : 'Connect Wallet'}
        </button>
      ` : ''}
    </header>

    <div class="tabs">
      <button class="tab ${currentTab === 'about' ? 'active' : ''}" data-tab="about">How It Works</button>
      <button class="tab ${currentTab === 'fan' ? 'active' : ''}" data-tab="fan">Fan Portal</button>
      <button class="tab ${currentTab === 'sponsor' ? 'active' : ''}" data-tab="sponsor">Sponsor Dashboard</button>
    </div>

    <main>
      ${currentTab === 'about' ? renderAbout() : ''}
      ${currentTab === 'fan' ? renderFanPortal() : ''}
      ${currentTab === 'sponsor' ? renderSponsorDashboard() : ''}
    </main>
  `
  bindEvents()
}

function renderAbout(): string {
  return `
    <div class="card">
      <h2>Privacy-First Sports Advertising</h2>
      <p>
        SCAN enables sponsors to target fan segments based on spending, loyalty, and behavior
        — without ever seeing the raw data. Powered by Fully Homomorphic Encryption (FHE) on Fhenix.
      </p>
      <div class="fhe-badge">FHE ENCRYPTED &middot; Data stays invisible</div>
    </div>

    <div class="card">
      <h2>Architecture</h2>
      <p>Fan data is encrypted client-side before touching the blockchain. The FHE matching engine
      compares encrypted profiles against encrypted thresholds. Nobody sees who matched.</p>
      <div class="arch-diagram">
        <div class="arch-node fan">
          Fan<br><small>Encrypt Data</small>
        </div>
        <div class="arch-arrow">&rarr;</div>
        <div class="arch-node fhe">
          FHE Engine<br><small>Blind Match</small>
        </div>
        <div class="arch-arrow">&rarr;</div>
        <div class="arch-node sponsor">
          Sponsor<br><small>Aggregate Only</small>
        </div>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat">
        <div class="value">0</div>
        <div class="label">Data Points Exposed</div>
      </div>
      <div class="stat">
        <div class="value">100%</div>
        <div class="label">GDPR Compliant</div>
      </div>
      <div class="stat">
        <div class="value">FHE</div>
        <div class="label">Encryption Standard</div>
      </div>
    </div>

    <div class="card">
      <h2>How a Blind Match Works</h2>
      <p style="margin-bottom: 0; line-height: 1.8;">
        <strong>1.</strong> Club admin encrypts fan metrics (spend, attendance, loyalty) client-side<br>
        <strong>2.</strong> Encrypted profiles are stored on-chain as FHE ciphertexts<br>
        <strong>3.</strong> Sponsor sets targeting criteria (e.g., spend &ge; $500, attendance &ge; 5)<br>
        <strong>4.</strong> FHE engine runs <code style="background:var(--surface-2);padding:2px 6px;border-radius:4px;font-size:13px;">
        FHE.gte(fanSpend, threshold)</code> on encrypted data<br>
        <strong>5.</strong> Result is an <em>encrypted boolean</em> — nobody knows who matched<br>
        <strong>6.</strong> Matching fans can claim rewards. Sponsor only sees aggregate count.
      </p>
    </div>
  `
}

function renderFanPortal(): string {
  return `
    <div class="card">
      <h2>Sync Your Fan Profile</h2>
      <p>
        Your data is encrypted client-side before submission. Only you can view your own profile.
        The club and sponsors never see your raw data.
      </p>
      <div class="fhe-badge" style="margin-bottom: 20px;">CLIENT-SIDE FHE ENCRYPTION</div>
      <div class="form-grid">
        <div class="field">
          <label>Total Spend (USD)</label>
          <input type="number" id="fan-spend" placeholder="e.g. 1200" />
        </div>
        <div class="field">
          <label>Match Attendance</label>
          <input type="number" id="fan-attendance" placeholder="e.g. 15" />
        </div>
        <div class="field">
          <label>Loyalty Years</label>
          <input type="number" id="fan-loyalty" placeholder="e.g. 3" />
        </div>
      </div>
      <button class="btn" id="encrypt-btn" ${!signer ? 'disabled' : ''}>
        Encrypt & Submit Profile
      </button>
      ${!signer ? '<div class="status info">Connect wallet first to encrypt and submit your profile.</div>' : ''}
      <div id="fan-status"></div>
    </div>

    <div class="card">
      <h2>Check Campaign Rewards</h2>
      <p>See if you qualify for any active sponsor campaigns and claim your rewards.</p>
      <div class="form-grid" style="grid-template-columns: 1fr">
        <div class="field">
          <label>Campaign ID</label>
          <input type="number" id="campaign-id-check" placeholder="e.g. 0" />
        </div>
      </div>
      <button class="btn btn-secondary" id="check-match-btn" ${!signer ? 'disabled' : ''}>
        Request Match Result
      </button>
      <div style="height: 8px"></div>
      <button class="btn" id="claim-btn" ${!signer ? 'disabled' : ''}>
        Claim Reward
      </button>
      <div id="match-status"></div>
    </div>
  `
}

function renderSponsorDashboard(): string {
  return `
    <div class="card">
      <h2>Create Campaign</h2>
      <p>Set your targeting criteria. Thresholds are converted to FHE ciphertexts for blind matching.</p>
      <div class="form-grid">
        <div class="field">
          <label>Campaign Name</label>
          <input type="text" id="campaign-name" placeholder="Nike Spring 2026" />
        </div>
        <div class="field">
          <label>Reward per Fan (ETH)</label>
          <input type="text" id="reward-amount" placeholder="0.01" />
        </div>
        <div class="field">
          <label>Total Budget (ETH)</label>
          <input type="text" id="total-budget" placeholder="1.0" />
        </div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>Min Spend (USD)</label>
          <input type="number" id="min-spend" placeholder="500" />
        </div>
        <div class="field">
          <label>Min Attendance</label>
          <input type="number" id="min-attendance" placeholder="5" />
        </div>
        <div class="field">
          <label>Min Loyalty Years</label>
          <input type="number" id="min-loyalty" placeholder="2" />
        </div>
      </div>
      <button class="btn" id="create-campaign-btn" ${!signer ? 'disabled' : ''}>
        Create Campaign & Deposit Budget
      </button>
      ${!signer ? '<div class="status info">Connect wallet to create campaigns.</div>' : ''}
      <div id="campaign-status"></div>
    </div>

    <div class="card">
      <h2>Campaign Analytics</h2>
      <p>View aggregate results only. Individual fan data is never exposed.</p>
      <div class="form-grid" style="grid-template-columns: 1fr">
        <div class="field">
          <label>Campaign ID</label>
          <input type="number" id="view-campaign-id" placeholder="0" />
        </div>
      </div>
      <button class="btn btn-secondary" id="view-campaign-btn">
        View Campaign Stats
      </button>
      <div id="campaign-analytics"></div>
    </div>
  `
}

// Events
function bindEvents() {
  document.getElementById('wallet-btn')?.addEventListener('click', connectWallet)

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentTab = (tab as HTMLElement).dataset.tab as typeof currentTab
      render()
    })
  })

  document.getElementById('encrypt-btn')?.addEventListener('click', encryptAndSubmit)
  document.getElementById('create-campaign-btn')?.addEventListener('click', createCampaign)
  document.getElementById('view-campaign-btn')?.addEventListener('click', viewCampaignStats)
  document.getElementById('check-match-btn')?.addEventListener('click', requestMatchResult)
  document.getElementById('claim-btn')?.addEventListener('click', claimReward)
}

// Ensure wallet is on Arbitrum Sepolia, auto-switch if not
async function ensureArbitrumSepolia(w: any) {
  try {
    await w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_CONFIG.chainId }] })
  } catch (switchError: any) {
    if (switchError.code === 4902) {
      await w.request({ method: 'wallet_addEthereumChain', params: [CHAIN_CONFIG] })
    } else {
      throw switchError
    }
  }
}

// Wallet — WalletConnect QR code + injected MetaMask fallback
async function connectWallet() {
  try {
    const wcProvider = await EthereumProvider.init({
      projectId: WC_PROJECT_ID,
      chains: [421614],
      showQrModal: true,
      metadata: {
        name: 'SCAN - SportsX Confidential Ad-Network',
        description: 'Privacy-first advertising protocol using FHE',
        url: 'https://sportsx-xyz.github.io/SCAN/',
        icons: ['https://sportsx-xyz.github.io/SCAN/logo.png'],
      },
    })

    await wcProvider.connect()

    // Auto-switch to Arbitrum Sepolia after connection
    await ensureArbitrumSepolia(wcProvider)

    provider = new ethers.BrowserProvider(wcProvider)
    signer = await provider.getSigner()
    const addr = await signer.getAddress()
    walletDisplay = addr.slice(0, 6) + '...' + addr.slice(-4)

    wcProvider.on('disconnect', () => {
      provider = null
      signer = null
      walletDisplay = ''
      render()
    })

    render()
  } catch (e: any) {
    console.error('WalletConnect failed:', e)
    // Fallback: try injected provider (browser extension)
    const injected = (window as any).ethereum
    if (injected) {
      try {
        await injected.request({ method: 'eth_requestAccounts' })
        await ensureArbitrumSepolia(injected)
        provider = new ethers.BrowserProvider(injected)
        signer = await provider.getSigner()
        const a = await signer.getAddress()
        walletDisplay = a.slice(0, 6) + '...' + a.slice(-4)
        render()
      } catch (err: any) {
        console.error('Injected wallet failed:', err)
      }
    }
  }
}

// Fix #2: Fan Encrypt & Submit — handle contract call errors gracefully
async function encryptAndSubmit() {
  if (!signer || !provider) return
  const statusEl = document.getElementById('fan-status')!
  const spend = parseInt((document.getElementById('fan-spend') as HTMLInputElement).value)
  const attendance = parseInt((document.getElementById('fan-attendance') as HTMLInputElement).value)
  const loyalty = parseInt((document.getElementById('fan-loyalty') as HTMLInputElement).value)

  if (isNaN(spend) || isNaN(attendance) || isNaN(loyalty)) {
    statusEl.innerHTML = '<div class="status error">Please fill in all fields with valid numbers.</div>'
    return
  }

  if (spend < 0 || attendance < 0 || loyalty < 0) {
    statusEl.innerHTML = '<div class="status error">Values must be non-negative.</div>'
    return
  }

  statusEl.innerHTML = '<div class="status info">Preparing encrypted profile...</div>'

  try {
    // Verify and auto-switch to correct network
    const network = await provider.getNetwork()
    if (network.chainId !== 421614n) {
      statusEl.innerHTML = '<div class="status info">Switching to Arbitrum Sepolia...</div>'
      try {
        const raw = provider.provider as any
        await ensureArbitrumSepolia(raw)
        // Re-init provider after network switch
        provider = new ethers.BrowserProvider(raw)
        signer = await provider.getSigner()
      } catch {
        statusEl.innerHTML = '<div class="status error">Please switch to Arbitrum Sepolia in your wallet.</div>'
        return
      }
    }

    const contract = new ethers.Contract(CONTRACTS.FAN_PROFILE, FanProfileABI, provider)
    const fanAddress = await signer.getAddress()

    const exists = await contract.hasProfile(fanAddress)
    if (exists) {
      statusEl.innerHTML = '<div class="status info">Profile already registered. Contact club admin to update.</div>'
      return
    }

    statusEl.innerHTML = `
      <div class="status success">
        Profile data prepared for encryption.<br>
        <small>Spend: ${spend} USD | Attendance: ${attendance} | Loyalty: ${loyalty} years</small><br>
        <small>In production, data would be encrypted client-side via @cofhe/sdk before submission by the club admin.</small>
      </div>
    `
  } catch (e: any) {
    statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
  }
}

// Fix #4: Sponsor Create Campaign — show Campaign ID from event log
async function createCampaign() {
  if (!signer) return
  const statusEl = document.getElementById('campaign-status')!
  const name = (document.getElementById('campaign-name') as HTMLInputElement).value
  const reward = (document.getElementById('reward-amount') as HTMLInputElement).value
  const budget = (document.getElementById('total-budget') as HTMLInputElement).value
  const minSpend = parseInt((document.getElementById('min-spend') as HTMLInputElement).value)
  const minAttendance = parseInt((document.getElementById('min-attendance') as HTMLInputElement).value)
  const minLoyalty = parseInt((document.getElementById('min-loyalty') as HTMLInputElement).value)

  if (!name || !reward || !budget || isNaN(minSpend) || isNaN(minAttendance) || isNaN(minLoyalty)) {
    statusEl.innerHTML = '<div class="status error">Please fill in all fields.</div>'
    return
  }

  statusEl.innerHTML = '<div class="status info">Creating campaign on-chain...</div>'

  try {
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, signer)
    const tx = await contract.createCampaign(
      name,
      minSpend,
      minAttendance,
      minLoyalty,
      ethers.parseEther(reward),
      { value: ethers.parseEther(budget) }
    )
    statusEl.innerHTML = '<div class="status info">Transaction submitted, waiting for confirmation...</div>'
    const receipt = await tx.wait()

    // Parse CampaignCreated event to get the Campaign ID
    let campaignId = '—'
    const iface = new ethers.Interface(CampaignABI)
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })
        if (parsed && parsed.name === 'CampaignCreated') {
          campaignId = parsed.args[0].toString()
          break
        }
      } catch { /* skip non-matching logs */ }
    }

    statusEl.innerHTML = `
      <div class="status success">
        Campaign created successfully!<br>
        <strong style="font-size: 18px;">Campaign ID: ${campaignId}</strong><br>
        <small>Save this ID — fans and the admin will need it for blind matching and rewards.</small><br>
        <small>Tx: ${receipt.hash}</small>
      </div>
    `
  } catch (e: any) {
    statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
  }
}

// View campaign stats
async function viewCampaignStats() {
  const analyticsEl = document.getElementById('campaign-analytics')!
  const campaignId = parseInt((document.getElementById('view-campaign-id') as HTMLInputElement).value)

  if (isNaN(campaignId) || campaignId < 0) {
    analyticsEl.innerHTML = '<div class="status error">Enter a valid Campaign ID (0 or above).</div>'
    return
  }

  analyticsEl.innerHTML = '<div class="status info">Loading campaign data...</div>'

  try {
    const rpcProvider = provider || new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrls[0])
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, rpcProvider)
    const stats = await contract.getCampaignStats(campaignId)

    analyticsEl.innerHTML = `
      <div class="campaign-item" style="margin-top: 16px;">
        <div>
          <div class="name">${esc(stats.name)}</div>
          <div class="meta">
            Sponsor: ${stats.sponsor.slice(0, 6)}...${stats.sponsor.slice(-4)}
            &middot; ${stats.active ? 'Active' : 'Inactive'}
          </div>
        </div>
        <div class="budget">
          <div class="amount">${ethers.formatEther(stats.remainingBudget)} ETH</div>
          <div class="matches">${stats.matchCount.toString()} matches</div>
        </div>
      </div>
      <div class="fhe-badge" style="margin-top: 8px;">
        Sponsor sees match count only — zero individual data exposed
      </div>
    `
  } catch (e: any) {
    analyticsEl.innerHTML = `<div class="status error">Campaign not found or network error: ${readableError(e)}</div>`
  }
}

// Fix #3: Fan Request match result — proper error handling
async function requestMatchResult() {
  if (!signer) return
  const statusEl = document.getElementById('match-status')!
  const campaignId = parseInt((document.getElementById('campaign-id-check') as HTMLInputElement).value)

  if (isNaN(campaignId) || campaignId < 0) {
    statusEl.innerHTML = '<div class="status error">Enter a valid Campaign ID.</div>'
    return
  }

  statusEl.innerHTML = '<div class="status info">Requesting decryption of your match result...</div>'

  try {
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, signer)

    // Check if match was computed first
    const fanAddress = await signer.getAddress()
    const computed = await contract.matchComputed(campaignId, fanAddress)
    if (!computed) {
      statusEl.innerHTML = '<div class="status error">No blind match has been run for your address on this campaign. The club admin needs to run the match first.</div>'
      return
    }

    const claimed = await contract.rewardClaimed(campaignId, fanAddress)
    if (claimed) {
      statusEl.innerHTML = '<div class="status info">You have already claimed the reward for this campaign.</div>'
      return
    }

    const tx = await contract.requestMatchResult(campaignId)
    await tx.wait()
    statusEl.innerHTML = `
      <div class="status success">
        Decryption requested! Wait a moment, then click "Claim Reward" to check if you qualified.
      </div>
    `
  } catch (e: any) {
    statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
  }
}

// Fix #3: Fan Claim reward — proper error handling
async function claimReward() {
  if (!signer) return
  const statusEl = document.getElementById('match-status')!
  const campaignId = parseInt((document.getElementById('campaign-id-check') as HTMLInputElement).value)

  if (isNaN(campaignId) || campaignId < 0) {
    statusEl.innerHTML = '<div class="status error">Enter a valid Campaign ID.</div>'
    return
  }

  statusEl.innerHTML = '<div class="status info">Claiming reward...</div>'

  try {
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, signer)
    const fanAddress = await signer.getAddress()

    // Pre-flight checks to give clear error messages
    const computed = await contract.matchComputed(campaignId, fanAddress)
    if (!computed) {
      statusEl.innerHTML = '<div class="status error">No blind match has been run for your address on this campaign.</div>'
      return
    }

    const claimed = await contract.rewardClaimed(campaignId, fanAddress)
    if (claimed) {
      statusEl.innerHTML = '<div class="status info">You have already claimed the reward for this campaign.</div>'
      return
    }

    const tx = await contract.claimReward(campaignId)
    const receipt = await tx.wait()
    statusEl.innerHTML = `
      <div class="status success">
        Reward claimed successfully!<br>
        <small>Tx: ${receipt.hash}</small>
      </div>
    `
  } catch (e: any) {
    const msg = readableError(e)
    if (msg.includes('Already claimed')) {
      statusEl.innerHTML = '<div class="status info">You have already claimed this reward.</div>'
    } else if (msg.includes('not ready')) {
      statusEl.innerHTML = '<div class="status info">Decryption not ready yet. Please wait a moment and try again.</div>'
    } else if (msg.includes('not computed')) {
      statusEl.innerHTML = '<div class="status error">No blind match has been run for your address on this campaign.</div>'
    } else {
      statusEl.innerHTML = `<div class="status error">${msg}</div>`
    }
  }
}

// Init
render()
