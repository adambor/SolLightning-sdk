import {PublicKey, TransactionSignature} from "@solana/web3.js";
import {AnchorProvider, BN} from "@project-serum/anchor";
import {AtomicSwapStruct} from "./BTCLNtoSol";
import * as EventEmitter from "events";
import * as bolt11 from "bolt11";
import BTCLNtoSolWrapper, {BTCLNtoSolSwapState} from "./BTCLNtoSolWrapper";
import IBTCxtoSolSwap from "../IBTCxtoSolSwap";
import SwapType from "../SwapType";

export default class BTCLNtoSolSwap implements IBTCxtoSolSwap {

    state: number;

    readonly fromAddress: PublicKey;
    readonly url: string;

    //State: PR_CREATED
    readonly pr: string;
    readonly secret: Buffer;
    readonly minOut: BN;

    //State: PR_PAID
    intermediary: PublicKey;
    data: AtomicSwapStruct;
    prefix: string;
    timeout: string;
    signature: string;
    nonce: number;

    private wrapper: BTCLNtoSolWrapper;

    /**
     * Swap's event emitter
     *
     * @event BTCLNtoSolSwap#swapState
     * @type {BTCLNtoSolSwap}
     */
    readonly events: EventEmitter;

    constructor(wrapper: BTCLNtoSolWrapper, pr: string, secret: Buffer, url: string, fromAddress: PublicKey, minOut: BN);
    constructor(wrapper: BTCLNtoSolWrapper, obj: any);

    constructor(wrapper: BTCLNtoSolWrapper, prOrObject: string | any, secret?: Buffer, url?: string, fromAddress?: PublicKey, minOut?: BN) {
        this.wrapper = wrapper;
        this.events = new EventEmitter();
        if(typeof(prOrObject)==="string") {
            this.state = BTCLNtoSolSwapState.PR_CREATED;

            this.fromAddress = fromAddress;
            this.url = url;

            this.pr = prOrObject;
            this.secret = secret;
            this.minOut = minOut;
        } else {
            this.state = prOrObject.state;

            this.url = prOrObject.url;
            this.fromAddress = new PublicKey(prOrObject.fromAddress);

            this.pr = prOrObject.pr;
            this.secret = Buffer.from(prOrObject.secret, "hex");
            this.minOut = new BN(prOrObject.minOut);

            this.intermediary = prOrObject.intermediary!=null ? new PublicKey(prOrObject.intermediary) : null;
            this.data = prOrObject.data !=null ? {
                intermediary: new PublicKey(prOrObject.data.intermediary),
                token: new PublicKey(prOrObject.data.token),
                amount: new BN(prOrObject.data.amount),
                paymentHash: prOrObject.data.paymentHash,
                expiry: new BN(prOrObject.data.expiry)
            } : null;
            this.prefix = prOrObject.prefix;
            this.timeout = prOrObject.timeout;
            this.signature = prOrObject.signature;
            this.nonce = prOrObject.nonce;
        }
    }

    /**
     * Returns amount that will be received on Solana
     */
    getOutAmount(): BN {
        if(this.data!=null) return this.data.amount;
        return this.minOut;
    }

    /**
     * Returns amount that will be sent on Bitcoin LN
     */
    getInAmount(): BN {
        const parsed = bolt11.decode(this.pr);
        return new BN(parsed.satoshis);
    }

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN {
        return this.getInAmount().sub(this.getOutAmount());
    }

