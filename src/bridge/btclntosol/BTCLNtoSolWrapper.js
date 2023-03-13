import { BTCLNtoEVMCommitStatus, PaymentAuthError } from "./BTCLNtoSol";
import BTCLNtoSol from "./BTCLNtoSol";
import * as bolt11 from "bolt11";
import * as EventEmitter from "events";
import BTCLNtoSolSwap from "./BTCLNtoSolSwap";
export const BTCLNtoSolSwapState = {
    FAILED: -1,
    PR_CREATED: 0,
    PR_PAID: 1,
    CLAIM_COMMITED: 2,
    CLAIM_CLAIMED: 3,
};
class BTCLNtoSolWrapper {
    /**
     * @param storage   Storage interface for the current environment
     * @param provider  AnchorProvider used for RPC and signing
     */
    constructor(storage, provider) {
        this.isInitialized = false;
        this.eventListeners = [];
        this.storage = storage;
        this.provider = provider;
        this.contract = new BTCLNtoSol(provider);
        this.events = new EventEmitter();
    }
    /**
     * Returns a newly created swap, receiving 'amount' on lightning network
     *
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param expirySeconds     Swap expiration in seconds, setting this too low might lead to unsuccessful payments, too high and you might lose access to your funds for longer than necessary
     * @param url               Intermediary/Counterparty swap service url
     */
    async create(amount, expirySeconds, url) {
        if (!this.isInitialized)
            throw new Error("Not initialized, call init() first!");
        const result = await this.contract.createBOLT11PaymentRequest(this.provider.wallet.publicKey, amount, expirySeconds, url);
        const parsed = bolt11.decode(result.pr);
        const swap = new BTCLNtoSolSwap(this, result.pr, result.secret, url, this.provider.wallet.publicKey, amount.sub(result.swapFee));
        await swap.save();
        this.swapData[parsed.tagsObject.payment_hash] = swap;
        return swap;
    }
    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {
        if (this.isInitialized)
            return;
        let eventQueue = [];
        this.swapData = await this.storage.loadSwapData(this);
        console.log("Swap data loaded");
        const processEvent = (event, slotNumber, signature) => {
            console.log("EVENT: ", event);
            const paymentHash = Buffer.from(event.data.hash).toString("hex");
            const swap = this.swapData[paymentHash];
            console.log("Swap found: ", swap);
            if (swap == null)
                return;
            let swapChanged = false;
            if (event.name === "InitializeEvent") {
                if (swap.state === BTCLNtoSolSwapState.PR_PAID || swap.state === BTCLNtoSolSwapState.PR_CREATED) {
                    swap.state = BTCLNtoSolSwapState.CLAIM_COMMITED;
                    swapChanged = true;
                }
            }
            if (event.name === "ClaimEvent") {
                if (swap.state === BTCLNtoSolSwapState.PR_PAID || swap.state === BTCLNtoSolSwapState.PR_CREATED || swap.state === BTCLNtoSolSwapState.CLAIM_COMMITED) {
                    swap.state = BTCLNtoSolSwapState.CLAIM_CLAIMED;
                    swapChanged = true;
                }
            }
            if (event.name === "RefundEvent") {
                if (swap.state === BTCLNtoSolSwapState.PR_PAID || swap.state === BTCLNtoSolSwapState.PR_CREATED || swap.state === BTCLNtoSolSwapState.CLAIM_COMMITED) {
                    swap.state = BTCLNtoSolSwapState.FAILED;
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
            if (swap.state === BTCLNtoSolSwapState.PR_CREATED) {
                //Check if it's maybe already paid
                try {
                    const res = await this.contract.getPaymentAuthorization(swap.pr, swap.minOut, swap.url);
                    if (res.is_paid) {
                        swap.state = BTCLNtoSolSwapState.PR_PAID;
                        swap.data = res.data;
                        swap.prefix = res.prefix;
                        swap.intermediary = res.intermediary;
                        swap.timeout = res.timeout;
                        swap.signature = res.signature;
                        changedSwaps[paymentHash] = swap;
                    }
                }
                catch (e) {
                    console.error(e);
                    if (e instanceof PaymentAuthError) {
                        swap.state = BTCLNtoSolSwapState.FAILED;
                        changedSwaps[paymentHash] = swap;
                    }
                }
            }
            if (swap.state === BTCLNtoSolSwapState.PR_PAID) {
                //Check if it's already committed
                if (BTCLNtoSol.isExpired(swap.data)) {
                    //Already expired, we can remove it
                    swap.state = BTCLNtoSolSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
                else if (await this.contract.isClaimable(swap.intermediary, swap.data)) {
                    //Already committed
                    swap.state = BTCLNtoSolSwapState.CLAIM_COMMITED;
                    changedSwaps[paymentHash] = swap;
                }
            }
            if (swap.state === BTCLNtoSolSwapState.CLAIM_COMMITED) {
                //Check if it's already successfully paid
                const commitStatus = await this.contract.getCommitStatus(swap.intermediary, swap.data);
                if (commitStatus === BTCLNtoEVMCommitStatus.PAID) {
                    swap.state = BTCLNtoSolSwapState.CLAIM_CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if (commitStatus === BTCLNtoEVMCommitStatus.NOT_COMMITTED || commitStatus === BTCLNtoEVMCommitStatus.EXPIRED) {
                    swap.state = BTCLNtoSolSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
            }
        }
        console.log("Swap data checked");
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
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps() {
        if (!this.isInitialized)
            throw new Error("Not initialized, call init() first!");
        const returnArr = [];
        for (let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];
            console.log(swap);
            if (!swap.fromAddress.equals(this.provider.wallet.publicKey)) {
                continue;
            }
            if (swap.state === BTCLNtoSolSwapState.PR_CREATED || swap.state === BTCLNtoSolSwapState.CLAIM_CLAIMED || swap.state === BTCLNtoSolSwapState.FAILED) {
                continue;
            }
            returnArr.push(swap);
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
export default BTCLNtoSolWrapper;
