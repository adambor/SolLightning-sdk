import SoltoBTCLNWrapper from "./swaps/tobtc/soltobtcln/SoltoBTCLNWrapper";
import SoltoBTCWrapper from "./swaps/tobtc/soltobtc/SoltoBTCWrapper";
import BTCLNtoSolWrapper from "./swaps/frombtc/btclntosol/BTCLNtoSolWrapper";
import LocalWrapperStorage from "./storage/LocalWrapperStorage";
import {AnchorProvider, BN} from "@project-serum/anchor";
import ISwap from "./swaps/ISwap";
import ISolToBTCxSwap from "./swaps/tobtc/ISolToBTCxSwap";
import IBTCxtoSolSwap from "./swaps/frombtc/IBTCxtoSolSwap";
import SoltoBTCSwap from "./swaps/tobtc/soltobtc/SoltoBTCSwap";
import SoltoBTCLNSwap from "./swaps/tobtc/soltobtcln/SoltoBTCLNSwap";
import BTCLNtoSolSwap from "./swaps/frombtc/btclntosol/BTCLNtoSolSwap"
import * as bitcoin from "bitcoinjs-lib";
import * as bolt11 from "bolt11";
import SwapType from "./swaps/SwapType";
import {Bitcoin, ConstantBTCLNtoSol, ConstantBTCtoSol, ConstantSoltoBTC, ConstantSoltoBTCLN} from "../Constants";
import {PublicKey} from "@solana/web3.js";
import BTCtoSolNewWrapper from "./swaps/frombtc/btctosolNew/BTCtoSolNewWrapper";
import BTCtoSolNewSwap from "./swaps/frombtc/btctosolNew/BTCtoSolNewSwap";
import SolanaSwapData from "./chains/solana/swaps/SolanaSwapData";
import SolanaClientSwapContract from "./chains/solana/swaps/SolanaClientSwapContract";
import SolanaChainEvents from "./chains/solana/events/SolanaChainEvents";
import IntermediaryDiscovery from "./intermediaries/IntermediaryDiscovery";
import IntermediaryError from "./errors/IntermediaryError";

export default class SolanaSwapper {

    soltobtcln: SoltoBTCLNWrapper<SolanaSwapData>;
    soltobtc: SoltoBTCWrapper<SolanaSwapData>;
    btclntosol: BTCLNtoSolWrapper<SolanaSwapData>;
    btctosol: BTCtoSolNewWrapper<SolanaSwapData>;

    private readonly intermediaryUrl: string;
    private readonly intermediaryDiscovery: IntermediaryDiscovery<SolanaSwapData>;

