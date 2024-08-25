import {AnchorProvider, BN} from "@coral-xyz/anchor";
import {Connection, Keypair, PublicKey} from "@solana/web3.js";

import KeypairWallet from "./wallet/KeypairWallet";

import {
    SolanaBtcRelay,
    SolanaFees, SolanaRetryPolicy,
    SolanaSwapData,
    SolanaSwapProgram,
    StoredDataAccount
} from "crosslightning-solana";

import {
    IWrapperStorage,
    LocalStorageManager,
    MempoolBitcoinRpc,
    RedundantSwapPrice, RedundantSwapPriceAssets,
    Swapper,
    SwapperOptions
} from "crosslightning-sdk-base";
import {getCoinsMap, SolanaChains} from "./SolanaChains";
import {IStorageManager, StorageObject} from "crosslightning-base";
import {SolanaChainEventsBrowser} from "crosslightning-solana/dist/solana/events/SolanaChainEventsBrowser";
import {BitcoinNetwork} from "crosslightning-sdk-base/dist/btc/BitcoinNetwork";

export type SolanaSwapperOptions = SwapperOptions<SolanaSwapData> & {
    storage?: {
        dataAccount?: IStorageManager<StoredDataAccount>
    },
    feeEstimator?: SolanaFees,
    retryPolicy?: SolanaRetryPolicy
};

export function createSwapperOptions(
    chain: "DEVNET" | "MAINNET",
    maxFeeDifference?: BN,
    intermediaryUrl?: string | string[],
    tokens?: RedundantSwapPriceAssets,
    httpTimeouts?: {getTimeout?: number, postTimeout?: number},
    storageCtors?: {
        wrapper: (name: string) => IWrapperStorage,
        storage: <T extends StorageObject>(name: string) => IStorageManager<T>
    }
): SolanaSwapperOptions {
    
    const returnObj: SolanaSwapperOptions = {
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

    if(storageCtors!=null) {
        returnObj.storage = {};

        returnObj.storage.dataAccount = storageCtors.storage("data");
        returnObj.storage.fromBtc = storageCtors.wrapper("fromBtc");
        returnObj.storage.fromBtcLn = storageCtors.wrapper("fromBtcLn");
        returnObj.storage.toBtc = storageCtors.wrapper("toBtc");
        returnObj.storage.toBtcLn = storageCtors.wrapper("toBtcLn");
        returnObj.storage.lnForGas = storageCtors.storage("lnForGas");
    }

    return returnObj;

};

export class SolanaSwapper extends Swapper<
    SolanaSwapData,
    SolanaChainEventsBrowser,
    SolanaSwapProgram,
    PublicKey
> {

    constructor(provider: AnchorProvider, options?: SwapperOptions<SolanaSwapData>);
    constructor(rpcUrl: string, keypair: Keypair, options?: SwapperOptions<SolanaSwapData>);

    constructor(
        providerOrRpcUrl: AnchorProvider | string,
        optionsOrKeypair?: SolanaSwapperOptions | Keypair,
        noneOrOptions?: null | SolanaSwapperOptions
    ) {
        let provider: AnchorProvider;
        let options: SolanaSwapperOptions;
        if(typeof(providerOrRpcUrl)==="string") {
            options = noneOrOptions;
            provider = new AnchorProvider(new Connection(providerOrRpcUrl), new KeypairWallet(optionsOrKeypair as Keypair), {
                commitment: "confirmed"
            });
        } else {
            provider = providerOrRpcUrl;
            options = optionsOrKeypair as SolanaSwapperOptions;
        }

        options = options || {};
        options.addresses = options.addresses || SolanaChains.DEVNET.addresses;

        const bitcoinRpc = new MempoolBitcoinRpc();
        const btcRelay = new SolanaBtcRelay(provider, bitcoinRpc, options.addresses.btcRelayContract, options.feeEstimator);
        const swapContract = new SolanaSwapProgram(provider, btcRelay, options.storage?.dataAccount || new LocalStorageManager("solAccounts"), options.addresses.swapContract, options.retryPolicy || {
            transactionResendInterval: 1000
        }, options.feeEstimator);
        const chainEvents = new SolanaChainEventsBrowser(provider, swapContract);

        options.bitcoinNetwork = options.bitcoinNetwork==null ? BitcoinNetwork.TESTNET : options.bitcoinNetwork;

        super(btcRelay, bitcoinRpc, swapContract, chainEvents, SolanaSwapData, options, "SOLv4-"+options.bitcoinNetwork+"-");
    }
}