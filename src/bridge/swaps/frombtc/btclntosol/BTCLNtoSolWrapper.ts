import BTCLNtoSolSwap from "./BTCLNtoSolSwap";
import IBTCxtoSolWrapper from "../IBTCxtoSolWrapper";
import IWrapperStorage from "../../../storage/IWrapperStorage";
import {BTCxtoSolSwapState} from "../IBTCxtoSolSwap";
import SwapData from "../../SwapData";
import ClientSwapContract, {PaymentAuthError} from "../../ClientSwapContract";
import ChainEvents from "../../../events/ChainEvents";
import ChainSwapType from "../../ChainSwapType";
import SwapEvent from "../../../events/types/SwapEvent";
import InitializeEvent from "../../../events/types/InitializeEvent";
import ClaimEvent from "../../../events/types/ClaimEvent";
import RefundEvent from "../../../events/types/RefundEvent";
import * as BN from "bn.js";
import * as bolt11 from "bolt11";
import SwapCommitStatus from "../../SwapCommitStatus";

class BTCLNtoSolWrapper<T extends SwapData> extends IBTCxtoSolWrapper<T> {

    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>) {
        super(storage, contract, chainEvents);
    }

    /**
     * Returns a newly created swap, receiving 'amount' on lightning network
     *
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param expirySeconds     Swap expiration in seconds, setting this too low might lead to unsuccessful payments, too high and you might lose access to your funds for longer than necessary
     * @param url               Intermediary/Counterparty swap service url
     */
    async create(amount: BN, expirySeconds: number, url: string): Promise<BTCLNtoSolSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.receiveLightning(amount, expirySeconds, url);

        const parsed = bolt11.decode(result.pr);

        const swapData: T = this.contract.createSwapData(ChainSwapType.HTLC, null, this.contract.getAddress(), null, null, parsed.tagsObject.payment_hash, null, null, null, null);

        const swap = new BTCLNtoSolSwap<T>(this, result.pr, result.secret, url, swapData, amount.sub(result.swapFee));

        await swap.save();
        this.swapData[swap.getPaymentHash().toString("hex")] = swap;

        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {

        if(this.isInitialized) return;

        let eventQueue: SwapEvent<T>[] = [];
        this.swapData = await this.storage.loadSwapData<BTCLNtoSolSwap<T>>(this, BTCLNtoSolSwap);

        console.log("Swap data loaded");

        const processEvent = async (events: SwapEvent<T>[]) => {

            for(let event of events) {
                const paymentHash = event.paymentHash;

                console.log("Event payment hash: ", paymentHash);

                const swap: BTCLNtoSolSwap<T> = this.swapData[paymentHash] as BTCLNtoSolSwap<T>;

                console.log("Swap found: ", swap);

                if(swap==null) continue;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===BTCxtoSolSwapState.PR_PAID || swap.state===BTCxtoSolSwapState.PR_CREATED) {
                        swap.state = BTCxtoSolSwapState.CLAIM_COMMITED;
                        swap.data = event.swapData;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===BTCxtoSolSwapState.PR_PAID || swap.state===BTCxtoSolSwapState.PR_CREATED || swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                        swap.state = BTCxtoSolSwapState.CLAIM_CLAIMED;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===BTCxtoSolSwapState.PR_PAID || swap.state===BTCxtoSolSwapState.PR_CREATED || swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                        swap.state = BTCxtoSolSwapState.FAILED;
                        swapChanged = true;
                    }
                }

                if(swapChanged) {
                    if(eventQueue==null) {
                        swap.save().then(() => {
                            swap.emitEvent();
                        });
                    }
                }
            }

            return true;

        };

        const listener = (events: SwapEvent<T>[]) => {
            console.log("EVENT: ", event);

            if(eventQueue!=null) {
                for(let event of events) {
                    eventQueue.push(event);
                }
                return Promise.resolve(true);
            }

            return processEvent(events);
        };

        this.chainEvents.registerListener(listener);

        const changedSwaps = {};

        for(let paymentHash in this.swapData) {
            const swap: BTCLNtoSolSwap<T> = this.swapData[paymentHash] as BTCLNtoSolSwap<T>;


            if(swap.state===BTCxtoSolSwapState.PR_CREATED) {
                //Check if it's maybe already paid
                try {
                    const res = await this.contract.getPaymentAuthorization(swap.pr, swap.minOut, swap.url);
                    if(res.is_paid) {
                        swap.state = BTCxtoSolSwapState.PR_PAID;

                        swap.data = res.data;
                        swap.prefix = res.prefix;
                        swap.timeout = res.timeout;
                        swap.signature = res.signature;

                        changedSwaps[paymentHash] = swap;
                    }
                } catch (e) {
                    console.error(e);
                    if(e instanceof PaymentAuthError) {
                        swap.state = BTCxtoSolSwapState.FAILED;
                        changedSwaps[paymentHash] = swap;
                    }
                }
            }

            if(swap.state===BTCxtoSolSwapState.PR_PAID) {
                //Check if it's already committed
                if(this.contract.isExpired(swap.data)) {
                    //Already expired, we can remove it
                    swap.state = BTCxtoSolSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                } else if(await this.contract.isClaimable(swap.data)) {
                    //Already committed
                    swap.state = BTCxtoSolSwapState.CLAIM_COMMITED;
                    changedSwaps[paymentHash] = swap;
                }
            }

            if(swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                //Check if it's already successfully paid
                const commitStatus = await this.contract.getCommitStatus(swap.data);
                if(commitStatus===SwapCommitStatus.PAID) {
                    swap.state = BTCxtoSolSwapState.CLAIM_CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED) {
                    swap.state = BTCxtoSolSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
            }
        }

        console.log("Swap data checked");

        for(let event of eventQueue) {
            await processEvent([event]);
        }

        eventQueue = null;

        await this.storage.saveSwapDataArr(Object.keys(changedSwaps).map(e => changedSwaps[e]));

        this.isInitialized = true;
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps(): Promise<BTCLNtoSolSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: BTCLNtoSolSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.getAddress()) {
                continue;
            }

            const castedSwap = swap as BTCLNtoSolSwap<T>;

            if(castedSwap.state===BTCxtoSolSwapState.PR_CREATED || castedSwap.state===BTCxtoSolSwapState.CLAIM_CLAIMED || castedSwap.state===BTCxtoSolSwapState.FAILED) {
                continue;
            }

            returnArr.push(castedSwap);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<BTCLNtoSolSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr: BTCLNtoSolSwap<T>[] = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.getAddress()) {
                continue;
            }

            returnArr.push(swap as BTCLNtoSolSwap<T>);
        }

        return returnArr;

    }

}

export default BTCLNtoSolWrapper;