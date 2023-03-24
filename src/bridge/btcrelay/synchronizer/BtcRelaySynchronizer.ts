import {AnchorProvider, BN} from "@project-serum/anchor";
import BtcRelay, {Header, StoredHeader} from "../BtcRelay";
import ChainUtils, {BitcoinBlockHeader, BlockData} from "../../../ChainUtils";
import {computeCommitedHeader, gtBuffer} from "./StatePredictor";
import {SystemProgram, Transaction} from "@solana/web3.js";


const MAX_HEADERS_PER_TX = 7;
const MAX_HEADERS_PER_TX_FORK = 6;

const limit = 500;

class BtcRelaySynchronizer {

    provider: AnchorProvider;
    btcRelay: BtcRelay;

    constructor(provider: AnchorProvider, btcRelay: BtcRelay) {
        this.provider = provider;
        this.btcRelay = btcRelay;
    }

    async retrieveLog(spvCommitmentHash: Buffer, blockHash: Buffer): Promise<StoredHeader> {
        //Retrieve the log

        const topic = this.btcRelay.BtcRelayHeader(blockHash);

        let storedHeader = null;
        let lastSignature = null;
        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(topic, {
                    limit
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(topic, {
                    before: lastSignature,
                    limit
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.btcRelay.eventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        if(Buffer.from(log.data.commitHash).equals(spvCommitmentHash)) {
                            storedHeader = log.data.header;
                            break;
                        }
                    }
                }

                if(storedHeader!=null) break;
            }

        }

        return storedHeader;
    }

    async retrieveLatestKnownBlockLog(): Promise<{
        resultStoredHeader: StoredHeader,
        resultBitcoinHeader: string
    }> {
        //Retrieve the log
        let storedHeader = null;
        let bitcoinHeader = null;

        let lastSignature = null;

        const mainState: any = await this.btcRelay.program.account.mainState.fetch(this.btcRelay.BtcRelayMainState);

        const storedCommitments = new Set();
        mainState.blockCommitments.forEach(e => {
            storedCommitments.add(Buffer.from(e).toString("hex"));
        });

        while(storedHeader==null) {
            let fetched;
            if(lastSignature==null) {
                fetched = await this.provider.connection.getSignaturesForAddress(this.btcRelay.program.programId, {
                    limit
                }, "confirmed");
            } else {
                fetched = await this.provider.connection.getSignaturesForAddress(this.btcRelay.program.programId, {
                    before: lastSignature,
                    limit
                }, "confirmed");
            }
            if(fetched.length===0) throw new Error("Block cannot be fetched");
            lastSignature = fetched[fetched.length-1].signature;
            for(let data of fetched) {
                const tx = await this.provider.connection.getTransaction(data.signature, {
                    commitment: "confirmed"
                });
                if(tx.meta.err) continue;

                const events = this.btcRelay.eventParser.parseLogs(tx.meta.logMessages);

                for(let log of events) {
                    if(log.name==="StoreFork" || log.name==="StoreHeader") {
                        const blockHash = Buffer.from(log.data.blockHash);
                        try {
                            const blockHashHex = blockHash.reverse().toString("hex");
                            const btcBlockHeaderStatus = await ChainUtils.getBlockStatus(blockHashHex);
                            if(btcBlockHeaderStatus.in_best_chain) {
                                //Check if this fork is part of main chain
                                const commitHash = Buffer.from(log.data.commitHash).toString("hex");
                                if(storedCommitments.has(commitHash)) {
                                    bitcoinHeader = blockHashHex;
                                    storedHeader = log.data.header;
                                    break;
                                }
                            }
                        } catch (e) {
                            //Still in a fork
                        }
                    }
                }

                if(storedHeader!=null) break;
            }
        }

        return {
            resultStoredHeader: storedHeader,
            resultBitcoinHeader: bitcoinHeader
        };
    }

