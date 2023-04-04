import IBTCxtoSolWrapper from "../IBTCxtoSolWrapper";
import IWrapperStorage from "../../../storage/IWrapperStorage";
import BTCtoSolNewSwap, {BTCtoSolNewSwapState} from "./BTCtoSolNewSwap";
import ChainUtils from "../../../../ChainUtils";
import ClientSwapContract from "../../ClientSwapContract";
import ChainEvents from "../../../events/ChainEvents";
import SwapData from "../../SwapData";
import SwapCommitStatus from "../../SwapCommitStatus";
import SwapEvent from "../../../events/types/SwapEvent";
import InitializeEvent from "../../../events/types/InitializeEvent";
import ClaimEvent from "../../../events/types/ClaimEvent";
import RefundEvent from "../../../events/types/RefundEvent";
import * as BN from "bn.js";

class BTCtoSolNewWrapper<T extends SwapData> extends IBTCxtoSolWrapper<T> {

    /**
     * @param storage           Storage interface for the current environment
     * @param contract          Underlying contract handling the swaps
     * @param chainEvents       On-chain event emitter
     */
    constructor(storage: IWrapperStorage, contract: ClientSwapContract<T>, chainEvents: ChainEvents<T>) {
        super(storage, contract, chainEvents);
    }

    /**
     * Returns a newly created swap, receiving 'amount' on chain
     *
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param url               Intermediary/Counterparty swap service url
     */
    async create(amount: BN, url: string): Promise<BTCtoSolNewSwap<T>> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.receiveOnchain(amount, url);

        const swap = new BTCtoSolNewSwap(this, result.address, amount, url, result.data, result.prefix, result.timeout, result.signature, result.nonce);

        await swap.save();
        this.swapData[result.data.getHash()] = swap;

        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {

        if(this.isInitialized) return;

        let eventQueue: SwapEvent<T>[] = [];
        this.swapData = await this.storage.loadSwapData<BTCtoSolNewSwap<T>>(this, BTCtoSolNewSwap);

        const processEvent = async (events: SwapEvent<T>[]) => {

            for(let event of events) {
                const paymentHash = event.paymentHash;
                console.log("Event payment hash: ", paymentHash);
                const swap: BTCtoSolNewSwap<T> = this.swapData[paymentHash] as BTCtoSolNewSwap<T>;

                console.log("Swap found: ", swap);
                if(swap==null) continue;

                let swapChanged = false;

                if(event instanceof InitializeEvent) {
                    if(swap.state===BTCtoSolNewSwapState.PR_CREATED) {
                        swap.state = BTCtoSolNewSwapState.CLAIM_COMMITED;
                        swap.data = event.swapData;
                        swapChanged = true;
                    }
                }
                if(event instanceof ClaimEvent) {
                    if(swap.state===BTCtoSolNewSwapState.PR_CREATED || swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED || swap.state===BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
                        swap.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;
                        swapChanged = true;
                    }
                }
                if(event instanceof RefundEvent) {
                    if(swap.state===BTCtoSolNewSwapState.PR_CREATED || swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED || swap.state===BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
                        swap.state = BTCtoSolNewSwapState.FAILED;
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
            const swap = this.swapData[paymentHash] as BTCtoSolNewSwap<T>;

            if(swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED || swap.state===BTCtoSolNewSwapState.BTC_TX_CONFIRMED) {
                //Check if it's already successfully paid
                const commitStatus = await this.contract.getCommitStatus(swap.data);
                if(commitStatus===SwapCommitStatus.PAID) {
                    swap.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;
                    changedSwaps[paymentHash] = swap;
                    continue;
                }
                if(commitStatus===SwapCommitStatus.NOT_COMMITED || commitStatus===SwapCommitStatus.EXPIRED) {
                    swap.state = BTCtoSolNewSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                    continue;
                }
                if(commitStatus===SwapCommitStatus.COMMITED) {
                    //Check if payment already arrived
                    const tx = await ChainUtils.checkAddressTxos(swap.address, swap.getTxoHash());
                    if(tx!=null && tx.tx.status.confirmed) {
                        const tipHeight = await ChainUtils.getTipBlockHeight();
                        const confirmations = tipHeight-tx.tx.status.block_height+1;
                        if(confirmations>=swap.data.getConfirmations()) {
                            swap.txId = tx.tx.txid;
                            swap.vout = tx.vout;
                            swap.state = BTCtoSolNewSwapState.BTC_TX_CONFIRMED;
                            changedSwaps[paymentHash] = swap;
                        }
                    }
                }
            }
        }

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
    async getClaimableSwaps(): Promise<BTCtoSolNewSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap: BTCtoSolNewSwap<T> = this.swapData[paymentHash] as BTCtoSolNewSwap<T>;

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.getAddress()) {
                continue;
            }

            if(swap.state===BTCtoSolNewSwapState.PR_CREATED && swap.txId==null) {
                continue;
            }

            if(swap.state===BTCtoSolNewSwapState.CLAIM_CLAIMED || swap.state===BTCtoSolNewSwapState.FAILED) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<BTCtoSolNewSwap<T>[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(swap.data.getClaimer()!==this.contract.getAddress()) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

}

export default BTCtoSolNewWrapper;