    serialize(): any{
        return {
            state: this.state,
            url: this.url,
            fromAddress: this.fromAddress.toBase58(),
            pr: this.pr,
            secret: this.secret!=null ? this.secret.toString("hex") : null,
            minOut: this.minOut!=null ? this.minOut.toString() : null,
            intermediary: this.intermediary!=null ? this.intermediary.toBase58() : null,
            data: this.data!=null ? {
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

    save(): Promise<void> {
        return this.wrapper.storage.saveSwapData(this);
    }

    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<void> {
        if(this.state!==BTCLNtoSolSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        const result = await this.wrapper.contract.waitForIncomingPaymentAuthorization(this.pr, this.minOut, this.url, this.fromAddress, abortSignal, checkIntervalSeconds);

        if(abortSignal.aborted) throw new Error("Aborted");

        this.state = BTCLNtoSolSwapState.PR_PAID;

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
    canCommit(): boolean {
        return this.state===BTCLNtoSolSwapState.PR_PAID;
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     * Important: Make sure this transaction is confirmed and only after it is call claim()
     *
     * @param signer                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async commit(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature> {
        if(this.state!==BTCLNtoSolSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        try {
            await this.wrapper.contract.isValidAuthorization(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            const result = await this.wrapper.contract.getPaymentAuthorization(this.pr, this.minOut, this.url, this.fromAddress);
            this.intermediary = result.intermediary;
            this.data = result.data;
            this.prefix = result.prefix;
            this.timeout = result.timeout;
            this.signature = result.signature;
            this.nonce = result.nonce;
        }

        const tx = await this.wrapper.contract.createPayWithAuthorizationTx(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);

        const {blockhash} = await signer.connection.getRecentBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.wallet.publicKey;
        const signedTx = await signer.wallet.signTransaction(tx);
        const txResult = await signer.connection.sendRawTransaction(signedTx.serialize());

        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.

        if(!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }

        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/

        this.state = BTCLNtoSolSwapState.CLAIM_COMMITED;

        await this.save();

        this.emitEvent();

        return txResult;
    }

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===BTCLNtoSolSwapState.CLAIM_COMMITED) {
                    this.events.removeListener("swapState", listener);
                    if(abortSignal!=null) abortSignal.onabort = null;
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            if(abortSignal!=null) abortSignal.onabort = () => {
                this.events.removeListener("swapState", listener);
                reject("Aborted");
            };
        });
    }

    /**
     * Returns if the swap can be claimed
     */
    canClaim(): boolean {
        return this.state===BTCLNtoSolSwapState.CLAIM_COMMITED;
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param signer                    Signer to use to send the claim transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async claim(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature> {
        if(this.state!==BTCLNtoSolSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in CLAIM_COMMITED state!");
        }

        const tx = await this.wrapper.contract.createClaimTx(this.intermediary, this.data, this.secret);

        const {blockhash} = await signer.connection.getRecentBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.wallet.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await signer.wallet.signTransaction(tx);
        const txResult = await signer.connection.sendRawTransaction(signedTx.serialize());

        if(!noWaitForConfirmation) {
            await this.waitTillClaimed(abortSignal);
            return txResult;
        }

        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/

        this.state = BTCLNtoSolSwapState.CLAIM_CLAIMED;

        await this.save();

        this.emitEvent();

        return txResult;
    }

    /**
     * Returns a promise that resolves when swap is claimed
     *
     * @param abortSignal   AbortSignal
     */
    async waitTillClaimed(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===BTCLNtoSolSwapState.CLAIM_CLAIMED) {
                    this.events.removeListener("swapState", listener);
                    if(abortSignal!=null) abortSignal.onabort = null;
                    resolve();
                }
            };
            this.events.on("swapState", listener);
            if(abortSignal!=null) abortSignal.onabort = () => {
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
    async commitAndClaim(signer: AnchorProvider, abortSignal?: AbortSignal): Promise<TransactionSignature[]> {

        if(this.state!==BTCLNtoSolSwapState.PR_PAID) {
            throw new Error("Must be in PR_PAID state!");
        }

        if(this.state===BTCLNtoSolSwapState.CLAIM_COMMITED) {
            return [
                null,
                await this.claim(signer, false, abortSignal)
            ];
        }

        try {
            await this.wrapper.contract.isValidAuthorization(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            const result = await this.wrapper.contract.getPaymentAuthorization(this.pr, this.minOut, this.url, this.fromAddress);
            this.intermediary = result.intermediary;
            this.data = result.data;
            this.prefix = result.prefix;
            this.timeout = result.timeout;
            this.signature = result.signature;
            this.nonce = result.nonce;
        }

        const txCommit = await this.wrapper.contract.createPayWithAuthorizationTx(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);
        const txClaim = await this.wrapper.contract.createClaimTx(this.intermediary, this.data, this.secret);

        const {blockhash} = await signer.connection.getRecentBlockhash();
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
     * @fires BTCLNtoSolWrapper#swapState
     * @fires BTCLNtoSolSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }

    getPaymentHash(): Buffer {
        const decodedPR = bolt11.decode(this.pr);
        return Buffer.from(decodedPR.tagsObject.payment_hash, "hex");
    }

    getWrapper(): BTCLNtoSolWrapper {
        return this.wrapper;
    }

    getAddress(): string {
        return this.pr;
    }

    getQrData(): string {
        return "lightning:"+this.pr.toUpperCase();
    }

    getType(): SwapType {
        return SwapType.BTCLN_TO_SOL;
    }

}