    static serializeBlockHeader(e: BlockData): Header & {hash: Buffer} {
        return {
            version: e.version,
            reversedPrevBlockhash: [...Buffer.from(e.previousblockhash, "hex").reverse()],
            merkleRoot: [...Buffer.from(e.merkle_root, "hex").reverse()],
            timestamp: e.timestamp,
            nbits: e.bits,
            nonce: e.nonce,
            hash: Buffer.from(e.id, "hex").reverse()
        };
    }

    async saveMainHeaders(mainHeaders: BlockData[], storedHeader: StoredHeader) {
        const blockHeaderObj = mainHeaders.map(BtcRelaySynchronizer.serializeBlockHeader);

        console.log("[BTCRelay: Solana.submitMainChainHeaders] Submitting headers: ", blockHeaderObj);

        const tx = await this.btcRelay.program.methods
            .submitBlockHeaders(
                blockHeaderObj,
                storedHeader
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.btcRelay.BtcRelayMainState,
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.btcRelay.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computeCommitedHeader(computedCommitedHeaders[computedCommitedHeaders.length-1], blockHeader));
        }

        return {
            forkId: 0,
            lastStoredHeader: computedCommitedHeaders[computedCommitedHeaders.length-1],
            tx,
            computedCommitedHeaders
        }
    }

    async saveNewForkHeaders(forkHeaders: BlockData[], storedHeader: StoredHeader, tipWork: Buffer) {
        const blockHeaderObj = forkHeaders.map(BtcRelaySynchronizer.serializeBlockHeader);

        const mainState: any = await this.btcRelay.program.account.mainState.fetch(this.btcRelay.BtcRelayMainState);

        let forkId: BN = mainState.forkCounter;

        const tx = await this.btcRelay.program.methods
            .submitForkHeaders(
                blockHeaderObj,
                storedHeader,
                forkId,
                true
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.btcRelay.BtcRelayMainState,
                forkState: this.btcRelay.BtcRelayFork(forkId.toNumber(), this.provider.publicKey),
                systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.btcRelay.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computeCommitedHeader(computedCommitedHeaders[computedCommitedHeaders.length-1], blockHeader));
        }

        const changedCommitedHeader = computedCommitedHeaders[computedCommitedHeaders.length-1];

        if(gtBuffer(Buffer.from(changedCommitedHeader.chainWork), tipWork)) {
            //Already main chain
            forkId = new BN(0);
        }

        return {
            forkId: forkId.toNumber(),
            lastStoredHeader: changedCommitedHeader,
            tx,
            computedCommitedHeaders
        }
    }

    async saveForkHeaders(forkHeaders: BlockData[], storedHeader: StoredHeader, forkId: number, tipWork: Buffer) {
        const blockHeaderObj = forkHeaders.map(BtcRelaySynchronizer.serializeBlockHeader);

        const tx = await this.btcRelay.program.methods
            .submitForkHeaders(
                blockHeaderObj,
                storedHeader,
                forkId,
                false
            )
            .accounts({
                signer: this.provider.publicKey,
                mainState: this.btcRelay.BtcRelayMainState,
                forkState: this.btcRelay.BtcRelayFork(forkId, this.provider.publicKey),
                systemProgram: SystemProgram.programId,
            })
            .remainingAccounts(blockHeaderObj.map(e => {
                return {
                    pubkey: this.btcRelay.BtcRelayHeader(e.hash),
                    isSigner: false,
                    isWritable: false
                }
            }))
            .transaction();

        const computedCommitedHeaders = [storedHeader];
        for(let blockHeader of blockHeaderObj) {
            computedCommitedHeaders.push(computeCommitedHeader(computedCommitedHeaders[computedCommitedHeaders.length-1], blockHeader));
        }

        const changedCommitedHeader = computedCommitedHeaders[computedCommitedHeaders.length-1];

        if(gtBuffer(Buffer.from(changedCommitedHeader.chainWork), tipWork)) {
            //Already main chain
            forkId = 0;
        }

        return {
            forkId: forkId,
            lastStoredHeader: changedCommitedHeader,
            tx,
            computedCommitedHeaders
        }
    }

    async syncToLatestTxs(): Promise<{
        txs: Transaction[]
        targetCommitedHeader: StoredHeader,
        computedHeaderMap: {[blockheight: number]: StoredHeader}
    }> {

        const acc = await this.btcRelay.program.account.mainState.fetch(this.btcRelay.BtcRelayMainState);

        const spvTipCommitment = Buffer.from(acc.tipCommitHash);
        const blockHashTip = Buffer.from(acc.tipBlockHash);

        let mainChainWork = Buffer.from(acc.chainWork);
        let cacheData: {
            forkId: number,
            lastStoredHeader: StoredHeader,
            tx: Transaction,
            computedCommitedHeaders: StoredHeader[]
        } = {
            forkId: 0,
            lastStoredHeader: null,
            tx: null,
            computedCommitedHeaders: null
        };

        let spvTipBlockHeader: BitcoinBlockHeader;
        try {
            const blockHashHex = Buffer.from(acc.tipBlockHash).reverse().toString("hex");
            console.log("Stored tip hash: ", blockHashHex);
            const blockStatus = await ChainUtils.getBlockStatus(blockHashHex);
            if(!blockStatus.in_best_chain) throw new Error("Block not in main chain");
            spvTipBlockHeader = await ChainUtils.getBlock(blockHashHex);
            cacheData.lastStoredHeader = await this.retrieveLog(spvTipCommitment, blockHashTip);
        } catch (e) {
            console.error(e);
            //Block not found, therefore relay tip is probably in a fork
            const {resultStoredHeader, resultBitcoinHeader} = await this.retrieveLatestKnownBlockLog();
            cacheData.lastStoredHeader = resultStoredHeader;
            cacheData.forkId = -1; //Indicate that we will be submitting blocks to fork
            spvTipBlockHeader = await ChainUtils.getBlock(resultBitcoinHeader);
        }

        console.log("Retrieved stored header with commitment: ", cacheData.lastStoredHeader);

        console.log("SPV tip hash: ", blockHashTip.toString("hex"));

        console.log("SPV tip header: ", spvTipBlockHeader);

        let spvTipBlockHeight = spvTipBlockHeader.height;

        const txsList: Transaction[] = [];
        const computedHeaderMap: {[blockheight: number]: StoredHeader} = {};

        const saveHeaders = async (headerCache: BlockData[]) => {
            console.log("Header cache: ", headerCache);
            if(cacheData.forkId===-1) {
                cacheData = await this.saveNewForkHeaders(headerCache, cacheData.lastStoredHeader, mainChainWork)
            } else if(cacheData.forkId===0) {
                cacheData = await this.saveMainHeaders(headerCache, cacheData.lastStoredHeader);
            } else {
                cacheData = await this.saveForkHeaders(headerCache, cacheData.lastStoredHeader, cacheData.forkId, mainChainWork)
            }
            txsList.push(cacheData.tx);
            for(let storedHeader of cacheData.computedCommitedHeaders) {
                computedHeaderMap[storedHeader.blockheight] = storedHeader;
            }
        };

        let retrievedHeaders: BlockData[] = null;
        let headerCache: BlockData[] = [];
        while(retrievedHeaders==null || retrievedHeaders.length>0) {

            retrievedHeaders = await ChainUtils.getPast15Blocks(spvTipBlockHeight+15);

            for(let i=retrievedHeaders.length-1;i>=0;i--) {
                const header = retrievedHeaders[i];

                headerCache.push(header);

                if(cacheData.forkId===0 ?
                    headerCache.length>=MAX_HEADERS_PER_TX :
                    headerCache.length>=MAX_HEADERS_PER_TX_FORK) {

                    await saveHeaders(headerCache);

                    headerCache = [];
                }
            }

            if(retrievedHeaders.length>0) {
                spvTipBlockHeight = retrievedHeaders[0].height;

                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
        }

        if(headerCache.length>0) {
            await saveHeaders(headerCache);
        }

        return {
            txs: txsList,
            targetCommitedHeader: cacheData.lastStoredHeader,
            computedHeaderMap
        };

    }

}

export default BtcRelaySynchronizer;