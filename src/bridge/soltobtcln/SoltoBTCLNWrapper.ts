import * as bolt11 from "bolt11";
import * as EventEmitter from "events";
import SoltoBTCLN, {PaymentRequestStatus} from "./SoltoBTCLN";
import BigNumber from "bignumber.js";
import {PublicKey, TransactionSignature} from "@solana/web3.js";
import {AnchorProvider, BN} from "@project-serum/anchor";
import SoltoBTCLNSwap from "./SoltoBTCLNSwap";
import {ConstantSoltoBTCLN} from "../../Constants";
import ISolToBTCxWrapper from "../ISolToBTCxWrapper";
import IWrapperStorage from "../IWrapperStorage";
import {SolToBTCxSwapState} from "../ISolToBTCxSwap";

class SoltoBTCLNWrapper implements ISolToBTCxWrapper {

    readonly storage: IWrapperStorage;
    readonly provider: AnchorProvider;
    readonly contract: SoltoBTCLN;

    /**
     * Event emitter for all the swaps
     *
     * @event BTCLNtoSolSwap#swapState
     * @type {BTCLNtoSolSwap}
     */
    readonly events: EventEmitter;

    private swapData: {[paymentHash: string]: SoltoBTCLNSwap};

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
        this.contract = new SoltoBTCLN(provider, wbtcToken);
        this.events = new EventEmitter();
    }

    /**
     * Returns the WBTC token balance of the wallet
     */
    getWBTCBalance(): Promise<BN> {
        return this.contract.getBalance(this.provider.wallet.publicKey);
    }

    private static calculateFeeForAmount(amount: BN) : BN {
        return ConstantSoltoBTCLN.baseFee.add(amount.mul(ConstantSoltoBTCLN.fee).div(new BN(1000000)));
    }

    /**
     * Returns a newly created swap, paying for 'bolt11PayRequest' - a bitcoin LN invoice
     *
     * @param bolt11PayRequest  BOLT11 payment request (bitcoin lightning invoice) you wish to pay
     * @param expirySeconds     Swap expiration in seconds, setting this too low might lead to unsuccessful payments, too high and you might lose access to your funds for longer than necessary
     * @param url               Intermediary/Counterparty swap service url
     */
    async create(bolt11PayRequest: string, expirySeconds: number, url: string): Promise<SoltoBTCLNSwap> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const parsedPR = bolt11.decode(bolt11PayRequest);

        if(parsedPR.satoshis==null) {
            throw new Error("Must be an invoice with amount!");
        }

        const sats = new BN(parsedPR.millisatoshis).div(new BN(1000));

        const fee = SoltoBTCLNWrapper.calculateFeeForAmount(sats);

        const result = await this.contract.payBOLT11PaymentRequest(bolt11PayRequest, expirySeconds, fee, url);

        const swap = new SoltoBTCLNSwap(this, bolt11PayRequest, result.data, url, this.provider.wallet.publicKey, result.confidence);

        await swap.save();
        this.swapData[result.data.paymentHash] = swap;

        return swap;

    }

    /**
     * Initializes the wrapper, be sure to call this before taking any other actions.
     * Checks if any swaps are already refundable
     */
    async init() {

        if(this.isInitialized) return;

        let eventQueue: {
            event: any,
            slotNumber: number,
            signature: string
        }[] = [];
        this.swapData = await this.storage.loadSwapData<SoltoBTCLNSwap>(this, SoltoBTCLNSwap);

        const processEvent = (event: any, slotNumber: number, signature: string) => {
            const paymentHash = Buffer.from(event.data.hash).toString("hex");
            console.log("Event payment hash: ", paymentHash);
            console.log("Swap data array: ", this.swapData);
            const swap = this.swapData[paymentHash];

            console.log("Swap found: ", swap);

            if(swap==null) return;

            let swapChanged = false;
            if(event.name==="InitializeEvent") {
                if(swap.state===SolToBTCxSwapState.CREATED) {
                    swap.state = SolToBTCxSwapState.COMMITED;
                    swapChanged = true;
                }
            }
            if(event.name==="ClaimEvent") {
                if(swap.state===SolToBTCxSwapState.CREATED || swap.state===SolToBTCxSwapState.COMMITED || swap.state===SolToBTCxSwapState.REFUNDABLE) {
                    swap.state = SolToBTCxSwapState.CLAIMED;
                    swapChanged = true;
                }
            }
            if(event.name==="RefundEvent") {
                if(swap.state===SolToBTCxSwapState.CREATED || swap.state===SolToBTCxSwapState.COMMITED || swap.state===SolToBTCxSwapState.REFUNDABLE) {
                    swap.state = SolToBTCxSwapState.REFUNDED;
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

            if(swap.state===SolToBTCxSwapState.CREATED) {
                //Check if it's already committed
                const res = await this.contract.getCommitStatus(swap.fromAddress, swap.data);
                if(res===PaymentRequestStatus.PAID) {
                    swap.state = SolToBTCxSwapState.CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===PaymentRequestStatus.EXPIRED) {
                    swap.state = SolToBTCxSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===PaymentRequestStatus.PAYING) {
                    swap.state = SolToBTCxSwapState.COMMITED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===PaymentRequestStatus.REFUNDABLE) {
                    swap.state = SolToBTCxSwapState.REFUNDABLE;
                    changedSwaps[paymentHash] = swap;
                }
            }

            if(swap.state===SolToBTCxSwapState.COMMITED) {
                const res = await this.contract.getCommitStatus(swap.fromAddress, swap.data);
                if(res===PaymentRequestStatus.PAYING) {
                    //Check if that maybe already concluded
                    const refundAuth = await this.contract.getRefundAuthorization(swap.fromAddress, swap.data, swap.url);
                    if(refundAuth!=null) {
                        if(!refundAuth.is_paid) {
                            swap.state = SolToBTCxSwapState.REFUNDABLE;
                            changedSwaps[paymentHash] = swap;
                        } else {
                            //TODO: Perform check on secret
                            swap.secret = refundAuth.secret;
                        }
                    }
                }
                if(res===PaymentRequestStatus.NOT_FOUND) {
                    swap.state = SolToBTCxSwapState.REFUNDED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===PaymentRequestStatus.PAID) {
                    swap.state = SolToBTCxSwapState.CLAIMED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===PaymentRequestStatus.EXPIRED) {
                    swap.state = SolToBTCxSwapState.FAILED;
                    changedSwaps[paymentHash] = swap;
                }
                if(res===PaymentRequestStatus.REFUNDABLE) {
                    swap.state = SolToBTCxSwapState.REFUNDABLE;
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
     * Returns swaps that are refundable and that were initiated with the current provider's public key
     */
    async getRefundableSwaps(): Promise<SoltoBTCLNSwap[]> {

        if(!this.isInitialized) throw new Error("Not initialized, call init() first!");

        const returnArr = [];

        for(let paymentHash in this.swapData) {
            const swap = this.swapData[paymentHash];

            console.log(swap);

            if(!swap.fromAddress.equals(this.provider.wallet.publicKey)) {
                continue;
            }

            if(swap.state===SolToBTCxSwapState.REFUNDABLE) {
                returnArr.push(swap);
            }
        }

        return returnArr;

    }

    /**
     * Returns all swaps that were initiated with the current provider's public key
     */
    async getAllSwaps(): Promise<SoltoBTCLNSwap[]> {

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

export default SoltoBTCLNWrapper;