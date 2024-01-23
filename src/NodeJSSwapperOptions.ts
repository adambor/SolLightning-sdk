import {BN} from "@coral-xyz/anchor";
import {SolanaChains} from "./SolanaChains";
import {BinanceSwapPrice, BitcoinNetwork, CoinGeckoSwapPrice, OKXSwapPrice} from "crosslightning-sdk-base";
import {SolanaSwapperOptions} from "./SolanaSwapper";
import {FileSystemStorageManager, FileSystemWrapperStorage} from "crosslightning-sdk-base/dist/fs-storage";
import * as fs from "fs";

export function createNodeJSSwapperOptions(
    chain: "DEVNET" | "MAINNET",
    maxFeeDifference?: BN,
    intermediaryUrl?: string,
    tokenAddresses?: {WBTC: string, USDC: string, USDT: string},
    httpTimeouts?: {getTimeout?: number, postTimeout?: number}
): SolanaSwapperOptions {
    const coinsMap = OKXSwapPrice.createCoinsMap(
        SolanaChains[chain].tokens.WBTC || tokenAddresses?.WBTC,
        SolanaChains[chain].tokens.USDC || tokenAddresses?.USDC,
        SolanaChains[chain].tokens.USDT || tokenAddresses?.USDT
    );

    coinsMap[SolanaChains[chain].tokens.WSOL] = {
        pair: "SOL-BTC",
        decimals: 9,
        invert: false
    };

    const returnObj: SolanaSwapperOptions =  {
        pricing: new OKXSwapPrice(
            maxFeeDifference || new BN(5000),
            coinsMap,
            null,
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
        postRequestTimeout: httpTimeouts?.postTimeout
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