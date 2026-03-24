// Contract addresses - update after deployment
export const CONTRACTS = {
  // Arbitrum Sepolia deployment addresses (update after deploy)
  FAN_PROFILE: '0x35Bd9f53261AbD0314C6349492397DE0F4d07Ec3',
  CAMPAIGN: '0xc2011a5942f12A67C7bdeDD08948C3F26564132e',
}

// Chain config
export const CHAIN_CONFIG = {
  chainId: '0x66eee', // 421614 in hex (Arbitrum Sepolia)
  chainName: 'Arbitrum Sepolia',
  rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
  blockExplorerUrls: ['https://sepolia.arbiscan.io'],
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
}
