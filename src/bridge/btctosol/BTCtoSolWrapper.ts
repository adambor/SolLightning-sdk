import BTCtoSol, {BTCLNtoEVMCommitStatus, PaymentAuthError} from "../btclntosol/BTCLNtoSol";

import * as EventEmitter from "events";
import {AnchorProvider, BN} from "@project-serum/anchor";
import BTCtoSolSwap from "./BTCtoSolSwap";
import IBTCxtoSolWrapper from "../IBTCxtoSolWrapper";
import IWrapperStorage from "../IWrapperStorage";
import {PublicKey} from "@solana/web3.js";
import {BTCxtoSolSwapState} from "../IBTCxtoSolSwap";

class BTCtoSolWrapper implements IBTCxtoSolWrapper {

    readonly storage: IWrapperStorage;
    readonly provider: AnchorProvider;
    readonly contract: BTCtoSol;

    /**
     * Event emitter for all the swaps
     *
     * @event BTCtoSolSwap#swapState
     * @type {BTCtoSolSwap}
     */
    readonly events: EventEmitter;

    private swapData: {[paymentHash: string]: BTCtoSolSwap};

    private isInitialized: boolean = false;

    private eventListeners: number[] = [];

    /**
     * @param storage   Storage interface for the current environment
     * @param provider  AnchorProvider used for RPC and signing
     * @param wbtcToken WBTC SPL token address
     */
    constructor(storage: IWrapperStorage, provider: AnchorProvider, wbtcToken: PublicKey) {
        this.storage = storage;
        this.provider = provider;
        this.contract = new BTCtoSol(provider, wbtcToken);
        this.events = new EventEmitter();
    }

    /**
     * Returns a newly created swap, receiving 'amount' on chain
     *
     * @param amount            Amount you wish to receive in base units (satoshis)
     * @param url               Intermediary/Counterparty swap service url
     */
    async create(amount: BN, url: string): Promise<BTCtoSolSwap> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.createOnchainPaymentRequest(this.provider.wallet.publicKey, amount, url);

        const swap = new BTCtoSolSwap(
            this,
            result.address,
            result.secret,
            url,
            this.provider.wallet.publicKey,
            amount,
            result.swapFee.add(result.networkFee),
            result.generatedPrivKey,
            result.intermediaryBtcPublicKey,
            result.csvDelta
        );

        await swap.save();
        this.swapData[result.hash.toString("hex")] = swap;

        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are in progress.
     */
    async init() {

        if(this.isInitialized) return;

        let eventQueue: {
            event: any,
            slotNumber: number,
            signature: string
        }[] = [];
        this.swapData = await this.storage.loadSwapData<BTCtoSolSwap>(this, BTCtoSolSwap);

        const processEvent = (event: any, slotNumber: number, signature: string) => {
            console.log("EVENT: ", event);
            const paymentHash = Buffer.from(event.data.hash).toString("hex");
            const swap = this.swapData[paymentHash];

            console.log("Swap found: ", swap);

            if(swap==null) return;

            let swapChanged = false;
            if(event.name==="InitializeEvent") {
                if(swap.state===BTCxtoSolSwapState.PR_PAID || swap.state===BTCxtoSolSwapState.PR_CREATED) {
                    swap.state = BTCxtoSolSwapState.CLAIM_COMMITED;
                    swapChanged = true;
                }
            }
            if(event.name==="ClaimEvent") {
                if(swap.state===BTCxtoSolSwapState.PR_PAID || swap.state===BTCxtoSolSwapState.PR_CREATED || swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                    swap.state = BTCxtoSolSwapState.CLAIM_CLAIMED;
                    swapChanged = true;
                }
            }
            if(event.name==="RefundEvent") {
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
        };

        const listener = (event: any, slotNumber: number, signature: string) => {
            console.log("EVENT: ", event);
            if(eventQueue!=null) {
                eventQueue.push({event, slotNumber, signature});
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

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];


            if(swap.state===BTCxtoSolSwapState.PR_CREATED) {
                //Check if it's maybe already paid
                try {
                    const res = await this.contract.getPaymentAuthorization(swap.getPaymentHash(), null, swap.url);
                    if(res.is_paid) {
                        swap.state = BTCxtoSolSwapState.PR_PAID;

                        swap.data = res.data;
                        swap.prefix = res.prefix;
                        swap.intermediary = res.intermediary;
                        swap.timeout = res.timeout;
                        swap.signature = res.signature;

                        changedSwaps[paymentHash] = swap;
                    } else if(res.txId!=null) {
                        swap.txId = res.txId;
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
                if(BTCtoSol.isExpired(swap.data)) {
                    //Already expired, we can remove it
                    swap.state = BTCxtoSolSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                } else if(await this.contract.isClaimable(swap.intermediary, swap.data)) {
                    //Already committed
                    swap.state = BTCxtoSolSwapState.CLAIM_COMMITED;
                    changedSwaps[paymentHash] = swap;
                }
            }

            if(swap.state===BTCxtoSolSwapState.CLAIM_COMMITED) {
                //Check if it's already successfully paid
                const commitStatus = await this.contract.getCommitStatus(swap.intermediary, swap.data);
                if(commitStatus===BTCLNtoEVMCommitStatus.PAID) {
                    swap.state = BTCxtoSolSwapState.CLAIM_CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if(commitStatus===BTCLNtoEVMCommitStatus.NOT_COMMITTED || commitStatus===BTCLNtoEVMCommitStatus.EXPIRED) {
                    swap.state = BTCxtoSolSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
            }
        }

        for(let {event, slotNumber, signature} of eventQueue) {
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
        for(let num of this.eventListeners) {
            await this.contract.program.removeEventListener(num);
        }
        this.eventListeners = [];
        this.isInitialized = false;
    }

    /**
     * Returns swaps that are in-progress and are claimable that were initiated with the current provider's public key
     */
    async getClaimableSwaps(): Promise<BTCtoSolSwap[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(!swap.fromAddress.equals(this.provider.wallet.publicKey)) {
                continue;
            }

            if(swap.state===BTCxtoSolSwapState.PR_CREATED && swap.txId==null) {
                continue;
            }

            if(swap.state===BTCxtoSolSwapState.CLAIM_CLAIMED || swap.state===BTCxtoSolSwapState.FAILED) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<BTCtoSolSwap[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(!swap.fromAddress.equals(this.provider.wallet.publicKey)) {
                continue;
            }

            returnArr.push(swap);
        }

        return returnArr;

    }

}

export default BTCtoSolWrapper;