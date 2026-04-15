import './style.css'
import { ethers } from 'ethers'
import EthereumProvider from '@walletconnect/ethereum-provider'
import FanProfileABI from './utils/ConfidentialFanProfileABI.json'
import CampaignABI from './utils/SCANCampaignABI.json'
import { CONTRACTS, CHAIN_CONFIG } from './utils/contracts'
import logoUrl from '/logo.png?url'
import { createCofheConfig, createCofheClient } from '@cofhe/sdk/web'
import { Encryptable } from '@cofhe/sdk'
import { arbSepolia } from '@cofhe/sdk/chains'
import { createWalletClient, createPublicClient, custom, http } from 'viem'
import { arbitrumSepolia } from 'viem/chains'

const WC_PROJECT_ID = '487d89c80dad68856ba26b4a06444db0'

// ─── CoFHE Client ─────────────────────────────────────────────────────────────

const cofheConfig = createCofheConfig({ supportedChains: [arbSepolia] })
const cofheClient = createCofheClient(cofheConfig)

async function ensureCofheConnected() {
  const publicClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(CHAIN_CONFIG.rpcUrls[0]),
  })
  const walletClient = createWalletClient({
    chain: arbitrumSepolia,
    transport: custom(rawEip1193),
  })
  await cofheClient.connect(publicClient, walletClient)
}

// ─── App State ────────────────────────────────────────────────────────────────

let provider: ethers.BrowserProvider | null = null
let rawEip1193: any = null          // underlying EIP-1193 provider for network switching
let signer: ethers.JsonRpcSigner | null = null
let walletDisplay = ''
let currentTab: 'fan' | 'sponsor' | 'about' | 'club' = 'about'

// ─── Pending Registration Queue (localStorage) ───────────────────────────────
// Fans submit here; admin reviews and approves to register on-chain.

const PENDING_KEY = 'scan_pending_registrations'

interface PendingApplication {
  address: string
  spend: number
  attendance: number
  loyalty: number
  submittedAt: number   // unix ms
}

function getPendingApplications(): PendingApplication[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')
  } catch { return [] }
}

function savePendingApplications(apps: PendingApplication[]) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(apps))
}

function addPendingApplication(app: PendingApplication) {
  const apps = getPendingApplications().filter(a => a.address.toLowerCase() !== app.address.toLowerCase())
  apps.unshift(app)
  savePendingApplications(apps)
}

function removePendingApplication(address: string) {
  const apps = getPendingApplications().filter(a => a.address.toLowerCase() !== address.toLowerCase())
  savePendingApplications(apps)
}

// ─── Club Admin State ─────────────────────────────────────────────────────────

interface FanRecord {
  address: string
  hasProfile: boolean
}
let clubFanList: FanRecord[] = []
let clubFanListLoading = false
let isClubAdmin = false

// Fan portal — inbox card state per campaign
type CardStep = 'matched' | 'decrypt' | 'view-ad' | 'done' | 'not-matched'

interface InboxCard {
  campaignId: number
  step: CardStep
  ctHash?: string
  stats: CampaignStats
}

interface CampaignStats {
  name: string
  adContentURI: string
  adType: number
  clubAddress: string
  costPerImpression: bigint
  totalBudget: bigint
  remainingBudget: bigint
  matchCount: bigint
  impressionCount: bigint
  clickCount: bigint
  active: boolean
  sponsor: string
}

let inboxCards: InboxCard[] = []
let inboxLoading = false
let totalEarned = 0n


// ─── Utilities ───────────────────────────────────────────────────────────────

function esc(str: string): string {
  const el = document.createElement('span')
  el.textContent = str
  return el.innerHTML
}

function readableError(e: any): string {
  // EIP-1193 user rejection (code 4001)
  if (e?.code === 4001 || e?.code === 'ACTION_REJECTED' || e?.reason === 'rejected') {
    return 'Transaction cancelled. Open MetaMask and press Confirm to approve.'
  }
  const msg = e?.reason || e?.shortMessage || e?.message || String(e)
  const match = msg.match(/reason="([^"]+)"/) || msg.match(/reverted with reason string '([^']+)'/)
  return match ? match[1] : msg.length > 200 ? msg.slice(0, 200) + '...' : msg
}

function getReadProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(CHAIN_CONFIG.rpcUrls[0])
}

function ipfsToHttp(uri: string): string {
  return uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri
}

// ─── Network ──────────────────────────────────────────────────────────────────

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

// Accepted chain IDs — extend when deploying to a new network
const ACCEPTED_CHAIN_IDS = [
  31337n,   // Hardhat local (demo / dev)
  421614n,  // Arbitrum Sepolia (testnet)
]

async function checkNetworkForWrite(): Promise<string | null> {
  if (!provider || !signer) return 'Wallet not connected. Click "Connect Wallet" first.'
  try {
    const network = await provider.getNetwork()
    if (ACCEPTED_CHAIN_IDS.includes(network.chainId)) return null

    // Wrong network — try to auto-switch via the raw EIP-1193 provider
    if (!rawEip1193) {
      return `Wrong network (chain ${network.chainId}). Please switch to the correct network in your wallet.`
    }
    try {
      await ensureArbitrumSepolia(rawEip1193)
      provider = new ethers.BrowserProvider(rawEip1193)
      signer = await provider.getSigner()
      const addr = await signer.getAddress()
      walletDisplay = addr.slice(0, 6) + '...' + addr.slice(-4)
      return null
    } catch {
      return `Wrong network (chain ${network.chainId}). Please switch to Hardhat Local or Arbitrum Sepolia.`
    }
  } catch {
    return 'Could not detect network. Please check your wallet connection.'
  }
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

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
    try {
      await ensureArbitrumSepolia(wcProvider)
    } catch (netErr) {
      console.warn('Network switch via WalletConnect failed (user may need to switch manually):', netErr)
    }
    rawEip1193 = wcProvider
    provider = new ethers.BrowserProvider(wcProvider)
    signer = await provider.getSigner()
    const addr = await signer.getAddress()
    walletDisplay = addr.slice(0, 6) + '...' + addr.slice(-4)
    wcProvider.on('disconnect', () => {
      provider = null; rawEip1193 = null; signer = null; walletDisplay = ''
      render()
    })
    render()
    if (currentTab === 'fan') loadFanInbox()
    if (currentTab === 'club') loadClubData()
  } catch {
    const injected = (window as any).ethereum
    if (injected) {
      try {
        await injected.request({ method: 'eth_requestAccounts' })
        await ensureArbitrumSepolia(injected)
        rawEip1193 = injected
        provider = new ethers.BrowserProvider(injected)
        signer = await provider.getSigner()
        const a = await signer.getAddress()
        walletDisplay = a.slice(0, 6) + '...' + a.slice(-4)
        render()
        if (currentTab === 'fan') loadFanInbox()
        if (currentTab === 'club') loadClubData()
      } catch (err) { console.error('Injected wallet failed:', err) }
    }
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const app = document.getElementById('app')!
  app.innerHTML = `
    <header class="header">
      <div class="logo">
        <img src="${logoUrl}" alt="SportsX" class="logo-img" />
        <div>
          <h1>SCAN</h1>
          <span>SportsX Confidential Ad-Network</span>
        </div>
      </div>
      <button class="wallet-btn ${signer ? 'connected' : ''}" id="wallet-btn">
        ${signer ? '&#x2713; ' + walletDisplay : 'Connect Wallet'}
      </button>
    </header>

    <div class="tabs">
      <button class="tab ${currentTab === 'about' ? 'active' : ''}" data-tab="about">How It Works</button>
      <button class="tab ${currentTab === 'fan' ? 'active' : ''}" data-tab="fan">My Ad Inbox</button>
      <button class="tab ${currentTab === 'club' ? 'active' : ''}" data-tab="club">Club Admin</button>
      <button class="tab ${currentTab === 'sponsor' ? 'active' : ''}" data-tab="sponsor">Sponsor</button>
    </div>

    <main>
      ${currentTab === 'about' ? renderAbout() : ''}
      ${currentTab === 'fan' ? renderFanPortal() : ''}
      ${currentTab === 'club' ? renderClubAdmin() : ''}
      ${currentTab === 'sponsor' ? renderSponsorDashboard() : ''}
    </main>
  `
  bindEvents()
}

