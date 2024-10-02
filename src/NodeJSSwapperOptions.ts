import {BN} from "@coral-xyz/anchor";
import {
    RedundantSwapPriceAssets
} from "crosslightning-sdk-base";
import {createSwapperOptions, SolanaSwapperOptions} from "./SolanaSwapper";
import {FileSystemStorageManager} from "crosslightning-sdk-base/dist/fs-storage";
import * as fs from "fs";
import {StorageObject} from "crosslightning-base";

export function createNodeJSSwapperOptions(
    chain: "DEVNET" | "MAINNET",
    maxFeeDifference?: BN,
    intermediaryUrl?: string,
    tokens?: RedundantSwapPriceAssets,
    httpTimeouts?: {getTimeout?: number, postTimeout?: number}
): SolanaSwapperOptions {
    const baseDirectory = "storage"+chain;
    try {
        fs.mkdirSync("storage"+chain);
    } catch (e) {}

    return createSwapperOptions(
        chain,
        maxFeeDifference,
        intermediaryUrl,
        tokens,
        httpTimeouts,
        <T extends StorageObject>(name) => new FileSystemStorageManager<T>(baseDirectory+"/"+name)
    );
}