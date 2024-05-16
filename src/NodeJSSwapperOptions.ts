import {BN} from "@coral-xyz/anchor";
import {getCoinsMap, SolanaChains} from "./SolanaChains";
import {
    BitcoinNetwork,
    RedundantSwapPrice, RedundantSwapPriceAssets
} from "crosslightning-sdk-base";
import {SolanaSwapperOptions} from "./SolanaSwapper";
import {FileSystemStorageManager, FileSystemWrapperStorage} from "crosslightning-sdk-base/dist/fs-storage";
import * as fs from "fs";

export function createNodeJSSwapperOptions(
    chain: "DEVNET" | "MAINNET",
    maxFeeDifference?: BN,
    intermediaryUrl?: string,
    tokens?: RedundantSwapPriceAssets,
    httpTimeouts?: {getTimeout?: number, postTimeout?: number}
): SolanaSwapperOptions {
    // const coinsMapOKX = OKXSwapPrice.createCoinsMap(
    //     SolanaChains[chain].tokens.WBTC || tokenAddresses?.WBTC,
    //     SolanaChains[chain].tokens.USDC || tokenAddresses?.USDC,
    //     SolanaChains[chain].tokens.USDT || tokenAddresses?.USDT
    // );
    // coinsMapOKX[SolanaChains[chain].tokens.WSOL] = {
    //     pair: "SOL-BTC",
    //     decimals: 9,
    //     invert: false
    // };
    // const okx = new OKXPriceProvider(
    //     coinsMapOKX,
    //     null,
    //     httpTimeouts?.getTimeout
    // );
    //
    // const coinsMapBinance = BinanceSwapPrice.createCoinsMap(
    //     SolanaChains[chain].tokens.WBTC || tokenAddresses?.WBTC,
    //     SolanaChains[chain].tokens.USDC || tokenAddresses?.USDC,
    //     SolanaChains[chain].tokens.USDT || tokenAddresses?.USDT
    // );
    // coinsMapBinance[SolanaChains[chain].tokens.WSOL] = {
    //     pair: "SOLBTC",
    //     decimals: 9,
    //     invert: false
    // };
    // const binance = new BinancePriceProvider(
    //     coinsMapBinance,
    //     null,
    //     httpTimeouts?.getTimeout
    // );
    //
    // const coinMapSwaps = RedundantSwapPrice.createCoinsMap(
    //     SolanaChains[chain].tokens.WBTC || tokenAddresses?.WBTC,
    //     SolanaChains[chain].tokens.USDC || tokenAddresses?.USDC,
    //     SolanaChains[chain].tokens.USDT || tokenAddresses?.USDT
    // );
    // coinMapSwaps[SolanaChains[chain].tokens.WSOL] = 9;

    const returnObj: SolanaSwapperOptions =  {
        pricing: RedundantSwapPrice.createFromTokenMap(
            maxFeeDifference || new BN(10000),
            tokens || getCoinsMap(chain),
            httpTimeouts?.getTimeout
        ),
        registryUrl: SolanaChains[chain].registryUrl,

        addresses: {
            swapContract: SolanaChains[chain].addresses.swapContract,
            btcRelayContract: SolanaChains[chain].addresses.btcRelayContract
        },
        bitcoinNetwork: chain==="MAINNET" ? BitcoinNetwork.MAINNET : BitcoinNetwork.TESTNET,
        intermediaryUrl: intermediaryUrl,

        getRequestTimeout: httpTimeouts?.getTimeout,
        postRequestTimeout: httpTimeouts?.postTimeout,
        defaultTrustedIntermediaryUrl: SolanaChains[chain].trustedSwapForGasUrl
    };

    try {
        fs.mkdirSync("storage"+chain);
    } catch (e) {}

    returnObj.storage = {};

    returnObj.storage.dataAccount = new FileSystemStorageManager("storage"+chain+"/data");
    returnObj.storage.fromBtc = new FileSystemWrapperStorage("storage"+chain+"/fromBtc");
    returnObj.storage.fromBtcLn = new FileSystemWrapperStorage("storage"+chain+"/fromBtcLn");
    returnObj.storage.toBtc = new FileSystemWrapperStorage("storage"+chain+"/toBtc");
    returnObj.storage.toBtcLn = new FileSystemWrapperStorage("storage"+chain+"/toBtcLn");

    return returnObj;
}