// ─── About ────────────────────────────────────────────────────────────────────

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
      <h2>Revenue Split — Every Verified Impression</h2>
      <p>Auto-settled on-chain when a fan confirms they viewed the ad. No manual claims, no escrow delays.</p>
      <div class="revenue-split-preview">
        <div class="split-bar">
          <div class="split-seg club" style="flex: 6">
            <span class="split-label">Club</span>
            <span class="split-pct">60%</span>
          </div>
          <div class="split-seg fan" style="flex: 3">
            <span class="split-label">Fan</span>
            <span class="split-pct">30%</span>
          </div>
          <div class="split-seg protocol" style="flex: 1">
            <span class="split-label">Protocol</span>
            <span class="split-pct">10%</span>
          </div>
        </div>
        <p class="split-note">Settlement triggered instantly when fan confirms Proof of View.</p>
      </div>
    </div>

    <div class="card">
      <h2>Ad Delivery Flow</h2>
      <p style="margin-bottom: 16px; line-height: 1.8;">
        <strong>1.</strong> Sponsor uploads ad to IPFS, stores URI + targeting criteria on-chain<br>
        <strong>2.</strong> Club admin runs blind FHE match for all fans — nobody learns who matched<br>
        <strong>3.</strong> Fan opens their <em>Ad Inbox</em> — matched campaigns appear as cards<br>
        <strong>4.</strong> Fan decrypts their result via Fhenix coprocessor, publishes proof on-chain<br>
        <strong>5.</strong> Ad content (video / banner / link) is rendered inline from IPFS<br>
        <strong>6.</strong> Fan clicks through + confirms view → 3-way settlement fires instantly<br>
        <strong>7.</strong> Sponsor sees delivery rate &amp; CTR — no individual identity exposed
      </p>
    </div>

    <div class="stats-row">
      <div class="stat"><div class="value">0</div><div class="label">Data Points Exposed</div></div>
      <div class="stat"><div class="value">100%</div><div class="label">GDPR Compliant</div></div>
      <div class="stat"><div class="value">FHE</div><div class="label">Encryption Standard</div></div>
    </div>
  `
}

// ─── Fan Portal ───────────────────────────────────────────────────────────────

function renderFanPortal(): string {
  if (!signer) {
    return `
      <div class="card" style="text-align: center; padding: 48px 24px;">
        <div style="font-size: 48px; margin-bottom: 16px;">&#x1F4E5;</div>
        <h2 style="margin-bottom: 8px;">Your Ad Inbox</h2>
        <p>Connect your wallet to see campaigns you've been matched on and claim your rewards.</p>
        <button class="btn" id="wallet-btn-inline" style="max-width: 240px; margin: 8px auto 0;">
          Connect Wallet
        </button>
      </div>
    `
  }

  // Earnings summary bar
  const earningsBar = totalEarned > 0n ? `
    <div class="earnings-bar">
      <div class="earnings-label">Total Earned</div>
      <div class="earnings-amount">${ethers.formatEther(totalEarned)} ETH</div>
    </div>
  ` : ''

  // Inbox content
  let inboxContent = ''
  if (inboxLoading) {
    inboxContent = `
      <div class="status info" style="margin-bottom: 16px;">
        Scanning for matched campaigns...
      </div>
    `
  } else if (inboxCards.length === 0) {
    inboxContent = `
      <div class="empty-inbox">
        <div style="font-size: 40px; margin-bottom: 12px;">&#x1F50D;</div>
        <div class="empty-title">No matched campaigns yet</div>
        <div class="empty-sub">When a club admin runs a blind match and your profile qualifies, campaigns will appear here automatically.</div>
      </div>
    `
  } else {
    inboxContent = inboxCards.map(card => renderInboxCard(card)).join('')
  }

  return `
    ${earningsBar}

    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <h2>Ad Inbox</h2>
        <button class="btn btn-secondary" id="refresh-inbox-btn"
          style="width: auto; padding: 8px 16px; font-size: 13px;">
          &#x21BA; Refresh
        </button>
      </div>
      <p>Campaigns you've been matched on. Your data stayed private throughout.</p>
      <div id="inbox-content">
        ${inboxContent}
      </div>
    </div>

    <div class="card">
      <h2>Sync Your Fan Profile</h2>
      <p>Your metrics are encrypted client-side. The club and sponsors never see your raw data.</p>
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
      <button class="btn" id="encrypt-btn">Encrypt &amp; Submit Profile</button>
      <div id="fan-status"></div>
    </div>
  `
}

function renderInboxCard(card: InboxCard): string {
  const { campaignId, step, stats } = card
  const cost = stats.costPerImpression
  const fanAmt = cost > 0n ? (cost * 3000n) / 10000n : 0n
  const adTypeNames = ['Video', 'Banner', 'Link']
  const adTypeName = adTypeNames[stats.adType] ?? 'Ad'
  const adTypeColors = ['var(--accent)', 'var(--green)', 'var(--orange)']
  const typeColor = adTypeColors[stats.adType] ?? 'var(--accent)'

  const stepBadge = {
    matched:      `<span class="card-badge decrypt">Decrypt Required</span>`,
    decrypt:      `<span class="card-badge decrypt">Decrypt Required</span>`,
    'view-ad':    `<span class="card-badge view">Ready to Earn</span>`,
    done:         `<span class="card-badge done">&#x2713; Claimed</span>`,
    'not-matched':`<span class="card-badge nomatch">Not Matched</span>`,
  }[step]

  const gatewayUrl = ipfsToHttp(stats.adContentURI)

  let adPreview = ''
  if (step === 'view-ad' || step === 'done') {
    if (stats.adType === 1) {
      // Banner — show inline image
      adPreview = `
        <div class="card-ad-media">
          <img src="${esc(gatewayUrl)}" alt="${esc(stats.name)}" class="ad-banner-img"
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
          <div class="ad-media-placeholder" style="display:none;">
            <span style="font-size:28px">&#x1F5BC;</span>
            <a href="${esc(gatewayUrl)}" target="_blank" rel="noopener" class="ad-link">View banner</a>
          </div>
        </div>
      `
    } else if (stats.adType === 0) {
      adPreview = `
        <div class="card-ad-media">
          <div class="ad-media-placeholder" style="min-height: 80px;">
            <span style="font-size:28px">&#x25B6;</span>
            <a href="${esc(gatewayUrl)}" target="_blank" rel="noopener" class="ad-link"
              id="click-${campaignId}" data-campaign="${campaignId}">
              Watch Video
            </a>
          </div>
        </div>
      `
    } else {
      adPreview = `
        <div class="card-ad-media" style="padding: 12px 0 0">
          <a href="${esc(gatewayUrl)}" target="_blank" rel="noopener" class="ad-link-block"
            id="click-${campaignId}" data-campaign="${campaignId}">
            &#x1F517; ${esc(stats.adContentURI.slice(0, 50))}${stats.adContentURI.length > 50 ? '…' : ''}
          </a>
        </div>
      `
    }
  }

  let actionArea = ''
  if (step === 'matched' || step === 'decrypt') {
    actionArea = `
      <div class="card-action decrypt-action" id="decrypt-panel-${campaignId}">
        <div class="decrypt-hint">
          <span class="decrypt-icon">&#x1F510;</span>
          <div>
            <div class="decrypt-title">Decrypt your match result</div>
            <div class="decrypt-sub">Use the Fhenix coprocessor SDK to decrypt off-chain, then paste the result below.</div>
          </div>
        </div>
        ${card.ctHash ? `
          <div class="field" style="margin: 12px 0 8px;">
            <label>ctHash (copy to decrypt)</label>
            <div class="code-box">
              <code>${card.ctHash}</code>
              <button class="copy-btn" data-copy="${card.ctHash}" title="Copy">&#x2398;</button>
            </div>
          </div>
          <details class="sdk-hint" style="margin-bottom: 12px;">
            <summary>SDK snippet</summary>
            <pre class="code-snippet">const result = await client
  .decryptForTx("${card.ctHash}")
  .withPermit().execute()
// result.decryptedValue, result.signature</pre>
          </details>
          <div class="form-grid" style="grid-template-columns: auto 1fr; gap: 8px; align-items: end; margin-bottom: 10px;">
            <div class="field" style="margin-bottom:0">
              <label>Matched?</label>
              <select class="select-input" id="pub-result-${campaignId}">
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <div class="field" style="margin-bottom:0">
              <label>Signature (hex)</label>
              <input type="text" id="pub-sig-${campaignId}" placeholder="0x..." />
            </div>
          </div>
          <button class="btn" data-publish="${campaignId}">Publish Match Result</button>
          <div id="action-status-${campaignId}"></div>
        ` : '<div class="status error" style="margin-top:8px">ctHash unavailable</div>'}
      </div>
    `
  } else if (step === 'view-ad') {
    actionArea = `
      <div class="card-action earn-action">
        <div class="earn-preview">
          <div class="earn-you">
            <span class="earn-label">Your Reward</span>
            <span class="earn-val">${ethers.formatEther(fanAmt)} ETH</span>
          </div>
          <div class="earn-split-mini">
            <span class="earn-split-item club">Club 60%</span>
            <span class="earn-split-item fan">You 30%</span>
            <span class="earn-split-item proto">Protocol 10%</span>
          </div>
        </div>
        <button class="btn btn-earn" data-confirm="${campaignId}">
          Confirm View &amp; Claim ${ethers.formatEther(fanAmt)} ETH
        </button>
        <div id="action-status-${campaignId}"></div>
      </div>
    `
  } else if (step === 'done') {
    actionArea = `
      <div class="card-action done-action">
        <div class="done-msg">
          <span class="done-icon">&#x2714;</span>
          <div>
            <div class="done-title">Reward Received</div>
            <div class="done-sub">${ethers.formatEther(fanAmt)} ETH paid to your wallet.</div>
          </div>
        </div>
      </div>
    `
  }

  return `
    <div class="inbox-card ${step}" data-campaign="${campaignId}">
      <div class="inbox-card-header">
        <div class="inbox-card-meta">
          <div class="inbox-card-name">${esc(stats.name)}</div>
          <div class="inbox-card-sub">
            Campaign #${campaignId}
            &middot; <span class="ad-type-badge-sm" style="color: ${typeColor}">${adTypeName}</span>
            &middot; ${ethers.formatEther(cost)} ETH/view
          </div>
        </div>
        ${stepBadge}
      </div>
      ${adPreview}
      ${actionArea}
    </div>
  `
}

