import {AnchorProvider, BN, Wallet} from "@coral-xyz/anchor";
import * as bitcoin from "bitcoinjs-lib";
import * as bolt11 from "bolt11";
import {Bitcoin, ConstantBTCLNtoSol, ConstantBTCtoSol, ConstantSoltoBTC, ConstantSoltoBTCLN} from "./Constants";
import {Connection, Keypair, PublicKey, Signer} from "@solana/web3.js";

import KeypairWallet from "./wallet/KeypairWallet";

import {SolanaBtcRelay, SolanaSwapData, SolanaSwapProgram} from "crosslightning-solana";
import {SolanaChainEventsBrowser} from "crosslightning-solana/dist/solana/events/SolanaChainEventsBrowser";

import {
    ISwapPrice, MempoolBitcoinRpc,
    BTCLNtoSolWrapper,
    ClientSwapContract,
    IntermediaryDiscovery,
    SoltoBTCLNWrapper,
    SoltoBTCWrapper,
    BTCtoSolNewWrapper,
    MempoolBtcRelaySynchronizer,
    LocalStorageManager,
    LocalWrapperStorage,
    SwapType,
    SoltoBTCSwap,
    IntermediaryError, SoltoBTCLNSwap, BTCtoSolNewSwap, BTCLNtoSolSwap, ISwap, ISolToBTCxSwap,
    IBTCxtoSolSwap
} from "crosslightning-sdk-base";

type SwapperOptions = {
    intermediaryUrl?: string,
    //wbtcToken?: PublicKey,
    pricing?: ISwapPrice
};

export class SolanaSwapper {

    soltobtcln: SoltoBTCLNWrapper<SolanaSwapData>;
    soltobtc: SoltoBTCWrapper<SolanaSwapData>;
    btclntosol: BTCLNtoSolWrapper<SolanaSwapData>;
    btctosol: BTCtoSolNewWrapper<SolanaSwapData>;

    private readonly intermediaryUrl: string;
    private readonly intermediaryDiscovery: IntermediaryDiscovery<SolanaSwapData>;
    private readonly swapContract: ClientSwapContract<SolanaSwapData>;
    private readonly chainEvents: SolanaChainEventsBrowser;

