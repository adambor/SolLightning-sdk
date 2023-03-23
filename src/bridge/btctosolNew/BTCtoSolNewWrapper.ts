import BTCtoSol, {BTCLNtoEVMCommitStatus, PaymentAuthError} from "../btclntosol/BTCLNtoSol";

import * as EventEmitter from "events";
import {AnchorProvider, BN} from "@project-serum/anchor";
import IBTCxtoSolWrapper from "../IBTCxtoSolWrapper";
import IWrapperStorage from "../IWrapperStorage";
import {PublicKey} from "@solana/web3.js";
import {BTCxtoSolSwapState} from "../IBTCxtoSolSwap";
import BtcRelay from "../btcrelay/BtcRelay";
import BTCtoSolNewSwap, {BTCtoSolNewSwapState} from "./BTCtoSolNewSwap";
import ChainUtils from "../../ChainUtils";

class BTCtoSolNewWrapper implements IBTCxtoSolWrapper {

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

    private swapData: {[paymentHash: string]: BTCtoSolNewSwap};

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
    async create(amount: BN, url: string): Promise<BTCtoSolNewSwap> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const result = await this.contract.createOnchainPaymentRequestRelay(this.provider.publicKey, amount, url);

        const swap = new BTCtoSolNewSwap(this, result.address, amount, url, this.provider.publicKey, result.intermediary, result.data, result.prefix, result.timeout, result.signature, result.nonce);

        await swap.save();
        this.swapData[result.data.paymentHash] = swap;

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
        this.swapData = await this.storage.loadSwapData<BTCtoSolNewSwap>(this, BTCtoSolNewSwap);

        const processEvent = (event: any, slotNumber: number, signature: string) => {
            console.log("EVENT: ", event);
            const paymentHash = Buffer.from(event.data.hash).toString("hex");
            const swap = this.swapData[paymentHash];

            console.log("Swap found: ", swap);

            if(swap==null) return;

            let swapChanged = false;
            if(event.name==="InitializeEvent") {
                if(swap.state===BTCtoSolNewSwapState.PR_CREATED) {
                    swap.state = BTCtoSolNewSwapState.CLAIM_COMMITED;
                    swapChanged = true;
                }
            }
            if(event.name==="ClaimEvent") {
                if(swap.state===BTCtoSolNewSwapState.PR_CREATED || swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED) {
                    swap.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;
                    swapChanged = true;
                }
            }
            if(event.name==="RefundEvent") {
                if(swap.state===BTCtoSolNewSwapState.PR_CREATED || swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED) {
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

            if(swap.state===BTCtoSolNewSwapState.CLAIM_COMMITED) {
                //Check if it's already successfully paid
                const commitStatus = await this.contract.getCommitStatus(swap.intermediary, swap.data);
                if(commitStatus===BTCLNtoEVMCommitStatus.PAID) {
                    swap.state = BTCtoSolNewSwapState.CLAIM_CLAIMED;
                    changedSwaps[paymentHash] = swap;
                    continue;
                }
                if(commitStatus===BTCLNtoEVMCommitStatus.NOT_COMMITTED || commitStatus===BTCLNtoEVMCommitStatus.EXPIRED) {
                    swap.state = BTCtoSolNewSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                    continue;
                }
                if(commitStatus===BTCLNtoEVMCommitStatus.COMMITTED) {
                    //Check if payment already arrived
                    const tx = await ChainUtils.checkAddressTxos(swap.address, swap.getTxoHash());
                    if(tx.tx.status.confirmed) {
                        const tipHeight = await ChainUtils.getTipBlockHeight();
                        const confirmations = tipHeight-tx.tx.status.block_height+1;
                        if(confirmations>=swap.data.confirmations) {
                            swap.txId = tx.tx.txid;
                            swap.vout = tx.vout;
                            swap.state = BTCtoSolNewSwapState.BTC_TX_CONFIRMED;
                            changedSwaps[paymentHash] = swap;
                        }
                    }
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
    async getClaimableSwaps(): Promise<BTCtoSolNewSwap[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(!swap.fromAddress.equals(this.provider.wallet.publicKey)) {
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
    async getAllSwaps(): Promise<BTCtoSolNewSwap[]> {

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

export default BTCtoSolNewWrapper;