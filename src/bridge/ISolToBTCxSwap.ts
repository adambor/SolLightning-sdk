import {AnchorProvider, BN} from "@project-serum/anchor";
import {TransactionSignature} from "@solana/web3.js";
import ISolToBTCxWrapper from "./ISolToBTCxWrapper";
import {EventEmitter} from "events";
import ISwap from "./ISwap";

interface ISolToBTCxSwap extends ISwap {

    /**
     * Returns amount that will be sent on Solana
     */
    getInAmount(): BN;

    /**
     * Returns amount that will be sent to recipient on Bitcoin LN
     */
    getOutAmount(): BN;

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN;

    /**
     * Returns if the swap can be committed/started
     */
    canCommit(): boolean;

    /**
     * Commits the swap on-chain, locking the tokens in an HTLC
     *
     * @param signer                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    commit(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature>;

    /**
     * Returns a promise that resolves when swap is committed
     *
     * @param abortSignal   AbortSignal
     */
    waitTillCommited(abortSignal?: AbortSignal): Promise<void>;

    /**
     * A blocking promise resolving when swap was concluded by the intermediary
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     *
     * @returns {Promise<boolean>}  Was the payment successful? If not we can refund.
     */
    waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number): Promise<boolean>;

    /**
     * Returns whether a swap can be already refunded
     */
    canRefund(): boolean;

    /**
     * Attempts a refund of the swap back to the initiator
     *
     * @param signer                    Signer to use to send the refund transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation
     * @param abortSignal               Abort signal
     */
    refund(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature>;

    /**
     * Returns a promise that resolves when swap is refunded
     *
     * @param abortSignal   AbortSignal
     */
    waitTillRefunded(abortSignal?: AbortSignal): Promise<void> ;

    /**
     * @fires BTCLNtoSolWrapper#swapState
     * @fires BTCLNtoSolSwap#swapState
     */
    emitEvent(): void;

    serialize(): any;
    save(): Promise<void>;

    getAddress(): string;

    getPaymentHash(): Buffer;
    getWrapper(): ISolToBTCxWrapper;

    /**
     * Returns transaction ID or payment secret of the swap
     */
    getTxId(): string;

    events: EventEmitter;

}

export default ISolToBTCxSwap;