    /**
     * Returns true if string is a valid bitcoin address
     *
     * @param address
     */
    isValidBitcoinAddress(address: string): boolean {
        try {
            bitcoin.address.toOutputScript(address, ConstantBTCtoSol.network);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Returns true if string is a valid BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    isValidLightningInvoice(lnpr: string): boolean {
        try {
            const parsed = bolt11.decode(lnpr);
            if(parsed.satoshis!=null) return true;
        } catch (e) {}
        return false;
    }

    /**
     * Returns satoshi value of BOLT11 bitcoin lightning invoice WITH AMOUNT
     *
     * @param lnpr
     */
    static getLightningInvoiceValue(lnpr: string): BN {
        const parsed = bolt11.decode(lnpr);
        if(parsed.satoshis!=null) return new BN(parsed.satoshis);
        return null;
    }

    constructor(provider: AnchorProvider, options?: SwapperOptions);
    constructor(rpcUrl: string, keypair: Keypair, options?: SwapperOptions);

    constructor(providerOrRpcUrl: AnchorProvider | string, optionsOrKeypair?:  SwapperOptions | Keypair, noneOrOptions?: null | SwapperOptions) {
        let provider: AnchorProvider;
        let options: SwapperOptions;
        if(typeof(providerOrRpcUrl)==="string") {
            options = noneOrOptions;
            provider = new AnchorProvider(new Connection(providerOrRpcUrl), new KeypairWallet(optionsOrKeypair as Keypair), {
                commitment: "confirmed"
            });
        } else {
            provider = providerOrRpcUrl;
            options = optionsOrKeypair as SwapperOptions;
        }

        options = options || {};

        const bitcoinRpc = new MempoolBitcoinRpc();
        const btcRelay = new SolanaBtcRelay(provider, bitcoinRpc);
        const synchronizer = new MempoolBtcRelaySynchronizer(btcRelay, bitcoinRpc);

        const swapContract = new SolanaSwapProgram(provider, btcRelay, new LocalStorageManager("solAccounts"));

        const clientSwapContract = new ClientSwapContract<SolanaSwapData>(swapContract, SolanaSwapData, null, options.pricing, {
            bitcoinNetwork: ConstantBTCtoSol.network
        });
        const chainEvents = new SolanaChainEventsBrowser(provider, swapContract);

        this.soltobtcln = new SoltoBTCLNWrapper<SolanaSwapData>(new LocalWrapperStorage("solSwaps-SoltoBTCLN"), clientSwapContract, chainEvents, SolanaSwapData);
        this.soltobtc = new SoltoBTCWrapper<SolanaSwapData>(new LocalWrapperStorage("solSwaps-SoltoBTC"), clientSwapContract, chainEvents, SolanaSwapData);
        this.btclntosol = new BTCLNtoSolWrapper<SolanaSwapData>(new LocalWrapperStorage("solSwaps-BTCLNtoSol"), clientSwapContract, chainEvents, SolanaSwapData);
        this.btctosol = new BTCtoSolNewWrapper<SolanaSwapData>(new LocalWrapperStorage("solSwaps-BTCtoSol"), clientSwapContract, chainEvents, SolanaSwapData, synchronizer);

        this.chainEvents = chainEvents;
        this.swapContract = clientSwapContract;

        if(options.intermediaryUrl!=null) {
            this.intermediaryUrl = options.intermediaryUrl;
        } else {
            this.intermediaryDiscovery = new IntermediaryDiscovery<SolanaSwapData>(swapContract);
        }
    }

    /**
     * Returns maximum possible swap amount
     *
     * @param kind      Type of the swap
     */
    getMaximum(kind: SwapType): BN {
        if(this.intermediaryDiscovery!=null) {
            const max = this.intermediaryDiscovery.getSwapMaximum(kind);
            if(max!=null) return new BN(max);
        }
        switch(kind) {
            case SwapType.FROM_BTC:
                return ConstantBTCtoSol.max;
            case SwapType.FROM_BTCLN:
                return ConstantBTCLNtoSol.max;
            case SwapType.TO_BTC:
                return ConstantSoltoBTC.max;
            case SwapType.TO_BTCLN:
                return ConstantSoltoBTCLN.max;
        }
        return new BN(0);
    }

    /**
     * Returns minimum possible swap amount
     *
     * @param kind      Type of swap
     */
    getMinimum(kind: SwapType): BN {
        if(this.intermediaryDiscovery!=null) {
            const min = this.intermediaryDiscovery.getSwapMinimum(kind);
            if(min!=null) return new BN(min);
        }
        switch(kind) {
            case SwapType.FROM_BTC:
                return ConstantBTCtoSol.min;
            case SwapType.FROM_BTCLN:
                return ConstantBTCLNtoSol.min;
            case SwapType.TO_BTC:
                return ConstantSoltoBTC.min;
            case SwapType.TO_BTCLN:
                return ConstantSoltoBTCLN.min;
        }
        return new BN(0);
    }

    /**
     * Initializes the swap storage and loads existing swaps
     * Needs to be called before any other action
     */
    async init() {
        await this.chainEvents.init();
        await this.swapContract.init();

        console.log("Initializing Sol -> BTCLN");
        await this.soltobtcln.init();
        console.log("Initializing Sol -> BTC");
        await this.soltobtc.init();
        console.log("Initializing BTCLN -> Sol");
        await this.btclntosol.init();
        console.log("Initializing BTC -> Sol");
        await this.btctosol.init();

        if(this.intermediaryDiscovery!=null) {
            await this.intermediaryDiscovery.init();
        }
    }

    /**
     * Stops listening for Solana events and closes this Swapper instance
     */
    async stop() {
        await this.soltobtcln.stop();
        await this.soltobtc.stop();
        await this.btclntosol.stop();
        await this.btctosol.stop();
    }

    /**
     * Creates Solana -> BTC swap
     *
     * @param tokenAddress          Token address to pay with
     * @param address               Recipient's bitcoin address
     * @param amount                Amount to send in satoshis (bitcoin's smallest denomination)
     * @param confirmationTarget    How soon should the transaction be confirmed (determines the fee)
     * @param confirmations         How many confirmations must the intermediary wait to claim the funds
     */
    async createSolToBTCSwap(tokenAddress: PublicKey, address: string, amount: BN, confirmationTarget?: number, confirmations?: number): Promise<SoltoBTCSwap<SolanaSwapData>> {
        if(this.intermediaryUrl!=null) {
            return this.soltobtc.create(address, amount, confirmationTarget || 3, confirmations || 3, this.intermediaryUrl+"/tobtc");
        }
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.TO_BTC, amount, tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        for(let candidate of candidates) {
            try {
                swap = await this.soltobtc.create(address, amount, confirmationTarget || 3, confirmations || 3, candidate.url+"/tobtc", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.TO_BTC].swapBaseFee),
                    new BN(candidate.services[SwapType.TO_BTC].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
            }
        }

        if(swap==null) throw new Error("No intermediary found!");

        return swap;
    }

    /**
     * Creates Solana -> BTCLN swap
     *
     * @param tokenAddress          Token address to pay with
     * @param paymentRequest        BOLT11 lightning network invoice to be paid (needs to have a fixed amount)
     * @param expirySeconds         For how long to lock your funds (higher expiry means higher probability of payment success)
     */
    async createSolToBTCLNSwap(tokenAddress: PublicKey, paymentRequest: string, expirySeconds?: number): Promise<SoltoBTCLNSwap<SolanaSwapData>> {
        if(this.intermediaryUrl!=null) {
            return this.soltobtcln.create(paymentRequest, expirySeconds || (3 * 24 * 3600), this.intermediaryUrl + "/tobtcln");
        }
        const parsedPR = bolt11.decode(paymentRequest);
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.TO_BTCLN, new BN(parsedPR.millisatoshis).div(new BN(1000)), tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        for(let candidate of candidates) {
            try {
                swap = await this.soltobtcln.create(paymentRequest, expirySeconds || (3*24*3600), candidate.url+"/tobtcln", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.TO_BTCLN].swapBaseFee),
                    new BN(candidate.services[SwapType.TO_BTCLN].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
            }
        }

        if(swap==null) throw new Error("No intermediary found!");

        return swap;

    }

    /**
     * Creates BTC -> Solana swap
     *
     * @param tokenAddress          Token address to receive
     * @param amount                Amount to receive, in satoshis (bitcoin's smallest denomination)
     */
    async createBTCtoSolSwap(tokenAddress: PublicKey, amount: BN): Promise<BTCtoSolNewSwap<SolanaSwapData>> {
        if(this.intermediaryUrl!=null) {
            return this.btctosol.create(amount, this.intermediaryUrl+"/frombtc");
        }
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.FROM_BTC, amount, tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        for(let candidate of candidates) {
            try {
                swap = await this.btctosol.create(amount, candidate.url+"/frombtc", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.FROM_BTC].swapBaseFee),
                    new BN(candidate.services[SwapType.FROM_BTC].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
            }
        }

        if(swap==null) throw new Error("No intermediary found!");

        return swap;
    }

    /**
     * Creates BTCLN -> Solana swap
     *
     * @param tokenAddress      Token address to receive
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param invoiceExpiry     Lightning invoice expiry time (in seconds)
     */
    async createBTCLNtoSolSwap(tokenAddress: PublicKey, amount: BN, invoiceExpiry?: number): Promise<BTCLNtoSolSwap<SolanaSwapData>> {
        if(this.intermediaryUrl!=null) {
            return this.btclntosol.create(amount, invoiceExpiry || (1*24*3600), this.intermediaryUrl+"/frombtcln");
        }
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.FROM_BTCLN, amount, tokenAddress);
        if(candidates.length===0) throw new Error("No intermediary found!");


        let swap;
        for(let candidate of candidates) {
            try {
                swap = await this.btclntosol.create(amount, invoiceExpiry || (1*24*3600), candidate.url+"/frombtcln", tokenAddress, candidate.address,
                    new BN(candidate.services[SwapType.FROM_BTCLN].swapBaseFee),
                    new BN(candidate.services[SwapType.FROM_BTCLN].swapFeePPM));
                break;
            } catch (e) {
                if(e instanceof IntermediaryError) {
                    //Blacklist that node
                    this.intermediaryDiscovery.removeIntermediary(candidate);
                }
                console.error(e);
            }
        }

        if(swap==null) throw new Error("No intermediary found!");

        return swap;
    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<ISwap[]> {
        return [].concat(
            await this.soltobtcln.getAllSwaps(),
            await this.soltobtc.getAllSwaps(),
            await this.btclntosol.getAllSwaps(),
            await this.btctosol.getAllSwaps(),
        );
    }

    /**
     * Returns swaps that were initiated with the current provider's public key, and there is an action required (either claim or refund)
     */
    async getActionableSwaps(): Promise<ISwap[]> {
        return [].concat(
            await this.soltobtcln.getRefundableSwaps(),
            await this.soltobtc.getRefundableSwaps(),
            await this.btclntosol.getClaimableSwaps(),
            await this.btctosol.getClaimableSwaps(),
        );
    }

    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    async getRefundableSwaps(): Promise<ISolToBTCxSwap<SolanaSwapData>[]> {
        return [].concat(
            await this.soltobtcln.getRefundableSwaps(),
            await this.soltobtc.getRefundableSwaps()
        );
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps(): Promise<IBTCxtoSolSwap<SolanaSwapData>[]> {
        return [].concat(
            await this.btclntosol.getClaimableSwaps(),
            await this.btctosol.getClaimableSwaps()
        );
    }
}