import IBTCxtoSolSwap, {BTCxtoSolSwapState} from "../IBTCxtoSolSwap";
import {PublicKey, SystemProgram, Transaction, TransactionSignature} from "@solana/web3.js";
import {AnchorProvider, BN} from "@project-serum/anchor";
import BTCLNtoSol, {AtomicSwapStruct} from "../btclntosol/BTCLNtoSol";
import BTCtoSolWrapper from "../btctosol/BTCtoSolWrapper";
import * as EventEmitter from "events";
import SwapType from "../SwapType";
import * as bitcoin from "bitcoinjs-lib";
import {createHash} from "crypto-browserify";
import {ConstantBTCtoSol} from "../../Constants";
import ChainUtils from "../../ChainUtils";
import BTCtoSolNewWrapper from "./BTCtoSolNewWrapper";

export enum BTCtoSolNewSwapState {
    FAILED = -1,
    PR_CREATED = 0,
    CLAIM_COMMITED = 1,
    BTC_TX_CONFIRMED = 2,
    CLAIM_CLAIMED = 3
}

export default class BTCtoSolNewSwap implements IBTCxtoSolSwap {

    state: BTCtoSolNewSwapState;

    txId: string;
    vout: number;

    readonly fromAddress: PublicKey;
    readonly url: string;

    //State: PR_CREATED
    readonly address: string;
    readonly amount: BN;

    //State: PR_PAID
    intermediary: PublicKey;
    data: AtomicSwapStruct;
    prefix: string;
    timeout: string;
    signature: string;
    nonce: number;

    private wrapper: BTCtoSolNewWrapper;

    /**
     * Swap's event emitter
     *
     * @event BTCtoSolSwap#swapState
     * @type {BTCtoSolSwap}
     */
    readonly events: EventEmitter;

    constructor(
        wrapper: BTCtoSolNewWrapper,
        address: string,
        amount: BN,
        url: string,
        fromAddress: PublicKey,
        intermediary: PublicKey,
        data: AtomicSwapStruct,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
    );
    constructor(wrapper: BTCtoSolNewWrapper, obj: any);

