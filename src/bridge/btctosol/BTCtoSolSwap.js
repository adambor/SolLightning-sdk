import { PublicKey } from "@solana/web3.js";
import { BN } from "@project-serum/anchor";
import * as EventEmitter from "events";
import { BTCtoSolSwapState } from "./BTCtoSolWrapper";
import { createHash } from "crypto-browserify";
import SwapType from "../SwapType";
export default class BTCtoSolSwap {
    constructor(wrapper, addressOrObject, secret, url, fromAddress, amount, expectedFee, privateKey, intermediaryBtcPublicKey, csvDelta) {
        this.wrapper = wrapper;
        this.events = new EventEmitter();
        if (typeof (addressOrObject) === "string") {
            this.state = BTCtoSolSwapState.PR_CREATED;
            this.fromAddress = fromAddress;
            this.url = url;
            this.address = addressOrObject;
            this.secret = secret;
            this.amount = amount;
            this.expectedFee = expectedFee;
            this.privateKey = privateKey;
            this.intermediaryBtcPublicKey = intermediaryBtcPublicKey;
            this.csvDelta = csvDelta;
        }
        else {
            this.state = addressOrObject.state;
            this.url = addressOrObject.url;
            this.fromAddress = new PublicKey(addressOrObject.fromAddress);
            this.address = addressOrObject.address;
            this.secret = Buffer.from(addressOrObject.secret, "hex");
            this.amount = new BN(addressOrObject.amount);
            this.expectedFee = new BN(addressOrObject.expectedFee);
            this.privateKey = Buffer.from(addressOrObject.privateKey, "hex");
            this.intermediaryBtcPublicKey = addressOrObject.intermediaryBtcPublicKey;
            this.csvDelta = addressOrObject.csvDelta;
            this.intermediary = addressOrObject.intermediary != null ? new PublicKey(addressOrObject.intermediary) : null;
            this.data = addressOrObject.data != null ? {
                intermediary: new PublicKey(addressOrObject.data.intermediary),
                token: new PublicKey(addressOrObject.data.token),
                amount: new BN(addressOrObject.data.amount),
                paymentHash: addressOrObject.data.paymentHash,
                expiry: new BN(addressOrObject.data.expiry)
            } : null;
            this.prefix = addressOrObject.prefix;
            this.timeout = addressOrObject.timeout;
            this.signature = addressOrObject.signature;
            this.nonce = addressOrObject.nonce;
        }
    }
    /**
     * Returns amount that will be received on Solana
     */
    getOutAmount() {
        if (this.data != null)
            return this.data.amount;
        return this.amount.sub(this.expectedFee);
    }
    /**
     * Returns amount that will be sent on Bitcoin on-chain
     */
    getInAmount() {
        return new BN(this.amount);
    }
    /**
     * Returns calculated fee for the swap
     */
    getFee() {
        return this.amount.sub(this.getOutAmount());
    }
    serialize() {
        return {
            state: this.state,
            url: this.url,
            fromAddress: this.fromAddress,
            address: this.address,
            secret: this.secret != null ? this.secret.toString("hex") : null,
            amount: this.amount.toString(),
            expectedFee: this.expectedFee.toString(),
            privateKey: this.privateKey.toString("hex"),
            intermediaryBtcPublicKey: this.intermediaryBtcPublicKey,
            csvDelta: this.csvDelta,
            intermediary: this.intermediary != null ? this.intermediary.toBase58() : null,
            data: this.data != null ? {
                intermediary: this.data.intermediary.toBase58(),
                token: this.data.token.toBase58(),
                amount: this.data.amount.toString(),
                paymentHash: this.data.paymentHash,
                expiry: this.data.expiry.toString()
            } : null,
            prefix: this.prefix,
            timeout: this.timeout,
            signature: this.signature,
            nonce: this.nonce
        };
    }
    save() {
        return this.wrapper.storage.saveSwapData(this);
    }
    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     * @param updateCallback        Callback called when txId is found, and also called with subsequent confirmations
     */
    async waitForPayment(abortSignal, checkIntervalSeconds, updateCallback) {
        if (this.state !== BTCtoSolSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }
        const result = await this.wrapper.contract.waitForIncomingPaymentAuthorization(this.getPaymentHash(), null, this.url, this.fromAddress, abortSignal, checkIntervalSeconds, (confirmations, targetConfirmations, txId, vout, amount, swapFee, networkFee) => {
            if (updateCallback != null) {
                const totalFee = swapFee.add(networkFee);
                updateCallback(txId, confirmations, targetConfirmations, amount, totalFee, amount.sub(totalFee));
            }
        });
        if (abortSignal.aborted)
            throw new Error("Aborted");
        this.state = BTCtoSolSwapState.PR_PAID;
        this.intermediary = result.intermediary;
        this.data = result.data;
        this.prefix = result.prefix;
        this.timeout = result.timeout;
        this.signature = result.signature;
        this.nonce = result.nonce;
        await this.save();
        this.emitEvent();
    }
    /**
     * Returns if the swap can be committed
     */
    canCommit() {
        return this.state === BTCtoSolSwapState.PR_PAID;
    }
    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     * Important: Make sure this transaction is confirmed and only after it is call claim()
     *
     * @param signer                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async commit(signer, noWaitForConfirmation, abortSignal) {
        if (this.state !== BTCtoSolSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }
        try {
            await this.wrapper.contract.isValidAuthorization(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);
        }
        catch (e) {
            const result = await this.wrapper.contract.getPaymentAuthorization(this.getPaymentHash(), this.data.amount, this.url, this.fromAddress);
            this.intermediary = result.intermediary;
            this.data = result.data;
            this.prefix = result.prefix;
            this.timeout = result.timeout;
            this.signature = result.signature;
            this.nonce = result.nonce;
        }
        const tx = await this.wrapper.contract.createPayWithAuthorizationTx(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);
        const { blockhash } = await signer.connection.getRecentBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.wallet.publicKey;
        const signedTx = await signer.wallet.signTransaction(tx);
        const txResult = await signer.connection.sendRawTransaction(signedTx.serialize());
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        if (!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }
        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/
        this.state = BTCtoSolSwapState.CLAIM_COMMITED;
        await this.save();
        this.emitEvent();
        return txResult;
    }
    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillCommited(abortSignal) {
        return new Promise((resolve, reject) => {
            if (abortSignal != null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            let listener;
            listener = (swap) => {
                if (swap.state === BTCtoSolSwapState.CLAIM_COMMITED) {
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
     * Returns if the swap can be claimed
     */
    canClaim() {
        return this.state === BTCtoSolSwapState.CLAIM_COMMITED;
    }
    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param signer                    Signer to use to send the claim transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async claim(signer, noWaitForConfirmation, abortSignal) {
        if (this.state !== BTCtoSolSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in CLAIM_COMMITED state!");
        }
        const tx = await this.wrapper.contract.createClaimTx(this.intermediary, this.data, this.secret);
        const { blockhash } = await signer.connection.getRecentBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.wallet.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await signer.wallet.signTransaction(tx);
        const txResult = await signer.connection.sendRawTransaction(signedTx.serialize());
        if (!noWaitForConfirmation) {
            await this.waitTillClaimed(abortSignal);
            return txResult;
        }
        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/
        this.state = BTCtoSolSwapState.CLAIM_CLAIMED;
        await this.save();
        this.emitEvent();
        return txResult;
    }
    /**
     * Returns a promise that resolves when swap is claimed
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillClaimed(abortSignal) {
        return new Promise((resolve, reject) => {
            if (abortSignal != null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            let listener;
            listener = (swap) => {
                if (swap.state === BTCtoSolSwapState.CLAIM_CLAIMED) {
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
     * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
     * If swap is already commited, it just signs and executes the claim transaction
     *
     * @param signer            Signer to use to send the claim transaction
     * @param abortSignal       Abort signal
     */
    async commitAndClaim(signer, abortSignal) {
        if (this.state !== BTCtoSolSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }
        if (this.state === BTCtoSolSwapState.CLAIM_COMMITED) {
            return [
                null,
                await this.claim(signer, false, abortSignal)
            ];
        }
        try {
            await this.wrapper.contract.isValidAuthorization(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);
        }
        catch (e) {
            const result = await this.wrapper.contract.getPaymentAuthorization(this.getPaymentHash(), this.data.amount, this.url, this.fromAddress);
            this.intermediary = result.intermediary;
            this.data = result.data;
            this.prefix = result.prefix;
            this.timeout = result.timeout;
            this.signature = result.signature;
            this.nonce = result.nonce;
        }
        const txCommit = await this.wrapper.contract.createPayWithAuthorizationTx(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);
        const txClaim = await this.wrapper.contract.createClaimTx(this.intermediary, this.data, this.secret);
        const { blockhash } = await signer.connection.getRecentBlockhash();
        txCommit.recentBlockhash = blockhash;
        txCommit.feePayer = signer.wallet.publicKey;
        txClaim.recentBlockhash = blockhash;
        txClaim.feePayer = signer.wallet.publicKey;
        const [signedTxClaim, signedTxCommit] = await signer.wallet.signAllTransactions([txClaim, txCommit]);
        console.log("Signed both transactions: ", [signedTxCommit, signedTxClaim]);
        const txResultCommit = await signer.connection.sendRawTransaction(signedTxCommit.serialize());
        console.log("Sent commit transaction: ", txResultCommit);
        await this.waitTillCommited(abortSignal);
        console.log("Commit tx confirmed!");
        const txResultClaim = await signer.connection.sendRawTransaction(signedTxClaim.serialize());
        console.log("Sent claim transaction: ", txResultClaim);
        await this.waitTillClaimed(abortSignal);
        console.log("Claim tx confirmed!");
        return [txResultCommit, txResultClaim];
    }
    /**
     * Returns current state of the swap
     */
    getState() {
        return this.state;
    }
    /**
     * @fires BTCtoSolWrapper#swapState
     * @fires BTCtoSolSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }
    getPaymentHash() {
        return createHash("sha256").update(this.secret).digest();
    }
    getWrapper() {
        return this.wrapper;
    }
    getAddress() {
        return this.address;
    }
    getQrData() {
        return "bitcoin:" + this.address + "?amount=" + encodeURIComponent((this.amount.toNumber() / 100000000).toString(10));
    }
    getType() {
        return SwapType.BTC_TO_SOL;
    }
}
