import SoltoBTCLNWrapper from "./soltobtcln/SoltoBTCLNWrapper";
import SoltoBTCWrapper from "./soltobtc/SoltoBTCWrapper";
import BTCtoSolWrapper from "./btctosol/BTCtoSolWrapper";
import BTCLNtoSolWrapper from "./btclntosol/BTCLNtoSolWrapper";
import LocalWrapperStorage from "./LocalWrapperStorage";
import * as bitcoin from "bitcoinjs-lib";
import * as bolt11 from "bolt11";
;
export default class Swapper {
    static isValidBitcoinAddress(address) {
        try {
            bitcoin.address.toOutputScript(address);
            return true;
        }
        catch (e) {
            return false;
        }
    }
    static isValidLightningInvoice(lnpr) {
        try {
            const parsed = bolt11.decode(lnpr);
            if (parsed.satoshis != null)
                return true;
        }
        catch (e) { }
        return false;
    }
    constructor(provider, intermediaryUrl) {
        this.soltobtcln = new SoltoBTCLNWrapper(new LocalWrapperStorage("solSwaps-SoltoBTCLN"), provider);
        this.soltobtc = new SoltoBTCWrapper(new LocalWrapperStorage("solSwaps-SoltoBTC"), provider);
        this.btclntosol = new BTCLNtoSolWrapper(new LocalWrapperStorage("solSwaps-BTCLNtoSol"), provider);
        this.btctosol = new BTCtoSolWrapper(new LocalWrapperStorage("solSwaps-BTCtoSol"), provider);
        this.intermediaryUrl = intermediaryUrl;
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
    createSolToBTCSwap(address, amount) {
        return this.soltobtc.create(address, amount, 3, 3, this.intermediaryUrl + ":4003");
    }
    /**
     * Creates Solana -> BTCLN swap
     *
     * @param paymentRequest        BOLT11 lightning network invoice to be paid (needs to have a fixed amount)
     */
    createSolToBTCLNSwap(paymentRequest) {
        return this.soltobtcln.create(paymentRequest, 3 * 24 * 3600, this.intermediaryUrl + ":4001");
    }
    /**
     * Creates BTC -> Solana swap
     *
     * @param amount        Amount to receive, in satoshis (bitcoin's smallest denomination)
     */
    createBTCtoSolSwap(amount) {
        return this.btctosol.create(amount, this.intermediaryUrl + ":4002");
    }
    /**
     * Creates BTCLN -> Solana swap
     *
     * @param amount        Amount to receive, in satoshis (bitcoin's smallest denomination)
     */
    createBTCLNtoSolSwap(amount) {
        return this.btclntosol.create(amount, 1 * 24 * 3600, this.intermediaryUrl + ":4000");
    }
    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps() {
        return [].concat(await this.soltobtcln.getAllSwaps(), await this.soltobtc.getAllSwaps(), await this.btclntosol.getAllSwaps(), await this.btctosol.getAllSwaps());
    }
    /**
     * Returns swaps that were initiated with the current provider's public key, and there is an action required (either claim or refund)
     */
    async getActionableSwaps() {
        return [].concat(await this.soltobtcln.getRefundableSwaps(), await this.soltobtc.getRefundableSwaps(), await this.btclntosol.getClaimableSwaps(), await this.btctosol.getClaimableSwaps());
    }
    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    async getRefundableSwaps() {
        return [].concat(await this.soltobtcln.getRefundableSwaps(), await this.soltobtc.getRefundableSwaps());
    }
    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps() {
        return [].concat(await this.btclntosol.getClaimableSwaps(), await this.btctosol.getClaimableSwaps());
    }
}
