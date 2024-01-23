import {AnchorProvider, BN} from "@coral-xyz/anchor";
import {Connection, Keypair, PublicKey} from "@solana/web3.js";

import KeypairWallet from "./wallet/KeypairWallet";

import {SolanaBtcRelay, SolanaSwapData, SolanaSwapProgram, StoredDataAccount} from "crosslightning-solana";

import {
    BinanceSwapPrice,
    CoinGeckoSwapPrice,
    LocalStorageManager,
    MempoolBitcoinRpc,
    OKXSwapPrice,
    Swapper,
    SwapperOptions
} from "crosslightning-sdk-base";
import {SolanaChains} from "./SolanaChains";
import {IStorageManager} from "crosslightning-base";
import {SolanaChainEventsBrowser} from "crosslightning-solana/dist/solana/events/SolanaChainEventsBrowser";
import {BitcoinNetwork} from "crosslightning-sdk-base/dist/btc/BitcoinNetwork";

export type SolanaSwapperOptions = SwapperOptions & {
    storage?: {
        dataAccount?: IStorageManager<StoredDataAccount>
    }
};

export function createSwapperOptions(
    chain: "DEVNET" | "MAINNET",
    maxFeeDifference?: BN,
    intermediaryUrl?: string,
    tokenAddresses?: {WBTC: string, USDC: string, USDT: string},
    httpTimeouts?: {getTimeout?: number, postTimeout?: number}
): SwapperOptions {
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

    return {
        pricing: new OKXSwapPrice(
            maxFeeDifference || new BN(10000),
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
        postRequestTimeout: httpTimeouts?.postTimeout,
    };

};

export class SolanaSwapper extends Swapper<
    SolanaSwapData,
    SolanaChainEventsBrowser,
    SolanaSwapProgram,
    PublicKey
> {

    constructor(provider: AnchorProvider, options?: SwapperOptions);
    constructor(rpcUrl: string, keypair: Keypair, options?: SwapperOptions);

    constructor(providerOrRpcUrl: AnchorProvider | string, optionsOrKeypair?: SolanaSwapperOptions | Keypair, noneOrOptions?: null | SolanaSwapperOptions) {
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
        const btcRelay = new SolanaBtcRelay(provider, bitcoinRpc, options.addresses.btcRelayContract);
        const swapContract = new SolanaSwapProgram(provider, btcRelay, options.storage?.dataAccount || new LocalStorageManager("solAccounts"), options.addresses.swapContract);
        const chainEvents = new SolanaChainEventsBrowser(provider, swapContract);

        options.bitcoinNetwork = options.bitcoinNetwork==null ? BitcoinNetwork.TESTNET : options.bitcoinNetwork;

        super(btcRelay, bitcoinRpc, swapContract, chainEvents, SolanaSwapData, options, "SOLv4-"+options.bitcoinNetwork+"-");
    }
}