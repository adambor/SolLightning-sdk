import {PublicKey, TransactionSignature} from "@solana/web3.js";
import * as EventEmitter from "events";
import SoltoBTC, {PaymentRequestStruct} from "../soltobtcln/SoltoBTCLN";
import {AnchorProvider, BN} from "@project-serum/anchor";
import * as bolt11 from "bolt11";
import SoltoBTCWrapper from "./SoltoBTCWrapper";
import {ConstantBTCLNtoSol, ConstantSoltoBTC} from "../../Constants";
import ISolToBTCxSwap, {SolToBTCxSwapState} from "../ISolToBTCxSwap";
import ChainUtils from "../../ChainUtils";
import SwapType from "../SwapType";

export default class SoltoBTCSwap implements ISolToBTCxSwap {

    state: SolToBTCxSwapState;

    readonly fromAddress: PublicKey;
    readonly url: string;

    //State: PR_CREATED
    readonly address: string;
    readonly amount: BN;
    readonly confirmationTarget: number;

    readonly networkFee: BN;
    readonly swapFee: BN;
    readonly totalFee: BN;

    //State: PR_PAID
    data: PaymentRequestStruct;

    prefix: string;
    timeout: string;
    signature: string;
    nonce: number;

    txId: string;

    readonly wrapper: SoltoBTCWrapper;

    /**
     * Swap's event emitter
     *
     * @event BTCLNtoSolSwap#swapState
     * @type {BTCLNtoSolSwap}
     */
    readonly events: EventEmitter;

    constructor(
        wrapper: SoltoBTCWrapper,
        address: string,
        amount: BN,
        confirmationTarget: number,
        networkFee: BN,
        swapFee: BN,
        totalFee: BN,
        data: PaymentRequestStruct,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
        url: string,
        fromAddress: PublicKey
    );
    constructor(wrapper: SoltoBTCWrapper, obj: any);

    constructor(
        wrapper: SoltoBTCWrapper,
        addressOrObject: string | any,
        amount?: BN,
        confirmationTarget?: number,
        networkFee?: BN,
        swapFee?: BN,
        totalFee?: BN,
        data?: PaymentRequestStruct,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
        url?: string,
        fromAddress?: PublicKey
    ) {
        this.wrapper = wrapper;
        this.events = new EventEmitter();
        if(typeof(addressOrObject)==="string") {
            this.state = SolToBTCxSwapState.CREATED;

            this.fromAddress = fromAddress;
            this.url = url;

            this.address = addressOrObject;
            this.amount = amount;
            this.confirmationTarget = confirmationTarget;
            this.networkFee = networkFee;
            this.swapFee = swapFee;
            this.totalFee = totalFee;

            this.prefix = prefix;
            this.timeout = timeout;
            this.signature = signature;
            this.nonce = nonce;

            this.data = data;
        } else {
            this.state = addressOrObject.state;

            this.url = addressOrObject.url;
            this.fromAddress = new PublicKey(addressOrObject.fromAddress);

            this.address = addressOrObject.address;
            this.amount = new BN(addressOrObject.amount);
            this.confirmationTarget = addressOrObject.confirmationTarget;
            this.networkFee = new BN(addressOrObject.networkFee);
            this.swapFee = new BN(addressOrObject.swapFee);
            this.totalFee = new BN(addressOrObject.totalFee);
            this.txId = addressOrObject.txId;
            this.data = addressOrObject.data !=null ? {
                intermediary: new PublicKey(addressOrObject.data.intermediary),
                token: new PublicKey(addressOrObject.data.token),
                amount: new BN(addressOrObject.data.amount),
                paymentHash: addressOrObject.data.paymentHash,
                expiry: new BN(addressOrObject.data.expiry),
                nonce: addressOrObject.data.nonce==null ? null : new BN(addressOrObject.data.nonce),
                kind: addressOrObject.data.kind,
                confirmations: addressOrObject.data.confirmations,
                payOut: addressOrObject.data.payOut,
            } : null;

            this.prefix = addressOrObject.prefix;
            this.timeout = addressOrObject.timeout;
            this.signature = addressOrObject.signature;
            this.nonce = addressOrObject.nonce;
        }
    }

    /**
     * Returns amount that will be sent on Solana
     */
    getInAmount(): BN {
        return this.data.amount;
    }

    /**
     * Returns amount that will be sent to recipient on Bitcoin LN
     */
    getOutAmount(): BN {
        return this.amount
    }

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN {
        return this.totalFee;
    }

    /**
     * Returns if the swap can be committed/started
     */
    canCommit(): boolean {
        return this.state===SolToBTCxSwapState.CREATED &&
            ((parseInt(this.timeout)-ConstantSoltoBTC.authorizationGracePeriod) > Date.now()/1000);
    }

