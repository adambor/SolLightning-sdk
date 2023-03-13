import * as EventEmitter from "events";
import SoltoBTC, { PaymentRequestStatus } from "../soltobtcln/SoltoBTCLN";
import { SoltoBTCSwap } from "./SoltoBTCSwap";
export const SoltoBTCSwapState = {
    REFUNDED: -2,
    FAILED: -1,
    CREATED: 0,
    COMMITED: 1,
    CLAIMED: 2,
    REFUNDABLE: 3
};
class SoltoBTCWrapper {
    /**
     * @param storage   Storage interface for the current environment
     * @param provider  AnchorProvider used for RPC and signing
     */
    constructor(storage, provider) {
        this.isInitialized = false;
        this.eventListeners = [];
        this.storage = storage;
        this.provider = provider;
        this.contract = new SoltoBTC(provider);
        this.events = new EventEmitter();
    }
    /**
     * Returns the WBTC token balance of the wallet
     */
    getWBTCBalance() {
        return this.contract.getBalance(this.provider.wallet.publicKey);
    }
    /**
     * Returns a newly created swap, paying for 'bolt11PayRequest' - a bitcoin LN invoice
     *
     * @param address               Bitcoin on-chain address you wish to pay to
     * @param amount                Amount of bitcoin to send, in base units - satoshis
     * @param confirmationTarget    Time preference of the transaction (in how many blocks should it confirm)
     * @param confirmations         Confirmations required for intermediary to claim the funds from PTLC (this determines the safety of swap)
     * @param url                   Intermediary/Counterparty swap service url
     */
    async create(address, amount, confirmationTarget, confirmations, url) {
        if (!this.isInitialized)
            throw new Error("Not initialized, call init() first!");
        const result = await this.contract.payOnchain(address, amount, confirmationTarget, confirmations, url);
        const swap = new SoltoBTCSwap(this, address, amount, confirmationTarget, confirmations, result.nonce, result.networkFee, result.swapFee, result.totalFee, result.total, result.minRequiredExpiry, result.offerExpiry, result.data, url, this.provider.wallet.publicKey);
        await swap.save();
        this.swapData[result.data.paymentHash] = swap;
        return swap;
    }
    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    async init() {
        if (this.isInitialized)
            return;
        let eventQueue = [];
        this.swapData = await this.storage.loadSwapData(this);
        const processEvent = (event, slotNumber, signature) => {
            const paymentHash = Buffer.from(event.data.hash).toString("hex");
            const swap = this.swapData[paymentHash];
            console.log("Swap found: ", swap);
            if (swap == null)
                return;
            let swapChanged = false;
            if (event.name === "InitializeEvent") {
                if (swap.state === SoltoBTCSwapState.CREATED) {
                    swap.state = SoltoBTCSwapState.COMMITED;
                    swapChanged = true;
                }
            }
            if (event.name === "ClaimEvent") {
                if (swap.state === SoltoBTCSwapState.CREATED || swap.state === SoltoBTCSwapState.COMMITED || swap.state === SoltoBTCSwapState.REFUNDABLE) {
                    swap.state = SoltoBTCSwapState.CLAIMED;
                    swapChanged = true;
                }
            }
            if (event.name === "RefundEvent") {
                if (swap.state === SoltoBTCSwapState.CREATED || swap.state === SoltoBTCSwapState.COMMITED || swap.state === SoltoBTCSwapState.REFUNDABLE) {
                    swap.state = SoltoBTCSwapState.REFUNDED;
                    swapChanged = true;
                }
            }
            if (swapChanged) {
                if (eventQueue == null) {
                    swap.save().then(() => {
                        swap.emitEvent();
                    });
                }
            }
        };
        const listener = (event, slotNumber, signature) => {
            console.log("EVENT: ", event);
            if (eventQueue != null) {
                eventQueue.push({ event, slotNumber, signature });
                console.log("Event pushed to event queue");
                return;
            }
            processEvent(event, slotNumber, signature);
        };
        this.eventListeners.push(this.contract.program.addEventListener("InitializeEvent", (event, slotNumber, signature) => listener({
            name: "InitializeEvent",
            data: event
        }, slotNumber, signature)));
        this.eventListeners.push(this.contract.program.addEventListener("ClaimEvent", (event, slotNumber, signature) => listener({
            name: "ClaimEvent",
            data: event
        }, slotNumber, signature)));
        this.eventListeners.push(this.contract.program.addEventListener("RefundEvent", (event, slotNumber, signature) => listener({
            name: "RefundEvent",
            data: event
        }, slotNumber, signature)));
        const changedSwaps = {};
        for (let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];
            if (swap.state === SoltoBTCSwapState.CREATED) {
                //Check if it's already committed
                const res = await this.contract.getCommitStatus(swap.fromAddress, swap.data);
                if (res === PaymentRequestStatus.PAID) {
                    swap.state = SoltoBTCSwapState.CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if (res === PaymentRequestStatus.EXPIRED) {
                    swap.state = SoltoBTCSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
                if (res === PaymentRequestStatus.PAYING) {
                    swap.state = SoltoBTCSwapState.COMMITED;
                    changedSwaps[paymentHash] = swap;
                }
                if (res === PaymentRequestStatus.REFUNDABLE) {
                    swap.state = SoltoBTCSwapState.REFUNDABLE;
                    changedSwaps[paymentHash] = swap;
                }
            }
            if (swap.state === SoltoBTCSwapState.COMMITED) {
                const res = await this.contract.getCommitStatus(swap.fromAddress, swap.data);
                if (res === PaymentRequestStatus.PAYING) {
                    //Check if that maybe already concluded
                    const refundAuth = await this.contract.getRefundAuthorization(swap.fromAddress, swap.data, swap.url, swap.nonce);
                    if (refundAuth != null) {
                        if (!refundAuth.is_paid) {
                            swap.state = SoltoBTCSwapState.REFUNDABLE;
                            changedSwaps[paymentHash] = swap;
                        }
                        else {
                            //TODO: Perform check on txId
                            swap.txId = refundAuth.txId;
                        }
                    }
                }
                if (res === PaymentRequestStatus.NOT_FOUND) {
                    swap.state = SoltoBTCSwapState.REFUNDED;
                    changedSwaps[paymentHash] = swap;
                }
                if (res === PaymentRequestStatus.PAID) {
                    swap.state = SoltoBTCSwapState.CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if (res === PaymentRequestStatus.EXPIRED) {
                    swap.state = SoltoBTCSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
                if (res === PaymentRequestStatus.REFUNDABLE) {
                    swap.state = SoltoBTCSwapState.REFUNDABLE;
                    changedSwaps[paymentHash] = swap;
                }
            }
        }
        for (let { event, slotNumber, signature } of eventQueue) {
            processEvent(event, slotNumber, signature);
        }
        eventQueue = null;
        await this.storage.saveSwapDataArr(Object.keys(changedSwaps).map(e => changedSwaps[e]));
        this.isInitialized = true;
    }
    /**
     * Un-subscribes from event listeners on Solana
     */
    async stop() {
        this.swapData = null;
        for (let num of this.eventListeners) {
            await this.contract.program.removeEventListener(num);
        }
        this.eventListeners = [];
        this.isInitialized = false;
    }
    /**
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    async getRefundableSwaps() {
        if (!this.isInitialized)
            throw new Error("Not initialized, call init() first!");
        const returnArr = [];
        for (let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];
            console.log(swap);
            if (!swap.fromAddress.equals(this.provider.wallet.publicKey)) {
                continue;
            }
            if (swap.state === SoltoBTCSwapState.REFUNDABLE) {
                returnArr.push(swap);
            }
        }
        return returnArr;
    }
    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps() {
        if (!this.isInitialized)
            throw new Error("Not initialized, call init() first!");
        const returnArr = [];
        for (let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];
            console.log(swap);
            if (!swap.fromAddress.equals(this.provider.wallet.publicKey)) {
                continue;
            }
            returnArr.push(swap);
        }
        return returnArr;
    }
}
export default SoltoBTCWrapper;
