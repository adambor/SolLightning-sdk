import {AnchorProvider, BN} from "@project-serum/anchor";
import {TransactionSignature} from "@solana/web3.js";
import ISolToBTCxWrapper from "./ISolToBTCxWrapper";
import {EventEmitter} from "events";
import IBTCxtoSolWrapper from "./IBTCxtoSolWrapper";
import ISwap from "./ISwap";


interface IBTCxtoSolSwap extends ISwap {

    /**
     * Returns amount that will be received on Solana
     */
    getOutAmount(): BN;

    /**
     * Returns amount that will be sent on Bitcoin on-chain
     */
    getInAmount(): BN;

    /**
     * Returns calculated fee for the swap
     */
    getFee(): BN;

    /**
     * A blocking promise resolving when payment was received by the intermediary and client can continue
     * rejecting in case of failure
     *
     * @param abortSignal           Abort signal
     * @param checkIntervalSeconds  How often to poll the intermediary for answer
     * @param updateCallback        Callback called when txId is found, and also called with subsequent confirmations
     */
    waitForPayment(abortSignal?: AbortSignal, checkIntervalSeconds?: number, updateCallback?: (txId: string, confirmations: number, targetConfirmations: number, amount: BN, totalFee: BN, received: BN) => void): Promise<void>;

    /**
     * Returns if the swap can be committed
     */
    canCommit(): boolean;

    /**
     * Commits the swap on-chain, locking the tokens from the intermediary in an HTLC
     * Important: Make sure this transaction is confirmed and only after it is call claim()
     *
     * @param signer                    Signer to use to send the commit transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
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
     * Returns if the swap can be claimed
     */
    canClaim(): boolean;

    /**
     * Claims and finishes the swap once it was successfully committed on-chain with commit()
     *
     * @param signer                    Signer to use to send the claim transaction
     * @param noWaitForConfirmation     Do not wait for transaction confirmation (careful! be sure that transaction confirms before calling claim())
     * @param abortSignal               Abort signal
     */
    claim(signer: AnchorProvider, noWaitForConfirmation?: boolean, abortSignal?: AbortSignal): Promise<TransactionSignature>;

    /**
     * Returns a promise that resolves when swap is claimed
     *
     * @param abortSignal   AbortSignal
     */
    waitTillClaimed(abortSignal?: AbortSignal): Promise<void>;

    /**
     * Signs both, commit and claim transaction at once using signAllTransactions methods, wait for commit to confirm TX and then sends claim TX
     * If swap is already commited, it just signs and executes the claim transaction
     *
     * @param signer            Signer to use to send the claim transaction
     * @param abortSignal       Abort signal
     */
    commitAndClaim(signer: AnchorProvider, abortSignal?: AbortSignal): Promise<TransactionSignature[]>;

    /**
     * Returns current state of the swap
     */
    getState(): BTCxtoSolSwapState;

    /**
     * @fires BTCtoSolWrapper#swapState
     * @fires BTCtoSolSwap#swapState
     */
    emitEvent(): void;

    /**
     * Get payment hash
     */
    getPaymentHash(): Buffer;

    /**
     * Returns a string that can be displayed as QR code representation of the address (with bitcoin: or lightning: prefix)
     */
    getQrData(): string;

    /**
     * Returns a bitcoin address/lightning network invoice of the swap.
     */
    getAddress(): string;

    getWrapper(): IBTCxtoSolWrapper;

}

export enum BTCxtoSolSwapState {
    FAILED = -1,
    PR_CREATED = 0,
    PR_PAID = 1,
    CLAIM_COMMITED = 2,
    CLAIM_CLAIMED = 3
}

export default IBTCxtoSolSwap;