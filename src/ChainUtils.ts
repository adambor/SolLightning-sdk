import fetch, {Response} from "cross-fetch";
import * as bitcoin from "bitcoinjs-lib";
import {ConstantSoltoBTC} from "./Constants";

const url = "https://mempool.space/testnet/api/";

type TxVout = {
    scriptpubkey: string,
    scriptpubkey_asm: string,
    scriptpubkey_type: string,
    scriptpubkey_address: string,
    value: number
};

type TxVin = {
    txid: string,
    vout: number,
    prevout: TxVout,
    scriptsig: string,
    scriptsig_asm: string,
    witness: string[],
    is_coinbase: boolean,
    sequence: number,
    inner_witnessscript_asm: string
};

export type BitcoinTransaction = {
    txid: string,
    version: number,
    locktime: number,
    vin: TxVin[],
    vout: TxVout[],
    size: number,
    weight: number,
    fee: number,
    status: {
        confirmed: boolean,
        block_height: number,
        block_hash: string,
        block_time: number
    }
};

export type BlockData = {
    height: number,
    hash: string,
    timestamp: number,
    median_timestamp: number,
    previous_block_hash: string,
    difficulty: string,
    header: string,
    version: number,
    bits: number,
    nonce: number,
    size: number,
    weight: number,
    tx_count: number,
    merkle_root: string,
    reward: number,
    total_fee_amt: number,
    avg_fee_amt: number,
    median_fee_amt: number,
    avg_fee_rate: number,
    median_fee_rate: number
};

class ChainUtils {

    static async getTransaction(txId: string): Promise<BitcoinTransaction> {

        const response: Response = await fetch(url+"tx/"+txId, {
            method: "GET"
        });

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    static transactionHasOutput(tx: BitcoinTransaction, address: string, amount: number) {

        const outputScript = bitcoin.address.toOutputScript(address, ConstantSoltoBTC.network);
        for(let vout of tx.vout) {
            if(Buffer.from(vout.scriptpubkey).equals(outputScript) && vout.value===amount) {
                return true;
            }
        }

        return false;

    }

    static async getTransactionProof(txId: string) : Promise<{
        block_height: number,
        merkle: string[],
        pos: number
    }> {

        const response: Response = await fetch(url+"tx/"+txId+"/merkle-proof", {
            method: "GET"
        });

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        return jsonBody;

    }

    static async getBlockHash(height: number) {

        const response: Response = await fetch(url+"block-height/"+height, {
            method: "GET"
        });

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let blockHash: any = await response.text();

        return blockHash;

    }

    /**
     * Returns the blocks between startHeight and endHeight, max delta is 10
     *
     * @param startHeight       Start height, inclusive
     * @param endHeight         End height, inclusive
     */
    static async getBlocks(startHeight: number, endHeight: number) : Promise<BlockData[]> {

        const response: Response = await fetch(url+"v1/blocks-bulk/"+startHeight+"/"+endHeight, {
            method: "GET"
        });

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        return jsonBody;

    }

}

export default ChainUtils;