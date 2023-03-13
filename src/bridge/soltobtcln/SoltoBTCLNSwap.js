import { PublicKey } from "@solana/web3.js";
import * as EventEmitter from "events";
import { BN } from "@project-serum/anchor";
import * as bolt11 from "bolt11";
import SoltoBTCLN from "./SoltoBTCLN";
import { SoltoBTCLNSwapState } from "./SoltoBTCLNWrapper";
import SwapType from "../SwapType";
export class SoltoBTCLNSwap {
    constructor(wrapper, prOrObject, data, url, fromAddress, confidence) {
        this.wrapper = wrapper;
        this.events = new EventEmitter();
        if (typeof (prOrObject) === "string") {
            this.state = SoltoBTCLNSwapState.CREATED;
            this.fromAddress = fromAddress;
            this.url = url;
            this.confidence = parseFloat(confidence);
            this.pr = prOrObject;
            this.data = data;
        }
        else {
            this.state = prOrObject.state;
            this.url = prOrObject.url;
            this.fromAddress = new PublicKey(prOrObject.fromAddress);
            this.confidence = prOrObject.confidence;
            this.pr = prOrObject.pr;
            this.secret = prOrObject.secret;
            this.data = prOrObject.data != null ? {
                intermediary: new PublicKey(prOrObject.data.intermediary),
                token: new PublicKey(prOrObject.data.token),
                amount: new BN(prOrObject.data.amount),
                paymentHash: prOrObject.data.paymentHash,
                expiry: new BN(prOrObject.data.expiry)
            } : null;
        }
    }
    /**
     * Returns amount that will be sent on Solana
     */
    getInAmount() {
        return this.data.amount;
    }
    /**
     * Returns amount that will be sent to recipient on Bitcoin LN
     */
    getOutAmount() {
        const parsedPR = bolt11.decode(this.pr);
        return new BN(parsedPR.satoshis);
    }
    /**
     * Returns calculated fee for the swap
     */
    getFee() {
        return this.getInAmount().sub(this.getOutAmount());
    }
    /**
     * Returns if the swap can be committed/started
     */
    canCommit() {
        return this.state === SoltoBTCLNSwapState.CREATED;
    }
    /**
     * Commits the swap on-chain, locking the tokens in an HTLC
     *
     * @param signer                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async commit(signer, noWaitForConfirmation, abortSignal) {
        if (this.state !== SoltoBTCLNSwapState.CREATED) {
            throw new Error("Must be in CREATED state!");
        }
        const tx = await this.wrapper.contract.createPayTx(this.fromAddress, this.data);
        const { blockhash } = await signer.connection.getRecentBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.wallet.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await signer.wallet.signTransaction(tx);
        const txResult = await signer.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: true
        });
        if (!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }
        return txResult;
    }
    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    waitTillCommited(abortSignal) {
        return new Promise((resolve, reject) => {
            if (abortSignal != null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            let listener;
            listener = (swap) => {
                if (swap.state === SoltoBTCLNSwapState.COMMITED) {
                    this.events.removeListener("swapState", listener);
                    if (abortSignal != null)
                        abortSignal.onabort = null;
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            if (abortSignal != null)
                abortSignal.onabort = () => {
                    this.events.removeListener("swapState", listener);
                    reject("Aborted");
                };
        });
    }
    /**
     * A blocking promise resolving when swap was concluded by the intermediary
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     *
     * @returns {Promise<boolean>}  Was the payment successful? If not we can refund.
     */
    async waitForPayment(abortSignal, checkIntervalSeconds) {
        const result = await this.wrapper.contract.waitForRefundAuthorization(this.fromAddress, this.data, this.url, abortSignal, checkIntervalSeconds);
        if (abortSignal.aborted)
            throw new Error("Aborted");
        if (!result.is_paid) {
            this.state = SoltoBTCLNSwapState.REFUNDABLE;
            await this.save();
            this.emitEvent();
            return false;
        }
        else {
            this.secret = result.secret;
            await this.save();
            return true;
        }
    }
    /**
     * Returns whether a swap can be already refunded
     */
    canRefund() {
        return this.state === SoltoBTCLNSwapState.REFUNDABLE || SoltoBTCLN.isExpired(this.data);
    }
    /**
     * Attempts a refund of the swap back to the initiator
     *
     * @param signer                    Signer to use to send the refund transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async refund(signer, noWaitForConfirmation, abortSignal) {
        if (this.state !== SoltoBTCLNSwapState.REFUNDABLE && !SoltoBTCLN.isExpired(this.data)) {
            throw new Error("Must be in REFUNDABLE state!");
        }
        let tx;
        if (SoltoBTCLN.isExpired(this.data)) {
            tx = await this.wrapper.contract.createRefundTx(this.fromAddress, this.data);
        }
        else {
            const res = await this.wrapper.contract.getRefundAuthorization(this.fromAddress, this.data, this.url);
            if (res.is_paid) {
                throw new Error("Payment was successful");
            }
            tx = await this.wrapper.contract.createRefundTxWithAuthorizationTx(this.fromAddress, this.data, res.timeout, res.prefix, res.signature);
        }
        const { blockhash } = await signer.connection.getRecentBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.wallet.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await signer.wallet.signTransaction(tx);
        const txResult = await signer.connection.sendRawTransaction(signedTx.serialize());
        if (!noWaitForConfirmation) {
            await this.waitTillRefunded(abortSignal);
            return txResult;
        }
        return txResult;
    }
    /**
     * Returns a promise that resolves when swap is refunded
     *
     * @param abortSignal   AbortSignal
     */
    waitTillRefunded(abortSignal) {
        return new Promise((resolve, reject) => {
            if (abortSignal != null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            let listener;
            listener = (swap) => {
                if (swap.state === SoltoBTCLNSwapState.REFUNDED) {
                    this.events.removeListener("swapState", listener);
                    if (abortSignal != null)
                        abortSignal.onabort = null;
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            if (abortSignal != null)
                abortSignal.onabort = () => {
                    this.events.removeListener("swapState", listener);
                    reject("Aborted");
                };
        });
    }
    /**
     * @fires BTCLNtoSolWrapper#swapState
     * @fires BTCLNtoSolSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }
    serialize() {
        return {
            state: this.state,
            url: this.url,
            fromAddress: this.fromAddress.toBase58(),
            pr: this.pr,
            confidence: this.confidence,
            secret: this.secret,
            data: this.data != null ? {
                intermediary: this.data.intermediary.toBase58(),
                token: this.data.token.toBase58(),
                amount: this.data.amount.toString(10),
                paymentHash: this.data.paymentHash,
                expiry: this.data.expiry.toString(10)
            } : null,
        };
    }
    save() {
        return this.wrapper.storage.saveSwapData(this);
    }
    /**
     * Returns wrapper used to create this swap
     */
    getWrapper() {
        return this.wrapper;
    }
    getTxId() {
        return this.secret;
    }
    /**
     * Returns the confidence of the intermediary that this payment will succeed
     * Value between 0 and 1, where 0 is not likely and 1 is very likely
     */
    getConfidence() {
        return this.confidence;
    }
    getPaymentHash() {
        const parsed = bolt11.decode(this.pr);
        return Buffer.from(parsed.tagsObject.payment_hash, "hex");
    }
    getAddress() {
        return this.pr;
    }
    getType() {
        return SwapType.SOL_TO_BTCLN;
    }
}
