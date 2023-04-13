import IBTCxtoSolSwap, {BTCxtoSolSwapState} from "../IBTCxtoSolSwap";
import SwapType from "../../SwapType";
import * as bitcoin from "bitcoinjs-lib";
import {createHash, randomBytes} from "crypto-browserify";
import {ConstantBTCtoSol} from "../../../../Constants";
import ChainUtils from "../../../../ChainUtils";
import BTCtoSolNewWrapper from "./BTCtoSolNewWrapper";
import SwapData from "../../SwapData";
import * as BN from "bn.js";
import ClientSwapContract from "../../ClientSwapContract";

export enum BTCtoSolNewSwapState {
    FAILED = -1,
    PR_CREATED = 0,
    CLAIM_COMMITED = 1,
    BTC_TX_CONFIRMED = 2,
    CLAIM_CLAIMED = 3
}

export default class BTCtoSolNewSwap<T extends SwapData> extends IBTCxtoSolSwap<T> {

    state: BTCtoSolNewSwapState;

    txId: string;
    vout: number;

    readonly secret: string;

    //State: PR_CREATED
    readonly address: string;
    readonly amount: BN;

    constructor(
        wrapper: BTCtoSolNewWrapper<T>,
        address: string,
        amount: BN,
        url: string,
        data: T,
        swapFee: BN,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number,
    );
    constructor(wrapper: BTCtoSolNewWrapper<T>, obj: any);

    constructor(
        wrapper: BTCtoSolNewWrapper<T>,
        addressOrObject: string | any,
        amount?: BN,
        url?: string,
        data?: T,
        swapFee?: BN,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number,
    ) {
        if(typeof(addressOrObject)==="string") {
            super(wrapper, url, data, swapFee, prefix, timeout, signature, nonce);
            this.state = BTCtoSolNewSwapState.PR_CREATED;

            this.address = addressOrObject;
            this.amount = amount;

            this.secret = randomBytes(32).toString("hex");
        } else {
            super(wrapper, addressOrObject);
            this.state = addressOrObject.state;

            this.address = addressOrObject.address;
            this.amount = new BN(addressOrObject.amount);

            this.txId = addressOrObject.txId;
            this.vout = addressOrObject.vout;
            this.secret = addressOrObject.secret;
        }
    }

    /**
     * Returns amount that will be received on Solana
     */
    getOutAmount(): BN {
        return this.data.getAmount();
    }

    /**
     * Returns amount that will be sent on Bitcoin on-chain
     */
    getInAmount(): BN {
        return new BN(this.amount);
    }

    serialize(): any {
        const partiallySerialized = super.serialize();

        partiallySerialized.state = this.state;
        partiallySerialized.address = this.address;
        partiallySerialized.amount = this.amount.toString(10);
        partiallySerialized.txId = this.txId;
        partiallySerialized.vout = this.vout;
        partiallySerialized.secret = this.secret;

        return partiallySerialized;
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

        const result = await ChainUtils.waitForAddressTxo(this.address, this.getTxoHash(), this.data.getConfirmations(), (confirmations: number, txId: string, vout: number) => {
            if(updateCallback!=null) {
                updateCallback(txId, confirmations, this.data.getConfirmations());
            }
        }, abortSignal, checkIntervalSeconds);

        if(abortSignal==null && abortSignal.aborted) throw new Error("Aborted");

        this.txId = result.tx.txid;
        this.vout = result.vout;
        if(this.state<BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
            this.state = BTCtoSolNewSwapState.BTC_TX_CONFIRMED;
        }

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
        const expiry = ClientSwapContract.getOnchainSendTimeout(this.data);
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
    async commit(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==BTCtoSolNewSwapState.PR_CREATED) {
            throw new Error("Must be in PR_CREATED state!");
        }

        //Check that we have enough time to send the TX and for it to confirm
        const expiry = ClientSwapContract.getOnchainSendTimeout(this.data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(ConstantBTCtoSol.minSendWindow))) {
            throw new Error("Send window too low");
        }

        try {
            await this.wrapper.contract.isValidInitAuthorization(this.data, this.timeout, this.prefix, this.signature, this.nonce);
        } catch (e) {
            throw new Error("Request timed out!")
        }

        const txResult = await this.wrapper.contract.init(this.data, this.timeout, this.prefix, this.signature, this.nonce, this.getTxoHash());

        //Maybe don't wait for TX but instead subscribe to logs, this would improve the experience when user speeds up the transaction by replacing it.

        if(!noWaitForConfirmation) {
            await this.waitTillCommited(abortSignal);
            return txResult;
        }

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
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    async claim(noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<string> {
        if(this.state!==BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
            throw new Error("Must be in BTC_TX_CONFIRMED state!");
        }

        const txResult = await this.wrapper.contract.claimWithTxData(this.data, this.txId, this.vout, this.secret);

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
        return Buffer.from(this.data.getHash(), "hex");
    }

    getTxoHash(): Buffer {
        const parsedOutputScript = bitcoin.address.toOutputScript(this.address, ConstantBTCtoSol.network);

        return createHash("sha256").update(Buffer.concat([
            Buffer.from(this.amount.toArray("le", 8)),
            parsedOutputScript
        ])).digest();
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
        return ClientSwapContract.getOnchainSendTimeout(this.data).toNumber()*1000;
    }

}