// ─── Fan Inbox Loader ─────────────────────────────────────────────────────────

async function loadFanInbox() {
  if (!signer) return
  inboxLoading = true
  updateInboxContent()

  try {
    const fanAddress = await signer.getAddress()
    const rp = getReadProvider()
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, rp)

    // Fetch BlindMatchExecuted events for this fan
    const filter = contract.filters.BlindMatchExecuted(null, fanAddress)
    const events = await contract.queryFilter(filter, -10000)

    const cards: InboxCard[] = []
    let earned = 0n

    for (const ev of events) {
      const args = (ev as ethers.EventLog).args
      const campaignId = Number(args[0])

      // Avoid duplicates
      if (cards.find(c => c.campaignId === campaignId)) continue

      const statsRaw = await contract.getCampaignStats(campaignId)
      const stats: CampaignStats = {
        name: statsRaw.name,
        adContentURI: statsRaw.adContentURI,
        adType: Number(statsRaw.adType),
        clubAddress: statsRaw.clubAddress,
        costPerImpression: BigInt(statsRaw.costPerImpression.toString()),
        totalBudget: BigInt(statsRaw.totalBudget.toString()),
        remainingBudget: BigInt(statsRaw.remainingBudget.toString()),
        matchCount: BigInt(statsRaw.matchCount.toString()),
        impressionCount: BigInt(statsRaw.impressionCount.toString()),
        clickCount: BigInt(statsRaw.clickCount.toString()),
        active: statsRaw.active,
        sponsor: statsRaw.sponsor,
      }

      // Determine fan's step
      const confirmed = await contract.matchConfirmed(campaignId, fanAddress)
      if (!confirmed) {
        const ctHash = await contract.getMatchResultCtHash(campaignId, fanAddress)
        cards.push({ campaignId, step: 'decrypt', ctHash, stats })
        continue
      }

      const isMatched = await contract.isMatched(campaignId, fanAddress)
      if (!isMatched) {
        cards.push({ campaignId, step: 'not-matched', stats })
        continue
      }

      const viewed = await contract.adViewed(campaignId, fanAddress)
      if (viewed) {
        const fanAmt = stats.costPerImpression > 0n ? (stats.costPerImpression * 3000n) / 10000n : 0n
        earned += fanAmt
        cards.push({ campaignId, step: 'done', stats })
      } else {
        cards.push({ campaignId, step: 'view-ad', stats })
      }
    }

    inboxCards = cards
    totalEarned = earned
  } catch (e) {
    console.error('loadFanInbox:', e)
  }

  inboxLoading = false
  render()  // full re-render to update earnings bar too
}

