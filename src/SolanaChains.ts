
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
            WSOL: "So11111111111111111111111111111111111111112"
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
            WSOL: "So11111111111111111111111111111111111111112"
        },
        registryUrl: "https://api.github.com/repos/adambor/SolLightning-registry/contents/registry-mainnet.json?ref=main",
        trustedSwapForGasUrl: "https://node3.gethopa.com:34100"
    }
};