    /**
     * Returns true if string is a valid bitcoin address
     *
     * @param address
     */
    static isValidBitcoinAddress(address: string): boolean {
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
    static isValidLightningInvoice(lnpr: string): boolean {
        try {
            const parsed = bolt11.decode(lnpr);
            if(parsed.satoshis!=null) return true;
        } catch (e) {}
        return false;
    }

    constructor(provider: AnchorProvider, intermediaryUrl?: string, wbtcToken?: PublicKey) {
        const swapContract = new SolanaClientSwapContract(provider, wbtcToken || Bitcoin.wbtcToken);
        const chainEvents = new SolanaChainEvents(provider, swapContract);

        this.soltobtcln = new SoltoBTCLNWrapper(new LocalWrapperStorage("solSwaps-SoltoBTCLN"), swapContract, chainEvents);
        this.soltobtc = new SoltoBTCWrapper(new LocalWrapperStorage("solSwaps-SoltoBTC"), swapContract, chainEvents);
        this.btclntosol = new BTCLNtoSolWrapper(new LocalWrapperStorage("solSwaps-BTCLNtoSol"), swapContract, chainEvents);
        this.btctosol = new BTCtoSolNewWrapper(new LocalWrapperStorage("solSwaps-BTCtoSol"), swapContract, chainEvents);

        if(intermediaryUrl!=null) {
            this.intermediaryUrl = intermediaryUrl;
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
            case SwapType.BTC_TO_SOL:
                return ConstantBTCtoSol.max;
            case SwapType.BTCLN_TO_SOL:
                return ConstantBTCLNtoSol.max;
            case SwapType.SOL_TO_BTC:
                return ConstantSoltoBTC.max;
            case SwapType.SOL_TO_BTCLN:
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
            case SwapType.BTC_TO_SOL:
                return ConstantBTCtoSol.min;
            case SwapType.BTCLN_TO_SOL:
                return ConstantBTCLNtoSol.min;
            case SwapType.SOL_TO_BTC:
                return ConstantSoltoBTC.min;
            case SwapType.SOL_TO_BTCLN:
                return ConstantSoltoBTCLN.min;
        }
        return new BN(0);
    }

    /**
     * Initializes the swap storage and loads existing swaps
     * Needs to be called before any other action
     */
    async init() {
        await this.soltobtcln.init();
        await this.soltobtc.init();
        await this.btclntosol.init();
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
     * @param address               Recipient's bitcoin address
     * @param amount                Amount to send in satoshis (bitcoin's smallest denomination)
     * @param confirmationTarget    How soon should the transaction be confirmed (determines the fee)
     * @param confirmations         How many confirmations must the intermediary wait to claim the funds
     */
    async createSolToBTCSwap(address: string, amount: BN, confirmationTarget?: number, confirmations?: number): Promise<SoltoBTCSwap<SolanaSwapData>> {
        if(this.intermediaryUrl!=null) {
            return this.soltobtc.create(address, amount, confirmationTarget || 3, confirmations || 3, this.intermediaryUrl+"/tobtc");
        }
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.SOL_TO_BTC, amount);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        for(let candidate of candidates) {
            try {
                swap = await this.soltobtc.create(address, amount, confirmationTarget || 3, confirmations || 3, candidate.url+"/tobtc", candidate.address);
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
     * @param paymentRequest        BOLT11 lightning network invoice to be paid (needs to have a fixed amount)
     * @param expirySeconds         For how long to lock your funds (higher expiry means higher probability of payment success)
     */
    async createSolToBTCLNSwap(paymentRequest: string, expirySeconds?: number): Promise<SoltoBTCLNSwap<SolanaSwapData>> {
        if(this.intermediaryUrl!=null) {
            return this.soltobtcln.create(paymentRequest, expirySeconds || (3 * 24 * 3600), this.intermediaryUrl + "/tobtcln");
        }
        const parsedPR = bolt11.decode(paymentRequest);
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.SOL_TO_BTCLN, new BN(parsedPR.millisatoshis).div(new BN(1000)));
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        for(let candidate of candidates) {
            try {
                swap = await this.soltobtcln.create(paymentRequest, expirySeconds || (3*24*3600), candidate.url+"/tobtcln", candidate.address);
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
     * @param amount        Amount to receive, in satoshis (bitcoin's smallest denomination)
     */
    async createBTCtoSolSwap(amount: BN): Promise<BTCtoSolNewSwap<SolanaSwapData>> {
        if(this.intermediaryUrl!=null) {
            return this.btctosol.create(amount, this.intermediaryUrl+"/frombtc");
        }
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.BTC_TO_SOL, amount);
        if(candidates.length===0) throw new Error("No intermediary found!");

        let swap;
        for(let candidate of candidates) {
            try {
                swap = await this.btctosol.create(amount, candidate.url+"/frombtc", candidate.address);
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
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param invoiceExpiry     Lightning invoice expiry time (in seconds)
     */
    async createBTCLNtoSolSwap(amount: BN, invoiceExpiry?: number): Promise<BTCLNtoSolSwap<SolanaSwapData>> {
        if(this.intermediaryUrl!=null) {
            return this.btclntosol.create(amount, invoiceExpiry || (1*24*3600), this.intermediaryUrl+"/frombtcln");
        }
        const candidates = this.intermediaryDiscovery.getSwapCandidates(SwapType.BTCLN_TO_SOL, amount);
        if(candidates.length===0) throw new Error("No intermediary found!");


        let swap;
        for(let candidate of candidates) {
            try {
                swap = await this.btclntosol.create(amount, invoiceExpiry || (1*24*3600), candidate.url+"/frombtcln", candidate.address);
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