function updateInboxContent() {
  const el = document.getElementById('inbox-content')
  if (!el) return
  if (inboxLoading) {
    el.innerHTML = '<div class="status info">Scanning for matched campaigns...</div>'
    return
  }
  if (inboxCards.length === 0) {
    el.innerHTML = `
      <div class="empty-inbox">
        <div style="font-size: 40px; margin-bottom: 12px;">&#x1F50D;</div>
        <div class="empty-title">No matched campaigns yet</div>
        <div class="empty-sub">When a club admin runs a blind match and your profile qualifies, campaigns will appear here automatically.</div>
      </div>
    `
    return
  }
  el.innerHTML = inboxCards.map(c => renderInboxCard(c)).join('')
  bindInboxCardEvents()
}

// ─── Club Admin ───────────────────────────────────────────────────────────────

function renderPendingApplications(): string {
  const pending = getPendingApplications()

  if (pending.length === 0) return ''

  const rows = pending.map(app => {
    const age = Math.floor((Date.now() - app.submittedAt) / 60000)
    const ageStr = age < 1 ? 'just now' : age < 60 ? `${age}m ago` : `${Math.floor(age/60)}h ago`
    return `
      <div class="pending-row">
        <div class="pending-info">
          <div class="pending-addr" title="${app.address}">
            ${app.address.slice(0,8)}...${app.address.slice(-6)}
            <button class="copy-btn" data-copy="${app.address}" title="Copy">&#x2398;</button>
          </div>
          <div class="pending-metrics">
            Spend: <strong>${app.spend}</strong> USD &nbsp;&middot;&nbsp;
            Attendance: <strong>${app.attendance}</strong> &nbsp;&middot;&nbsp;
            Loyalty: <strong>${app.loyalty}</strong> yrs
          </div>
          <div class="pending-time">${ageStr}</div>
        </div>
        <div class="pending-actions">
          <button class="btn btn-approve" data-approve="${app.address}"
            data-spend="${app.spend}" data-att="${app.attendance}" data-loy="${app.loyalty}"
            ${!isClubAdmin ? 'disabled' : ''}>
            Approve &amp; Register
          </button>
          <button class="btn btn-reject" data-reject="${app.address}">
            Reject
          </button>
        </div>
      </div>
    `
  }).join('')

  return `
    <div class="card pending-card">
      <div class="pending-header">
        <h2>Pending Applications</h2>
        <span class="pending-count">${pending.length}</span>
      </div>
      <p>Fans who submitted their profile data for review. Approving will encrypt and register their metrics on-chain.</p>
      <div id="pending-list">
        ${rows}
      </div>
      <div id="pending-status"></div>
    </div>
  `
}

function renderClubAdmin(): string {
  if (!signer) {
    return `
      <div class="card" style="text-align: center; padding: 48px 24px;">
        <div style="font-size: 48px; margin-bottom: 16px;">&#x1F3DF;</div>
        <h2 style="margin-bottom: 8px;">Club Admin Panel</h2>
        <p>Connect the club admin wallet to manage fan profiles and run blind matching.</p>
        <button class="btn" id="wallet-btn-inline" style="max-width: 240px; margin: 8px auto 0;">
          Connect Wallet
        </button>
      </div>
    `
  }

  const adminBanner = isClubAdmin
    ? `<div class="admin-banner admin">&#x2714; Admin wallet connected — full access</div>`
    : `<div class="admin-banner readonly">Read-only — connected wallet is not the admin of this contract</div>`

  // Fan list table
  let fanTable = ''
  if (clubFanListLoading) {
    fanTable = '<div class="status info">Loading fan registry...</div>'
  } else if (clubFanList.length === 0) {
    fanTable = '<div class="empty-inbox" style="padding: 20px 0;"><div class="empty-title">No fans registered yet</div></div>'
  } else {
    const rows = clubFanList.map((f, i) => `
      <tr class="fan-row">
        <td class="fan-idx">${i + 1}</td>
        <td class="fan-addr" title="${f.address}">
          ${f.address.slice(0, 8)}...${f.address.slice(-6)}
          <button class="copy-btn" data-copy="${f.address}" title="Copy address" style="margin-left: 6px;">&#x2398;</button>
        </td>
        <td>
          <span class="profile-badge ${f.hasProfile ? 'registered' : 'pending'}">
            ${f.hasProfile ? '&#x2714; Registered' : '&#x23F3; Pending'}
          </span>
        </td>
      </tr>
    `).join('')

    fanTable = `
      <div class="fan-table-wrap">
        <table class="fan-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Fan Wallet</th>
              <th>Profile Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="table-footer">
        ${clubFanList.filter(f => f.hasProfile).length} of ${clubFanList.length} fans have encrypted profiles on-chain
      </div>
    `
  }

  return `
    ${adminBanner}

    <!-- Fan Registry -->
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
        <h2>Fan Registry</h2>
        <button class="btn btn-secondary" id="refresh-fans-btn"
          style="width: auto; padding: 8px 16px; font-size: 13px;">&#x21BA; Refresh</button>
      </div>
      <p>All fans registered in the <code class="inline-code">ConfidentialFanProfile</code> contract.
         Fan data is stored as FHE ciphertexts — only each fan can read their own metrics.</p>
      <div id="fan-table-content">${fanTable}</div>
    </div>

    <!-- Pending Applications -->
    ${renderPendingApplications()}

    <!-- Register Fan -->
    <div class="card">
      <h2>Register Fan Manually</h2>
      <p>
        Or enter a fan's wallet address and metrics directly. Values are encrypted on-chain via
        <code class="inline-code">FHE.asEuint32</code> — the sponsor never sees these numbers.
      </p>
      <div class="form-grid" style="grid-template-columns: 1fr; margin-bottom: 16px;">
        <div class="field">
          <label>Fan Wallet Address</label>
          <input type="text" id="reg-fan-addr" placeholder="0x..." />
        </div>
      </div>
      <div class="form-grid">
        <div class="field">
          <label>Total Spend (USD)</label>
          <input type="number" id="reg-spend" placeholder="e.g. 1200" />
        </div>
        <div class="field">
          <label>Match Attendance</label>
          <input type="number" id="reg-attendance" placeholder="e.g. 15" />
        </div>
        <div class="field">
          <label>Loyalty Years</label>
          <input type="number" id="reg-loyalty" placeholder="e.g. 3" />
        </div>
      </div>
      <div class="privacy-note">
        <span class="fhe-badge">FHE</span>
        <span>These values will be trivially encrypted on-chain and are never visible to sponsors or other fans.</span>
      </div>
      <button class="btn" id="register-fan-btn" ${!isClubAdmin ? 'disabled' : ''} style="margin-top: 16px;">
        Encrypt &amp; Register Fan
      </button>
      ${!isClubAdmin ? '<div class="status info" style="margin-top: 8px;">Only the admin wallet can register fans.</div>' : ''}
      <div id="register-status"></div>
    </div>

    <!-- Campaign Operations -->
    <div class="card">
      <h2>Campaign Operations</h2>
      <p>
        Grant fans access to a campaign's FHE context, then run the blind match.
        Neither step reveals which fans matched — results stay encrypted on-chain.
      </p>

      <div class="form-grid" style="grid-template-columns: 1fr; margin-bottom: 16px;">
        <div class="field">
          <label>Campaign ID</label>
          <input type="number" id="ops-campaign-id" placeholder="0" />
        </div>
      </div>

      <div class="ops-grid">
        <div class="ops-panel">
          <div class="ops-title">
            <span class="ops-step">1</span>
            Grant Campaign Access
          </div>
          <p class="ops-desc">
            Allow the campaign contract to read each fan's encrypted profile.
            Required before blind matching.
          </p>
          <div class="field">
            <label>Fan Address (or leave blank for all registered fans)</label>
            <input type="text" id="ops-fan-addr" placeholder="0x... or leave blank for batch" />
          </div>
          <button class="btn btn-secondary" id="grant-access-btn" ${!isClubAdmin ? 'disabled' : ''}>
            Grant Access
          </button>
          <div id="grant-status"></div>
        </div>

        <div class="ops-panel">
          <div class="ops-title">
            <span class="ops-step">2</span>
            Run Blind Match
          </div>
          <p class="ops-desc">
            Execute FHE comparison for each fan. Nobody — not the club, not the sponsor —
            learns who matched. Results are encrypted booleans.
          </p>
          <div class="field">
            <label>Fan Address (or leave blank for all registered fans)</label>
            <input type="text" id="match-fan-addr" placeholder="0x... or leave blank for batch" />
          </div>
          <button class="btn" id="run-match-btn" ${!isClubAdmin ? 'disabled' : ''}>
            Run Blind Match
          </button>
          <div id="match-status"></div>
        </div>
      </div>
    </div>
  `
}