    /**
     * Commits the swap on-chain, locking the tokens in an HTLC
     *
     * @param signer                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async commit(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature> {
        if(this.state!==SolToBTCxSwapState.CREATED) {
            throw new Error("Must be in CREATED state!");
        }

        try {
            await this.wrapper.contract.isValidInitAuthorization(this.data, this.prefix, this.timeout, this.signature, this.nonce);
        } catch (e) {
            console.error(e);
            throw new Error("Expired, please retry");
        }

        const tx = await this.wrapper.contract.createPayTx(this.fromAddress, this.data, this.prefix, this.timeout, this.signature, this.nonce);

        const {blockhash, lastValidBlockHeight} = await signer.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.wallet.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await signer.wallet.signTransaction(tx);
        const txResult = await signer.connection.sendRawTransaction(signedTx.serialize(), {
            skipPreflight: true
        });

        if(!noWaitForConfirmation) {
            await signer.connection.confirmTransaction({
                signature: txResult,
                blockhash: blockhash,
                lastValidBlockHeight,
                abortSignal
            }, "confirmed");

            this.state = SolToBTCxSwapState.COMMITED;
            await this.save();
            this.emitEvent();

            return txResult;
        }

        return txResult;
    }

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    waitTillCommited(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===SolToBTCxSwapState.COMMITED) {
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
     * A blocking promise resolving when swap was concluded by the intermediary
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     *
     * @returns {Promise<boolean>}  Was the payment successful? If not we can refund.
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<boolean> {
        const result = await this.wrapper.contract.waitForRefundAuthorization(this.fromAddress, this.data, this.url, abortSignal, checkIntervalSeconds);

        if(abortSignal.aborted) throw new Error("Aborted");

        if(!result.is_paid) {
            this.state = SolToBTCxSwapState.REFUNDABLE;

            await this.save();

            this.emitEvent();
            return false;
        } else {
            this.txId = result.txId;
            await this.save();

            return true;
        }
    }

    /**
     * Returns whether a swap can be already refunded
     */
    canRefund(): boolean {
        return this.state===SolToBTCxSwapState.REFUNDABLE || SoltoBTC.isExpired(this.data);
    }

    /**
     * Attempts a refund of the swap back to the initiator
     *
     * @param signer                    Signer to use to send the refund transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async refund(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature> {
        if(this.state!==SolToBTCxSwapState.REFUNDABLE && !SoltoBTC.isExpired(this.data)) {
            throw new Error("Must be in REFUNDABLE state!");
        }

        let tx;
        if(SoltoBTC.isExpired(this.data)) {
            tx = await this.wrapper.contract.createRefundTx(this.fromAddress, this.data);
        } else {
            const res = await this.wrapper.contract.getRefundAuthorization(this.fromAddress, this.data, this.url);
            if(res.is_paid) {
                throw new Error("Payment was successful");
            }
            tx = await this.wrapper.contract.createRefundTxWithAuthorizationTx(this.fromAddress, this.data, res.timeout, res.prefix, res.signature);
        }

        const {blockhash} = await signer.connection.getRecentBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = signer.wallet.publicKey;
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTx = await signer.wallet.signTransaction(tx);
        const txResult = await signer.connection.sendRawTransaction(signedTx.serialize());

        if(!noWaitForConfirmation) {
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
    waitTillRefunded(abortSignal?: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject("Aborted");
                return;
            }
            let listener;
            listener = (swap) => {
                if(swap.state===SolToBTCxSwapState.REFUNDED) {
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
     * @fires BTCLNtoSolWrapper#swapState
     * @fires BTCLNtoSolSwap#swapState
     */
    emitEvent() {
        this.wrapper.events.emit("swapState", this);
        this.events.emit("swapState", this);
    }

    serialize(): any{
        return {
            state: this.state,
            url: this.url,
            fromAddress: this.fromAddress.toBase58(),
            address: this.address,
            amount: this.amount.toString(10),
            confirmationTarget: this.confirmationTarget,
            networkFee: this.networkFee.toString(10),
            swapFee: this.swapFee.toString(10),
            totalFee: this.totalFee.toString(10),
            txId: this.txId,
            data: this.data!=null ? {
                intermediary: this.data.intermediary.toBase58(),
                token: this.data.token.toBase58(),
                amount: this.data.amount.toString(10),
                paymentHash: this.data.paymentHash,
                expiry: this.data.expiry.toString(10),
                nonce: this.data.nonce==null ? null : this.data.nonce.toString(10),
                kind: this.data.kind,
                confirmations: this.data.confirmations,
                payOut: this.data.payOut,
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

    getTxId(): string {
        return this.txId;
    }

    /**
     * Returns wrapper used to create this swap
     */
    getWrapper(): SoltoBTCWrapper {
        return this.wrapper;
    }

    getPaymentHash(): Buffer {
        return Buffer.from(this.data.paymentHash, "hex");
    }

    getAddress(): string {
        return this.address;
    }

    getType(): SwapType {
        return SwapType.SOL_TO_BTC;
    }

    getState(): SolToBTCxSwapState {
        return this.state;
    }

}
