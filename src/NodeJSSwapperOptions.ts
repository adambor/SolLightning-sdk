import {BN} from "@coral-xyz/anchor";
import {SolanaChains} from "./SolanaChains";
import {BitcoinNetwork} from "./BitcoinNetwork";
import {CoinGeckoSwapPrice} from "crosslightning-sdk-base";
import {SwapperOptions} from "./SolanaSwapper";
import {FileSystemStorageManager, FileSystemWrapperStorage} from "crosslightning-sdk-base/dist/fs-storage";
import * as fs from "fs";

export function createNodeJSSwapperOptions(chain: "DEVNET" | "MAINNET", maxFeeDifference?: BN, intermediaryUrl?: string, tokenAddresses?: {WBTC: string, USDC: string, USDT: string}): SwapperOptions {
    const coinsMap = CoinGeckoSwapPrice.createCoinsMap(
        SolanaChains[chain].tokens.WBTC || tokenAddresses?.WBTC,
        SolanaChains[chain].tokens.USDC || tokenAddresses?.USDC,
        SolanaChains[chain].tokens.USDT || tokenAddresses?.USDT
    );

    coinsMap[SolanaChains[chain].tokens.WSOL] = {
        coinId: "solana",
        decimals: 9
    };

    const returnObj: SwapperOptions =  {
        pricing: new CoinGeckoSwapPrice(
            maxFeeDifference || new BN(5000),
            coinsMap
        ),
        registryUrl: SolanaChains[chain].registryUrl,

        addresses: {
            swapContract: SolanaChains[chain].addresses.swapContract,
            btcRelayContract: SolanaChains[chain].addresses.btcRelayContract
        },
        bitcoinNetwork: chain==="MAINNET" ? BitcoinNetwork.MAINNET : BitcoinNetwork.TESTNET,
        intermediaryUrl: intermediaryUrl
    };

    try {
        fs.mkdirSync("storage");
    } catch (e) {}

    returnObj.storage = {};

    returnObj.storage.dataAccount = new FileSystemStorageManager("storage/data");
    returnObj.storage.fromBtc = new FileSystemWrapperStorage("storage/fromBtc");
    returnObj.storage.fromBtcLn = new FileSystemWrapperStorage("storage/fromBtcLn");
    returnObj.storage.toBtc = new FileSystemWrapperStorage("storage/toBtc");
    returnObj.storage.toBtcLn = new FileSystemWrapperStorage("storage/toBtcLn");

    return returnObj;
}