// ─── Club Admin Data Loader ───────────────────────────────────────────────────

async function loadClubData() {
  if (!signer) return
  clubFanListLoading = true
  updateClubFanTable()

  try {
    const addr = await signer.getAddress()
    const rp = getReadProvider()
    const contract = new ethers.Contract(CONTRACTS.FAN_PROFILE, FanProfileABI, rp)

    // Check if connected wallet is admin
    const adminAddr: string = await contract.admin()
    isClubAdmin = adminAddr.toLowerCase() === addr.toLowerCase()

    // Load fan list
    const count = Number(await contract.getFanCount())
    const records: FanRecord[] = []
    for (let i = 0; i < count; i++) {
      const fanAddr: string = await contract.getFanAt(i)
      const hasProfile: boolean = await contract.hasProfile(fanAddr)
      records.push({ address: fanAddr, hasProfile })
    }
    clubFanList = records
  } catch (e) {
    console.error('loadClubData:', e)
  }

  clubFanListLoading = false
  // Re-render the whole club tab so admin banner + disabled states update
  if (currentTab === 'club') render()
}

function updateClubFanTable() {
  const el = document.getElementById('fan-table-content')
  if (!el) return
  el.innerHTML = '<div class="status info">Loading fan registry...</div>'
}

// ─── Club Admin Actions ───────────────────────────────────────────────────────

async function registerFan() {
  const statusEl = document.getElementById('register-status')!
  const fanAddr = (document.getElementById('reg-fan-addr') as HTMLInputElement).value.trim()
  const spend = parseInt((document.getElementById('reg-spend') as HTMLInputElement).value)
  const attendance = parseInt((document.getElementById('reg-attendance') as HTMLInputElement).value)
  const loyalty = parseInt((document.getElementById('reg-loyalty') as HTMLInputElement).value)

  if (!ethers.isAddress(fanAddr)) {
    statusEl.innerHTML = '<div class="status error">Enter a valid fan wallet address.</div>'; return
  }
  if (isNaN(spend) || isNaN(attendance) || isNaN(loyalty) || spend < 0 || attendance < 0 || loyalty < 0) {
    statusEl.innerHTML = '<div class="status error">Fill in all metric fields with non-negative numbers.</div>'; return
  }

  const netErr = await checkNetworkForWrite()
  if (netErr) { statusEl.innerHTML = `<div class="status error">${netErr}</div>`; return }

  statusEl.innerHTML = '<div class="status info">Step 1/3: Connecting to Fhenix CoFHE coprocessor...</div>'
  try {
    await ensureCofheConnected()
    statusEl.innerHTML = '<div class="status info">Step 2/3: Encrypting fan metrics client-side via FHE...</div>'
    const [encSpend, encAttendance, encLoyalty] = await cofheClient
      .encryptInputs([
        Encryptable.uint32(BigInt(spend)),
        Encryptable.uint32(BigInt(attendance)),
        Encryptable.uint32(BigInt(loyalty)),
      ])
      .setAccount(await signer!.getAddress())
      .execute()

    const contract = new ethers.Contract(CONTRACTS.FAN_PROFILE, FanProfileABI, signer!)
    statusEl.innerHTML = '<div class="status info">Step 3/3: Check MetaMask and press <strong>Confirm</strong> to submit on-chain...</div>'
    const tx = await contract.registerProfile(fanAddr, encSpend, encAttendance, encLoyalty)
    await tx.wait()
    statusEl.innerHTML = `
      <div class="status success">
        Fan registered successfully!<br>
        <small>${fanAddr.slice(0,8)}...${fanAddr.slice(-6)} — metrics FHE-encrypted on-chain via CoFHE</small>
      </div>
    `
    // Refresh fan list
    await loadClubData()
  } catch (e: any) {
    statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
  }
}

async function approveApplication(fanAddr: string, spend: number, attendance: number, loyalty: number) {
  const statusEl = document.getElementById('pending-status')!

  const netErr = await checkNetworkForWrite()
  if (netErr) { statusEl.innerHTML = `<div class="status error">${netErr}</div>`; return }

  // Optimistically remove from UI
  const btn = document.querySelector(`[data-approve="${fanAddr}"]`) as HTMLButtonElement | null
  if (btn) { btn.disabled = true; btn.textContent = 'Registering...' }

  statusEl.innerHTML = `<div class="status info">Step 1/3: Connecting to Fhenix CoFHE coprocessor...</div>`
  try {
    await ensureCofheConnected()

    statusEl.innerHTML = `<div class="status info">Step 2/3: Encrypting fan metrics client-side via FHE...</div>`
    const [encSpend, encAttendance, encLoyalty] = await cofheClient
      .encryptInputs([
        Encryptable.uint32(BigInt(spend)),
        Encryptable.uint32(BigInt(attendance)),
        Encryptable.uint32(BigInt(loyalty)),
      ])
      .setAccount(await signer!.getAddress())
      .execute()

    statusEl.innerHTML = `<div class="status info">Step 3/3: Submitting encrypted profile on-chain...</div>`
    const contract = new ethers.Contract(CONTRACTS.FAN_PROFILE, FanProfileABI, signer!)
    const tx = await contract.registerProfile(fanAddr, encSpend, encAttendance, encLoyalty)
    await tx.wait()

    removePendingApplication(fanAddr)
    statusEl.innerHTML = `<div class="status success">&#x2714; ${fanAddr.slice(0,8)}...${fanAddr.slice(-6)} registered — metrics are FHE-encrypted on-chain via CoFHE.</div>`
    await loadClubData()
  } catch (e: any) {
    if (btn) { btn.disabled = false; btn.textContent = 'Approve & Register' }
    statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
  }
}

