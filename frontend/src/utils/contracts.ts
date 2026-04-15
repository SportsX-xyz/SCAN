// Contract addresses — update after deployment
// Arbitrum Sepolia addresses kept for reference
export const CONTRACTS_ARB_SEPOLIA = {
  FAN_PROFILE: '0xED39DbD39AF8a324888bDc2068a558e8eba6fC75',
  CAMPAIGN:    '0x7602c6FD821e094E105677b6DC26B1e63Dc523bb',
}

// Local Hardhat node (for demo / development)
export const CONTRACTS_LOCAL = {
  FAN_PROFILE: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
  CAMPAIGN:    '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
}

// Active deployment
export const CONTRACTS = CONTRACTS_ARB_SEPOLIA

// Local Hardhat chain config
export const CHAIN_CONFIG_LOCAL = {
  chainId: '0x7A69',          // 31337 in hex
  chainName: 'Hardhat Local',
  rpcUrls: ['http://127.0.0.1:8545'],
  blockExplorerUrls: [] as string[],
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
}

// Arbitrum Sepolia config
export const CHAIN_CONFIG_ARB_SEPOLIA = {
  chainId: '0x66eee',         // 421614 in hex
  chainName: 'Arbitrum Sepolia',
  rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
  blockExplorerUrls: ['https://sepolia.arbiscan.io'],
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
}

// Active chain config
export const CHAIN_CONFIG = CHAIN_CONFIG_ARB_SEPOLIA
