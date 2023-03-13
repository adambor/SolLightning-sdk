import SoltoBTCLNWrapper from "./soltobtcln/SoltoBTCLNWrapper";
import SoltoBTCWrapper from "./soltobtc/SoltoBTCWrapper";
import BTCtoSolWrapper from "./btctosol/BTCtoSolWrapper";
import BTCLNtoSolWrapper from "./btclntosol/BTCLNtoSolWrapper";
import LocalWrapperStorage from "./LocalWrapperStorage";
import {AnchorProvider, BN} from "@project-serum/anchor";
import ISwap from "./ISwap";
import ISolToBTCxSwap from "./ISolToBTCxSwap";
import IBTCxtoSolSwap from "./IBTCxtoSolSwap";
import SoltoBTCSwap from "./soltobtc/SoltoBTCSwap";
import SoltoBTCLNSwap from "./soltobtcln/SoltoBTCLNSwap";
import BTCtoSolSwap from "./btctosol/BTCtoSolSwap";
import BTCLNtoSolSwap from "./btclntosol/BTCLNtoSolSwap"
import * as bitcoin from "bitcoinjs-lib";
import * as bolt11 from "bolt11";
import SwapType from "./SwapType";
import {ConstantBTCLNtoSol, ConstantBTCtoSol, ConstantSoltoBTC, ConstantSoltoBTCLN} from "../Constants";

export default class Swapper {

    soltobtcln: SoltoBTCLNWrapper;
    soltobtc: SoltoBTCWrapper;
    btclntosol: BTCLNtoSolWrapper;
    btctosol: BTCtoSolWrapper;

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

    constructor(provider: AnchorProvider, intermediaryUrl: string) {
        this.soltobtcln = new SoltoBTCLNWrapper(new LocalWrapperStorage("solSwaps-SoltoBTCLN"), provider);
        this.soltobtc = new SoltoBTCWrapper(new LocalWrapperStorage("solSwaps-SoltoBTC"), provider);
        this.btclntosol = new BTCLNtoSolWrapper(new LocalWrapperStorage("solSwaps-BTCLNtoSol"), provider);
        this.btctosol = new BTCtoSolWrapper(new LocalWrapperStorage("solSwaps-BTCtoSol"), provider);

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
     * @param address       Recipient's bitcoin address
     * @param amount        Amount to send in satoshis (bitcoin's smallest denomination)
     */
    createSolToBTCSwap(address: string, amount: BN): Promise<SoltoBTCSwap> {
        return this.soltobtc.create(address, amount, 3, 3, this.intermediaryUrl+":4003");
    }

    /**
     * Creates Solana -> BTCLN swap
     *
     * @param paymentRequest        BOLT11 lightning network invoice to be paid (needs to have a fixed amount)
     */
    createSolToBTCLNSwap(paymentRequest: string): Promise<SoltoBTCLNSwap> {
        return this.soltobtcln.create(paymentRequest, 3*24*3600, this.intermediaryUrl+":4001");
    }

    /**
     * Creates BTC -> Solana swap
     *
     * @param amount        Amount to receive, in satoshis (bitcoin's smallest denomination)
     */
    createBTCtoSolSwap(amount: BN): Promise<BTCtoSolSwap> {
        return this.btctosol.create(amount, this.intermediaryUrl+":4002");
    }

    /**
     * Creates BTCLN -> Solana swap
     *
     * @param amount        Amount to receive, in satoshis (bitcoin's smallest denomination)
     */
    createBTCLNtoSolSwap(amount: BN): Promise<BTCLNtoSolSwap> {
        return this.btclntosol.create(amount, 1*24*3600, this.intermediaryUrl+":4000");
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
    async getRefundableSwaps(): Promise<ISolToBTCxSwap[]> {
        return [].concat(
            await this.soltobtcln.getRefundableSwaps(),
            await this.soltobtc.getRefundableSwaps()
        );
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps(): Promise<IBTCxtoSolSwap[]> {
        return [].concat(
            await this.btclntosol.getClaimableSwaps(),
            await this.btctosol.getClaimableSwaps()
        );
    }
}