function rejectApplication(fanAddr: string) {
  removePendingApplication(fanAddr)
  // Re-render club tab to remove the row
  if (currentTab === 'club') render()
}

async function grantCampaignAccess() {
  const statusEl = document.getElementById('grant-status')!
  const campaignId = parseInt((document.getElementById('ops-campaign-id') as HTMLInputElement).value)
  const fanAddrInput = (document.getElementById('ops-fan-addr') as HTMLInputElement).value.trim()

  if (isNaN(campaignId) || campaignId < 0) {
    statusEl.innerHTML = '<div class="status error">Enter a valid Campaign ID.</div>'; return
  }

  const netErr = await checkNetworkForWrite()
  if (netErr) { statusEl.innerHTML = `<div class="status error">${netErr}</div>`; return }

  const campaignAddr = CONTRACTS.CAMPAIGN

  const profileContract = new ethers.Contract(CONTRACTS.FAN_PROFILE, FanProfileABI, signer!)

  if (fanAddrInput && ethers.isAddress(fanAddrInput)) {
    // Single fan
    statusEl.innerHTML = '<div class="status info">Granting access...</div>'
    try {
      const tx = await profileContract.grantCampaignAccess(fanAddrInput, campaignAddr)
      await tx.wait()
      statusEl.innerHTML = `<div class="status success">Access granted for ${fanAddrInput.slice(0,8)}...${fanAddrInput.slice(-6)}</div>`
    } catch (e: any) {
      statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
    }
  } else {
    // Batch — all registered fans
    if (clubFanList.length === 0) {
      statusEl.innerHTML = '<div class="status error">No fans registered yet.</div>'; return
    }
    const fans = clubFanList.filter(f => f.hasProfile).map(f => f.address)
    if (fans.length === 0) {
      statusEl.innerHTML = '<div class="status error">No fans have profiles yet.</div>'; return
    }
    statusEl.innerHTML = `<div class="status info">Granting access for ${fans.length} fans...</div>`
    try {
      const tx = await profileContract.batchGrantCampaignAccess(fans, campaignAddr)
      await tx.wait()
      statusEl.innerHTML = `<div class="status success">Access granted for all ${fans.length} fans on Campaign #${campaignId}</div>`
    } catch (e: any) {
      statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
    }
  }
}

async function runBlindMatch() {
  const statusEl = document.getElementById('match-status')!
  const campaignId = parseInt((document.getElementById('ops-campaign-id') as HTMLInputElement).value)
  const fanAddrInput = (document.getElementById('match-fan-addr') as HTMLInputElement).value.trim()

  if (isNaN(campaignId) || campaignId < 0) {
    statusEl.innerHTML = '<div class="status error">Enter a valid Campaign ID.</div>'; return
  }

  const netErr = await checkNetworkForWrite()
  if (netErr) { statusEl.innerHTML = `<div class="status error">${netErr}</div>`; return }

  const campaignContract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, signer!)

  if (fanAddrInput && ethers.isAddress(fanAddrInput)) {
    // Single fan
    statusEl.innerHTML = `<div class="status info">Running blind match for ${fanAddrInput.slice(0,8)}...${fanAddrInput.slice(-6)}...</div>`
    try {
      const tx = await campaignContract.blindMatch(campaignId, fanAddrInput)
      await tx.wait()
      statusEl.innerHTML = `
        <div class="status success">
          Blind match complete — result is an encrypted boolean on-chain.<br>
          <small>Fan can now decrypt their result via the Fhenix coprocessor.</small>
        </div>
      `
    } catch (e: any) {
      statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
    }
  } else {
    // Batch — all registered fans
    const fans = clubFanList.filter(f => f.hasProfile).map(f => f.address)
    if (fans.length === 0) {
      statusEl.innerHTML = '<div class="status error">No fans with profiles to match.</div>'; return
    }
    statusEl.innerHTML = `<div class="status info">Running batch blind match for ${fans.length} fans...</div>`
    try {
      const tx = await campaignContract.batchBlindMatch(campaignId, fans)
      const receipt = await tx.wait()
      statusEl.innerHTML = `
        <div class="status success">
          Batch blind match complete — ${fans.length} fans processed.<br>
          <small>Results are encrypted on-chain. Fans can now check their inbox.</small><br>
          <small>Tx: ${receipt.hash}</small>
        </div>
      `
    } catch (e: any) {
      statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
    }
  }
}

// ─── Sponsor Dashboard ────────────────────────────────────────────────────────

function renderSponsorDashboard(): string {
  return `
    <div class="card">
      <h2>Create Campaign</h2>
      <p>Set your targeting criteria and ad content. Thresholds are converted to FHE ciphertexts for blind matching.</p>

      <div class="form-grid">
        <div class="field">
          <label>Campaign Name</label>
          <input type="text" id="campaign-name" placeholder="Nike Spring 2026" />
        </div>
        <div class="field">
          <label>Club Address (60% revenue)</label>
          <input type="text" id="club-address" placeholder="0x..." />
        </div>
        <div class="field">
          <label>Cost Per Impression (ETH)</label>
          <input type="text" id="reward-amount" placeholder="0.01" />
        </div>
      </div>

      <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 16px;">
        <div class="field">
          <label>Ad Content URI (IPFS / URL)</label>
          <input type="text" id="ad-content-uri" placeholder="ipfs://Qm..." />
        </div>
        <div class="field">
          <label>Ad Type</label>
          <select id="ad-type" class="select-input">
            <option value="0">&#x25B6; Video</option>
            <option value="1">&#x1F5BC; Banner Image</option>
            <option value="2">&#x1F517; Link</option>
          </select>
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

      <div class="field" style="margin-bottom: 20px;">
        <label>Total Budget (ETH)</label>
        <input type="text" id="total-budget" placeholder="1.0" />
      </div>

      <button class="btn" id="create-campaign-btn" ${!signer ? 'disabled' : ''}>
        Create Campaign &amp; Deposit Budget
      </button>
      ${!signer ? '<div class="status info">Connect wallet to create campaigns.</div>' : ''}
      <div id="campaign-status"></div>
    </div>

    <div class="card">
      <h2>Campaign Analytics</h2>
      <p>Aggregate performance only — individual fan identities are never exposed.</p>
      <div class="form-grid" style="grid-template-columns: 1fr auto; align-items: end; gap: 12px;">
        <div class="field" style="margin-bottom: 0">
          <label>Campaign ID</label>
          <input type="number" id="view-campaign-id" placeholder="0" />
        </div>
        <button class="btn btn-secondary" id="view-campaign-btn"
          style="width: auto; padding: 10px 20px;">Load Stats</button>
      </div>
      <div id="campaign-analytics"></div>
    </div>
  `
}

