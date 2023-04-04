import ChainEvents, {EventListener} from "../../../events/ChainEvents";
import SolanaSwapData from "../swaps/SolanaSwapData";
import {AnchorProvider, BorshCoder} from "@project-serum/anchor";
import SolanaClientSwapContract from "../swaps/SolanaClientSwapContract";
import RefundEvent from "../../../events/types/RefundEvent";
import ClaimEvent from "../../../events/types/ClaimEvent";
import {Message, PublicKey} from "@solana/web3.js";
import InitializeEvent from "../../../events/types/InitializeEvent";
import {programIdl} from "../swaps/programIdl";

const nameMappedInstructions = {};
for(let ix of programIdl.instructions) {
    nameMappedInstructions[ix.name] = ix;
}

export type IxWithAccounts = ({name: string, data: any, accounts: {[key: string]: PublicKey}});

class SolanaChainEvents implements ChainEvents<SolanaSwapData> {

    private decodeInstructions(transactionMessage: Message): IxWithAccounts[] {

        const instructions: IxWithAccounts[] = [];

        for(let ix of transactionMessage.instructions) {
            if(transactionMessage.accountKeys[ix.programIdIndex].equals(this.solanaSwapProgram.program.programId)) {
                const parsedIx: any = this.coder.instruction.decode(ix.data, 'base58');
                const accountsData = nameMappedInstructions[parsedIx.name];
                if(accountsData!=null && accountsData.accounts!=null) {
                    parsedIx.accounts = {};
                    for(let i=0;i<accountsData.accounts.length;i++) {
                        parsedIx.accounts[accountsData.accounts[i].name] = transactionMessage.accountKeys[ix.accounts[i]]
                    }
                }
                instructions.push(parsedIx);
            } else {
                instructions.push(null);
            }
        }

        return instructions;

    }

    private readonly listeners: EventListener<SolanaSwapData>[] = [];

    private readonly provider: AnchorProvider;
    private readonly coder: BorshCoder;
    private readonly solanaSwapProgram: SolanaClientSwapContract;

    private eventListeners: number[] = [];

    constructor(provider: AnchorProvider, solanaSwapContract: SolanaClientSwapContract) {
        this.provider = provider;
        this.solanaSwapProgram = solanaSwapContract;

        this.coder = new BorshCoder(programIdl);

        this.eventListeners.push(solanaSwapContract.program.addEventListener("InitializeEvent", async (event, slotNumber, signature) => {

            const paymentHashBuffer = Buffer.from(event.hash);
            const paymentHashHex = paymentHashBuffer.toString("hex");

            const tx = await this.provider.connection.getTransaction(signature);

            const ixs = this.decodeInstructions(tx.transaction.message);

            let parsedEvent: InitializeEvent<SolanaSwapData>;

            for(let ix of ixs) {
                if (ix == null) continue;

                if (
                    (ix.name === "offererInitializePayIn" || ix.name === "offererInitialize")
                ) {
                    const paymentHash: Buffer = Buffer.from(ix.data.hash);

                    if(!paymentHashBuffer.equals(paymentHash)) continue;

                    const txoHash: Buffer = Buffer.from(event.txoHash);

                    let offerer: PublicKey;
                    let payIn: boolean;
                    if(ix.name === "offererInitializePayIn") {
                        offerer = ix.accounts.initializer;
                        payIn = true;
                    } else {
                        offerer = ix.accounts.offerer;
                        payIn = false;
                    }

                    const swapData: SolanaSwapData = new SolanaSwapData(
                        ix.accounts.initializer,
                        offerer,
                        ix.accounts.claimer,
                        ix.accounts.mint,
                        ix.data.initializerAmount,
                        paymentHash.toString("hex"),
                        ix.data.expiry,
                        ix.data.escrowNonce,
                        ix.data.confirmations,
                        ix.data.payOut,
                        ix.data.kind,
                        payIn,
                        ix.accounts.claimerTokenAccount
                    );

                    const usedNonce = ix.data.nonce.toNumber();

                    parsedEvent = new InitializeEvent<SolanaSwapData>(
                        paymentHash.toString("hex"),
                        txoHash.toString("hex"),
                        usedNonce,
                        swapData
                    );
                }
            }

            if(parsedEvent==null) return;

            for(let listener of this.listeners) {
                await listener([parsedEvent]);
            }

        }));
        this.eventListeners.push(solanaSwapContract.program.addEventListener("ClaimEvent", async (event, slotNumber, signature) => {
            const paymentHash = Buffer.from(event.hash).toString("hex");
            const secret = Buffer.from(event.secret).toString("hex");

            const parsedEvent = new ClaimEvent<SolanaSwapData>(paymentHash, secret);

            for(let listener of this.listeners) {
                await listener([parsedEvent]);
            }
        }));
        this.eventListeners.push(solanaSwapContract.program.addEventListener("RefundEvent", async (event, slotNumber, signature) => {
            const paymentHash = Buffer.from(event.hash).toString("hex");

            const parsedEvent = new RefundEvent<SolanaSwapData>(paymentHash);

            for(let listener of this.listeners) {
                await listener([parsedEvent]);
            }
        }));
    }

    async stop(): Promise<void> {
        for(let num of this.eventListeners) {
            await this.solanaSwapProgram.program.removeEventListener(num);
        }
        this.eventListeners = [];
    }

    registerListener(cbk: EventListener<SolanaSwapData>): void {
        this.listeners.push(cbk);
    }

    unregisterListener(cbk: EventListener<SolanaSwapData>): boolean {
        const index = this.listeners.indexOf(cbk);
        if(index>=0) {
            this.listeners.splice(index, 1);
            return true;
        }
        return false;
    }

}

export default SolanaChainEvents;