import {RedundantSwapPriceAssets} from "crosslightning-sdk-base";

export const SolanaChains = {
    DEVNET: {
        addresses: {
            swapContract: "4hfUykhqmD7ZRvNh1HuzVKEY7ToENixtdUKZspNDCrEM",
            btcRelayContract: "3KHSHFpEK6bsjg3bqcxQ9qssJYtRCMi2S9TYVe4q6CQc"
        },
        tokens: {
            WBTC: "4Jar76rqMxBfLDLa1syMd7i4R2YhGSkz2EYiAFyNVxja",
            USDC: "6jrUSQHX8MTJbtWpdbx65TAwUv1rLyCF6fVjr9yELS75",
            USDT: "Ar5yfeSyDNDHyq1GvtcrDKjNcoVTQiv7JaVvuMDbGNDT",
            WSOL: "So11111111111111111111111111111111111111112",
            BONK: "EaYnfpS7cZYe6MJRCvGQZA1EHcL4vexbQVHZbd7jnFxc"
        },
        registryUrl: "https://api.github.com/repos/adambor/SolLightning-registry/contents/registry.json?ref=main",
        trustedSwapForGasUrl: "https://node3.gethopa.com:24100"
    },
    MAINNET: {
        addresses: {
            swapContract: "4hfUykhqmD7ZRvNh1HuzVKEY7ToENixtdUKZspNDCrEM",
            btcRelayContract: "3KHSHFpEK6bsjg3bqcxQ9qssJYtRCMi2S9TYVe4q6CQc"
        },
        tokens: {
            WBTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
            USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
            WSOL: "So11111111111111111111111111111111111111112",
            BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
        },
        registryUrl: "https://api.github.com/repos/adambor/SolLightning-registry/contents/registry-mainnet.json?ref=main",
        trustedSwapForGasUrl: "https://node3.gethopa.com:34100"
    }
};

export function getCoinsMap(chain:  "DEVNET" | "MAINNET", tokenAddresses?: {WBTC: string, USDC: string, USDT: string, BONK: string}): RedundantSwapPriceAssets {
    return {
        [SolanaChains[chain].tokens.WBTC || tokenAddresses?.WBTC]: {
            binancePair: "WBTCBTC",
            okxPair: "$fixed-1",
            coinGeckoCoinId: "wrapped-bitcoin",
            coinPaprikaCoinId: "wbtc-wrapped-bitcoin",
            decimals: 8
        },
        [SolanaChains[chain].tokens.USDC || tokenAddresses?.USDC]: {
            binancePair: "!BTCUSDC",
            okxPair: "!BTC-USDC",
            coinGeckoCoinId: "usd-coin",
            coinPaprikaCoinId: "usdc-usd-coin",
            decimals: 6
        },
        [SolanaChains[chain].tokens.USDT || tokenAddresses?.USDT]: {
            binancePair: "!BTCUSDT",
            okxPair: "!BTC-USDT",
            coinGeckoCoinId: "tether",
            coinPaprikaCoinId: "usdt-tether",
            decimals: 6
        },
        [SolanaChains[chain].tokens.WSOL]: {
            binancePair: "SOLBTC",
            okxPair: "SOL-BTC",
            coinGeckoCoinId: "solana",
            coinPaprikaCoinId: "sol-solana",
            decimals: 9
        },
        [SolanaChains[chain].tokens.BONK || tokenAddresses?.BONK]: {
            binancePair: "BONKUSDC;!BTCUSDC",
            okxPair: null,
            coinGeckoCoinId: "bonk",
            coinPaprikaCoinId: "bonk-bonk",
            decimals: 5
        }
    };
}