// ─── Events ───────────────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('wallet-btn')?.addEventListener('click', connectWallet)
  document.getElementById('wallet-btn-inline')?.addEventListener('click', connectWallet)

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const prev = currentTab
      currentTab = (tab as HTMLElement).dataset.tab as typeof currentTab
      render()
      if (currentTab === 'fan' && prev !== 'fan' && signer) {
        loadFanInbox()
      }
      if (currentTab === 'club' && prev !== 'club' && signer) {
        loadClubData()
      }
    })
  })

  document.getElementById('refresh-inbox-btn')?.addEventListener('click', () => {
    if (signer) loadFanInbox()
  })

  // Club admin
  document.getElementById('refresh-fans-btn')?.addEventListener('click', () => {
    if (signer) loadClubData()
  })
  document.getElementById('register-fan-btn')?.addEventListener('click', registerFan)
  document.getElementById('grant-access-btn')?.addEventListener('click', grantCampaignAccess)
  document.getElementById('run-match-btn')?.addEventListener('click', runBlindMatch)

  // Pending application approve / reject
  document.querySelectorAll('[data-approve]').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement
      approveApplication(
        el.dataset.approve!,
        parseInt(el.dataset.spend!),
        parseInt(el.dataset.att!),
        parseInt(el.dataset.loy!)
      )
    })
  })
  document.querySelectorAll('[data-reject]').forEach(btn => {
    btn.addEventListener('click', () => {
      rejectApplication((btn as HTMLElement).dataset.reject!)
    })
  })

  document.getElementById('encrypt-btn')?.addEventListener('click', encryptAndSubmit)
  document.getElementById('create-campaign-btn')?.addEventListener('click', createCampaign)
  document.getElementById('view-campaign-btn')?.addEventListener('click', viewCampaignStats)

  bindInboxCardEvents()
}

function bindInboxCardEvents() {
  // Copy ctHash buttons
  document.querySelectorAll('.copy-btn[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = (btn as HTMLElement).dataset.copy!
      navigator.clipboard.writeText(text).catch(() => {})
      btn.textContent = '✓'
      setTimeout(() => { (btn as HTMLButtonElement).innerHTML = '&#x2398;' }, 1500)
    })
  })

  // Publish match result buttons
  document.querySelectorAll('[data-publish]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt((btn as HTMLElement).dataset.publish!)
      publishMatchResult(id)
    })
  })

  // Confirm view buttons
  document.querySelectorAll('[data-confirm]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt((btn as HTMLElement).dataset.confirm!)
      confirmView(id)
    })
  })

  // Track clicks on ad links
  document.querySelectorAll('[data-campaign][id^="click-"]').forEach(link => {
    link.addEventListener('click', () => {
      const id = parseInt((link as HTMLElement).dataset.campaign!)
      recordClick(id)
    })
  })
  document.querySelectorAll('.ad-link-block[data-campaign]').forEach(link => {
    link.addEventListener('click', () => {
      const id = parseInt((link as HTMLElement).dataset.campaign!)
      recordClick(id)
    })
  })
}

// ─── Fan Actions ──────────────────────────────────────────────────────────────

async function encryptAndSubmit() {
  if (!signer) return
  const statusEl = document.getElementById('fan-status')!
  const spend = parseInt((document.getElementById('fan-spend') as HTMLInputElement).value)
  const attendance = parseInt((document.getElementById('fan-attendance') as HTMLInputElement).value)
  const loyalty = parseInt((document.getElementById('fan-loyalty') as HTMLInputElement).value)

  if (isNaN(spend) || isNaN(attendance) || isNaN(loyalty)) {
    statusEl.innerHTML = '<div class="status error">Please fill in all fields.</div>'; return
  }
  if (spend < 0 || attendance < 0 || loyalty < 0) {
    statusEl.innerHTML = '<div class="status error">Values must be non-negative.</div>'; return
  }

  statusEl.innerHTML = '<div class="status info">Checking on-chain profile status...</div>'
  try {
    const fanAddress = await signer.getAddress()
    const contract = new ethers.Contract(CONTRACTS.FAN_PROFILE, FanProfileABI, getReadProvider())
    const exists = await contract.hasProfile(fanAddress)

    if (exists) {
      statusEl.innerHTML = `
        <div class="status success">
          &#x2714; Profile already registered on-chain. Your data is encrypted and active.
        </div>
      `
      return
    }

    // Save to pending queue — club admin will review and approve
    addPendingApplication({ address: fanAddress, spend, attendance, loyalty, submittedAt: Date.now() })

    statusEl.innerHTML = `
      <div class="status success">
        Application submitted!<br>
        <small>Spend: ${spend} USD &middot; Attendance: ${attendance} &middot; Loyalty: ${loyalty} years</small><br>
        <small>Your data is queued for the club admin to review. Once approved, it will be encrypted and registered on-chain.</small>
      </div>
    `
  } catch (e: any) {
    statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
  }
}

async function publishMatchResult(campaignId: number) {
  if (!signer) return
  const statusEl = document.getElementById(`action-status-${campaignId}`)!
  const resultEl = document.getElementById(`pub-result-${campaignId}`) as HTMLSelectElement
  const sigEl = document.getElementById(`pub-sig-${campaignId}`) as HTMLInputElement

  const result = resultEl?.value === 'true'
  const signature = sigEl?.value?.trim()

  if (!signature || !signature.startsWith('0x')) {
    statusEl.innerHTML = '<div class="status error" style="margin-top:8px">Paste a valid hex signature from the coprocessor.</div>'
    return
  }

  const netErr = await checkNetworkForWrite()
  if (netErr) { statusEl.innerHTML = `<div class="status error" style="margin-top:8px">${netErr}</div>`; return }

  statusEl.innerHTML = '<div class="status info" style="margin-top:8px">Publishing on-chain...</div>'
  try {
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, signer)
    const tx = await contract.publishMatchResult(campaignId, result, signature)
    await tx.wait()
    // Refresh inbox to update this card's state
    await loadFanInbox()
  } catch (e: any) {
    statusEl.innerHTML = `<div class="status error" style="margin-top:8px">${readableError(e)}</div>`
  }
}

async function confirmView(campaignId: number) {
  if (!signer) return
  const statusEl = document.getElementById(`action-status-${campaignId}`)!

  const netErr = await checkNetworkForWrite()
  if (netErr) { statusEl.innerHTML = `<div class="status error" style="margin-top:8px">${netErr}</div>`; return }

  statusEl.innerHTML = '<div class="status info" style="margin-top:8px">Confirming view on-chain...</div>'
  try {
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, signer)
    const tx = await contract.confirmView(campaignId)
    await tx.wait()
    await loadFanInbox()
  } catch (e: any) {
    statusEl.innerHTML = `<div class="status error" style="margin-top:8px">${readableError(e)}</div>`
  }
}

