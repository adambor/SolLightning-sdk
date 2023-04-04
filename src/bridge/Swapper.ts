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

export default class SolanaSwapper {

    soltobtcln: SoltoBTCLNWrapper<SolanaSwapData>;
    soltobtc: SoltoBTCWrapper<SolanaSwapData>;
    btclntosol: BTCLNtoSolWrapper<SolanaSwapData>;
    btctosol: BTCtoSolNewWrapper<SolanaSwapData>;

    private readonly intermediaryUrl: string;

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

    constructor(provider: AnchorProvider, intermediaryUrl: string, wbtcToken?: PublicKey) {
        const swapContract = new SolanaClientSwapContract(provider, wbtcToken || Bitcoin.wbtcToken);
        const chainEvents = new SolanaChainEvents(provider, swapContract);

        this.soltobtcln = new SoltoBTCLNWrapper(new LocalWrapperStorage("solSwaps-SoltoBTCLN"), swapContract, chainEvents);
        this.soltobtc = new SoltoBTCWrapper(new LocalWrapperStorage("solSwaps-SoltoBTC"), swapContract, chainEvents);
        this.btclntosol = new BTCLNtoSolWrapper(new LocalWrapperStorage("solSwaps-BTCLNtoSol"), swapContract, chainEvents);
        this.btctosol = new BTCtoSolNewWrapper(new LocalWrapperStorage("solSwaps-BTCtoSol"), swapContract, chainEvents);

        this.intermediaryUrl = intermediaryUrl;
    }

    /**
     * Returns maximum possible swap amount
     *
     * @param kind      Type of the swap
     */
    static getMaximum(kind: SwapType): BN {
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
    static getMinimum(kind: SwapType): BN {
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
    createSolToBTCSwap(address: string, amount: BN, confirmationTarget?: number, confirmations?: number): Promise<SoltoBTCSwap<SolanaSwapData>> {
        return this.soltobtc.create(address, amount, confirmationTarget || 3, confirmations || 3, this.intermediaryUrl+"/tobtc");
    }

    /**
     * Creates Solana -> BTCLN swap
     *
     * @param paymentRequest        BOLT11 lightning network invoice to be paid (needs to have a fixed amount)
     * @param expirySeconds         For how long to lock your funds (higher expiry means higher probability of payment success)
     */
    createSolToBTCLNSwap(paymentRequest: string, expirySeconds?: number): Promise<SoltoBTCLNSwap<SolanaSwapData>> {
        return this.soltobtcln.create(paymentRequest, expirySeconds || (3*24*3600), this.intermediaryUrl+"/tobtcln");
    }

    /**
     * Creates BTC -> Solana swap
     *
     * @param amount        Amount to receive, in satoshis (bitcoin's smallest denomination)
     */
    createBTCtoSolSwap(amount: BN): Promise<BTCtoSolNewSwap<SolanaSwapData>> {
        return this.btctosol.create(amount, this.intermediaryUrl+"/frombtc");
    }

    /**
     * Creates BTCLN -> Solana swap
     *
     * @param amount            Amount to receive, in satoshis (bitcoin's smallest denomination)
     * @param invoiceExpiry     Lightning invoice expiry time (in seconds)
     */
    createBTCLNtoSolSwap(amount: BN, invoiceExpiry?: number): Promise<BTCLNtoSolSwap<SolanaSwapData>> {
        return this.btclntosol.create(amount, invoiceExpiry || (1*24*3600), this.intermediaryUrl+"/frombtcln");
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