    constructor(
        wrapper: BTCtoSolNewWrapper,
        addressOrObject: string | any,
        amount?: BN,
        url?: string,
        fromAddress?: PublicKey,
        intermediary?: PublicKey,
        data?: AtomicSwapStruct,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
    ) {
        this.wrapper = wrapper;
        this.events = new EventEmitter();
        if(typeof(addressOrObject)==="string") {
            this.state = BTCtoSolNewSwapState.PR_CREATED;

            this.fromAddress = fromAddress;
            this.url = url;

            this.address = addressOrObject;
            this.amount = amount;

            this.intermediary = intermediary;
            this.data = data;
            this.prefix = prefix;
            this.timeout = timeout;
            this.signature = signature;
            this.nonce = nonce;
        } else {
            this.state = addressOrObject.state;

            this.url = addressOrObject.url;
            this.fromAddress = new PublicKey(addressOrObject.fromAddress);

            this.address = addressOrObject.address;

            this.amount = new BN(addressOrObject.amount);
            this.txId = addressOrObject.txId;
            this.vout = addressOrObject.vout;

            this.intermediary = addressOrObject.intermediary!=null ? new PublicKey(addressOrObject.intermediary) : null;
            this.data = addressOrObject.data !=null ? {
                intermediary: new PublicKey(addressOrObject.data.intermediary),
                token: new PublicKey(addressOrObject.data.token),
                amount: new BN(addressOrObject.data.amount),
                paymentHash: addressOrObject.data.paymentHash,
                expiry: new BN(addressOrObject.data.expiry),
                kind: addressOrObject.data.kind,
                confirmations: addressOrObject.data.confirmations
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
    getOutAmount(): BN {
        return this.data.amount;
    }

    /**
     * Returns amount that will be sent on Bitcoin on-chain
     */
    getInAmount(): BN {
        return new BN(this.amount);
    }

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN {
        return this.amount.sub(this.getOutAmount());
    }

    serialize(): any{
        return {
            state: this.state,
            url: this.url,
            fromAddress: this.fromAddress,
            address: this.address,

            amount: this.amount.toString(),
            txId: this.txId,
            vout: this.vout,

            intermediary: this.intermediary!=null ? this.intermediary.toBase58() : null,
            data: this.data!=null ? {
                intermediary: this.data.intermediary.toBase58(),
                token: this.data.token.toBase58(),
                amount: this.data.amount.toString(),
                paymentHash: this.data.paymentHash,
                expiry: this.data.expiry.toString(),
                kind: this.data.kind,
                confirmations: this.data.confirmations
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
     * @param updateCallback        Callback called when txId is found, and also called with subsequent confirmations
     */
    async waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number, updateCallback?: (txId: string, confirmations: number, targetConfirmations: number) => void): Promise<void> {
        if(this.state!==BTCtoSolNewSwapState.CLAIM_COMMITED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        const result = await ChainUtils.waitForAddressTxo(this.address, this.getTxoHash(), this.data.confirmations, (confirmations: number, txId: string, vout: number) => {
            if(updateCallback!=null) {
                updateCallback(txId, confirmations, this.data.confirmations);
            }
        }, abortSignal, checkIntervalSeconds);

        if(abortSignal.aborted) throw new Error("Aborted");

        this.txId = result.tx.txid;
        this.vout = result.vout;
        this.state = BTCtoSolNewSwapState.BTC_TX_CONFIRMED;

        await this.save();

        this.emitEvent();
    }

    /**
     * Returns if the swap can be committed
     */
    canCommit(): boolean {
        if(this.state!==BTCtoSolNewSwapState.PR_CREATED) {
            return false;
        }
        const expiry = BTCLNtoSol.getOnchainSendTimeout(this.data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(ConstantBTCtoSol.minSendWindow))) {
            return false;
        }
        return true;
    }

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an PTLC
     * Important: Make sure this transaction is confirmed and only after it is display the address to user
     *
     * @param signer                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    async commit(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature> {
        if(this.state!==BTCtoSolNewSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        //Check that we have enough time to send the TX and for it to confirm
        const expiry = BTCLNtoSol.getOnchainSendTimeout(this.data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(ConstantBTCtoSol.minSendWindow))) {
            throw new Error("Send window too low");
        }

        try {
            await this.wrapper.contract.isValidAuthorization(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            throw new Error("Request timed out!")
        }

        const tx = await this.wrapper.contract.createPayWithAuthorizationTx(this.intermediary, this.data, this.timeout, this.prefix, this.signature, this.nonce, this.getTxoHash());

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

        this.state = BTCtoSolNewSwapState.CLAIM_COMMITED;

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
                if(swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
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
        return this.state===BTCtoSolNewSwapState.BTC_TX_CONFIRMED;
    }

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param signer                    Signer to use to send the claim transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async claim(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature> {
        if(this.state!==BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
            throw new Error("Must be in BTC_TX_CONFIRMED state!");
        }

        const claimTxs = await this.wrapper.contract.createClaimTxs(this.intermediary, this.data, this.txId, this.vout);

        const {blockhash} = await signer.connection.getRecentBlockhash();
        for(let tx of claimTxs) {
            tx.recentBlockhash = blockhash;
            tx.feePayer = signer.wallet.publicKey;
        }
        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.
        const signedTxs = await signer.wallet.signAllTransactions(claimTxs);

        //TODO: Any of these transactions may fail, due to other relayers syncing the blockchain themselves, or watchtowers claiming the swap for us,
        // however this doesn't mean that the claim request actually failed, should take it into account

        const lastTx = signedTxs.pop();

        for(let tx of signedTxs) {
            const txResult = await signer.connection.sendRawTransaction(tx.serialize());
            console.log("Send tx: ", tx);
            await signer.connection.confirmTransaction(txResult, "confirmed");
            console.log("Tx confirmed: ", txResult);
        }

        const txResult = await signer.connection.sendRawTransaction(lastTx.serialize());
        console.log("Send final tx: ", lastTx);
        console.log("Send final tx sig: ", txResult);

        if(!noWaitForConfirmation) {
            await this.waitTillClaimed(abortSignal);
            return txResult;
        }

        /*if(!noWaitForConfirmation) {
            const receipt = await txResult.wait(1);

            if(!receipt.status) throw new Error("Transaction execution failed");

            return receipt;
        }*/

        this.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;

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
                if(swap.state===BTCxtoSolSwapState.CLAIM_CLAIMED) {
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

    getPaymentHash(): Buffer {
        return Buffer.from(this.data.paymentHash, "hex");
    }

    getTxoHash(): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(this.address, ConstantBTCtoSol.network);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
    }

    getWrapper(): BTCtoSolNewWrapper {
        return this.wrapper;
    }

    getAddress(): string {
        return this.state===BTCtoSolNewSwapState.PR_CREATED ? null : this.address;
    }

    getQrData(): string {
        return this.state===BTCtoSolNewSwapState.PR_CREATED ? null : "bitcoin:"+this.address+"?amount="+encodeURIComponent((this.amount.toNumber()/100000000).toString(10));
    }

    getType(): SwapType {
        return SwapType.BTC_TO_SOL;
    }

    getTimeoutTime(): number {
        return BTCLNtoSol.getOnchainSendTimeout(this.data).toNumber()*1000;
    }

}