async function recordClick(campaignId: number) {
  if (!signer) return
  try {
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, signer)
    const tx = await contract.recordClick(campaignId)
    await tx.wait()
  } catch {
    // non-critical — fire and forget
  }
}

// ─── Sponsor Actions ──────────────────────────────────────────────────────────

async function createCampaign() {
  if (!signer) return
  const statusEl = document.getElementById('campaign-status')!

  const name = (document.getElementById('campaign-name') as HTMLInputElement).value.trim()
  const adContentURI = (document.getElementById('ad-content-uri') as HTMLInputElement).value.trim()
  const adType = parseInt((document.getElementById('ad-type') as HTMLSelectElement).value)
  const clubAddress = (document.getElementById('club-address') as HTMLInputElement).value.trim()
  const reward = (document.getElementById('reward-amount') as HTMLInputElement).value.trim()
  const budget = (document.getElementById('total-budget') as HTMLInputElement).value.trim()
  const minSpend = parseInt((document.getElementById('min-spend') as HTMLInputElement).value)
  const minAttendance = parseInt((document.getElementById('min-attendance') as HTMLInputElement).value)
  const minLoyalty = parseInt((document.getElementById('min-loyalty') as HTMLInputElement).value)

  if (!name) { statusEl.innerHTML = '<div class="status error">Campaign name is required.</div>'; return }
  if (!adContentURI) { statusEl.innerHTML = '<div class="status error">Ad content URI is required.</div>'; return }
  if (!ethers.isAddress(clubAddress)) { statusEl.innerHTML = '<div class="status error">Enter a valid club address.</div>'; return }
  if (!reward || !budget) { statusEl.innerHTML = '<div class="status error">Enter cost and budget.</div>'; return }
  if (isNaN(minSpend) || isNaN(minAttendance) || isNaN(minLoyalty)) {
    statusEl.innerHTML = '<div class="status error">Fill in all targeting thresholds.</div>'; return
  }

  const netErr = await checkNetworkForWrite()
  if (netErr) { statusEl.innerHTML = `<div class="status error">${netErr}</div>`; return }

  statusEl.innerHTML = '<div class="status info">Creating campaign on-chain...</div>'
  try {
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, signer)
    const tx = await contract.createCampaign(
      name, adContentURI, adType, clubAddress,
      minSpend, minAttendance, minLoyalty,
      ethers.parseEther(reward),
      { value: ethers.parseEther(budget) }
    )
    statusEl.innerHTML = '<div class="status info">Confirming...</div>'
    const receipt = await tx.wait()

    let campaignId = '—'
    const iface = new ethers.Interface(CampaignABI)
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data })
        if (parsed?.name === 'CampaignCreated') { campaignId = parsed.args[0].toString(); break }
      } catch { /* skip */ }
    }

    statusEl.innerHTML = `
      <div class="status success">
        Campaign created!<br>
        <strong style="font-size: 18px;">Campaign ID: ${campaignId}</strong><br>
        <small>Revenue split: 60% to club / 30% to fans / 10% protocol</small><br>
        <small>Tx: ${receipt.hash}</small>
      </div>
    `
  } catch (e: any) {
    statusEl.innerHTML = `<div class="status error">${readableError(e)}</div>`
  }
}

async function viewCampaignStats() {
  const analyticsEl = document.getElementById('campaign-analytics')!
  const campaignId = parseInt((document.getElementById('view-campaign-id') as HTMLInputElement).value)

  if (isNaN(campaignId) || campaignId < 0) {
    analyticsEl.innerHTML = '<div class="status error">Enter a valid Campaign ID.</div>'; return
  }

  analyticsEl.innerHTML = '<div class="status info">Loading...</div>'

  try {
    const contract = new ethers.Contract(CONTRACTS.CAMPAIGN, CampaignABI, getReadProvider())
    const s = await contract.getCampaignStats(campaignId)

    const matched = BigInt(s.matchCount.toString())
    const impressions = BigInt(s.impressionCount.toString())
    const clicks = BigInt(s.clickCount.toString())
    const total = BigInt(s.totalBudget.toString())
    const remaining = BigInt(s.remainingBudget.toString())
    const spent = total - remaining

    const deliveryRate = matched > 0n ? Number((impressions * 100n) / matched) : 0
    const ctr = impressions > 0n ? Number((clicks * 100n) / impressions) : 0
    const budgetUsedPct = total > 0n ? Number((spent * 100n) / total) : 0

    const adTypeNames = ['Video', 'Banner', 'Link']
    const adTypeName = adTypeNames[Number(s.adType)] ?? '—'
    const gatewayUrl = ipfsToHttp(s.adContentURI)

    analyticsEl.innerHTML = `
      <div class="analytics-card">

        <div class="analytics-header">
          <div>
            <div class="analytics-name">${esc(s.name)}</div>
            <div class="analytics-meta">
              ID #${campaignId}
              &middot; ${adTypeName}
              &middot; <span class="${s.active ? 'text-green' : 'text-red'}">${s.active ? 'Active' : 'Ended'}</span>
            </div>
          </div>
          <div class="analytics-uri">
            <a href="${esc(gatewayUrl)}" target="_blank" rel="noopener" class="ad-link">
              View Ad Content &#x2197;
            </a>
          </div>
        </div>

        <div class="funnel">
          <div class="funnel-step">
            <div class="funnel-num">${matched.toString()}</div>
            <div class="funnel-lbl">Matched</div>
          </div>
          <div class="funnel-arrow">&#x2192;</div>
          <div class="funnel-step">
            <div class="funnel-num">${impressions.toString()}</div>
            <div class="funnel-lbl">Viewed</div>
            <div class="funnel-rate">${deliveryRate}% delivery</div>
          </div>
          <div class="funnel-arrow">&#x2192;</div>
          <div class="funnel-step">
            <div class="funnel-num">${clicks.toString()}</div>
            <div class="funnel-lbl">Clicked</div>
            <div class="funnel-rate">${ctr}% CTR</div>
          </div>
        </div>

        <div class="budget-section">
          <div class="budget-row">
            <span>Budget spent</span>
            <span>${ethers.formatEther(spent)} / ${ethers.formatEther(total)} ETH</span>
          </div>
          <div class="budget-bar">
            <div class="budget-fill" style="width: ${budgetUsedPct}%"></div>
          </div>
        </div>

        <div class="analytics-footer">
          <span>Cost per impression: ${ethers.formatEther(s.costPerImpression)} ETH</span>
          <span>Club: ${s.clubAddress.slice(0,6)}...${s.clubAddress.slice(-4)}</span>
        </div>

        <div class="fhe-badge" style="margin-top: 12px;">
          Aggregate stats only &mdash; zero individual fan data exposed
        </div>
      </div>
    `
  } catch (e: any) {
    analyticsEl.innerHTML = `<div class="status error">Error: ${readableError(e)}</div>`
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
render()
