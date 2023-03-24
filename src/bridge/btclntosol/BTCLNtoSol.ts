import fetch, {Response} from "cross-fetch";
import * as bolt11 from "bolt11";

import {createHash, randomBytes} from "crypto-browserify";
import {
    Ed25519Program,
    PublicKey,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction
} from "@solana/web3.js";
import {AnchorProvider, BN, Program} from "@project-serum/anchor";
import {programIdl} from "../contracts/programIdl";
import {sign} from "tweetnacl";
import {TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountInstruction} from "@solana/spl-token";
import Utils from "../../Utils";
import {Bitcoin, ConstantBTCLNtoSol, ConstantBTCtoSol} from "../../Constants";
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from "bitcoinjs-lib";
import {ECPairAPI, ECPairFactory, TinySecp256k1Interface} from 'ecpair';

import * as tinysecp from "tiny-secp256k1";
import ChainUtils from "../../ChainUtils";
import BtcRelay from "../btcrelay/BtcRelay";
import BtcRelaySynchronizer from "../btcrelay/synchronizer/BtcRelaySynchronizer";
const ECPair: ECPairAPI = ECPairFactory(tinysecp);

const timeoutPromise = (timeoutSeconds) => {
    return new Promise(resolve => {
        setTimeout(resolve, timeoutSeconds*1000)
    });
};

const MIN_TIME_TO_CONFIRM = ConstantBTCLNtoSol.claimGracePeriod;

const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";
const MAIN_STATE_SEED = "main_state";
const TX_DATA_SEED = "data";

export type AtomicSwapStruct = {
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN,
    kind?: number,
    confirmations?: number
};

export class PaymentAuthError extends Error {

    code: number;
    data: any;

    constructor(msg: string, code?: number, data?: any) {
        super(msg);
        this.data = data;
        this.code = code;
        // Set the prototype explicitly.
        Object.setPrototypeOf(this, PaymentAuthError.prototype);
    }

    getCode(): number {
        return this.code;
    }

    getData(): any {
        return this.data;
    }

}

export const BTCLNtoEVMCommitStatus = {
    EXPIRED: 0,
    NOT_COMMITTED: 1,
    COMMITTED: 2,
    PAID: 3
};

class BTCLNtoSol {

    WBTC_ADDRESS: PublicKey;
    provider: AnchorProvider;
    program: Program;
    vaultAuthorityKey: PublicKey;
    vaultKey: PublicKey;

    btcRelay: BtcRelay;
    btcRelaySynchronizer: BtcRelaySynchronizer;

    constructor(provider: AnchorProvider, wbtcToken: PublicKey) {
        this.provider = provider;
        this.WBTC_ADDRESS = wbtcToken;
        this.btcRelay = new BtcRelay(provider);
        this.btcRelaySynchronizer = new BtcRelaySynchronizer(this.provider, this.btcRelay);
        this.program = new Program(programIdl, programIdl.metadata.address, this.provider);
        this.vaultAuthorityKey = PublicKey.findProgramAddressSync(
            [Buffer.from(AUTHORITY_SEED)],
            this.program.programId
        )[0];
        this.vaultKey = PublicKey.findProgramAddressSync(
            [Buffer.from(VAULT_SEED), this.WBTC_ADDRESS.toBuffer()],
            this.program.programId
        )[0];
    }

    getSwapDataKey(reversedTxId: Buffer, wallet: PublicKey) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from(TX_DATA_SEED), reversedTxId, wallet.toBuffer()],
            this.program.programId
        )[0];
    }

    getUserVaultKey(wallet: PublicKey) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from(USER_VAULT_SEED), wallet.toBuffer(), this.WBTC_ADDRESS.toBuffer()],
            this.program.programId
        )[0];
    }

    getEscrowStateKey(hash: Buffer) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from(STATE_SEED), hash],
            this.program.programId
        )[0];
    }

    async getData(pubkey: PublicKey) {
        try {
            return await this.program.account.data.fetch(pubkey);
        } catch (e) {
            console.error(e);
            return null;
        }
    }

    static isExpired(data: AtomicSwapStruct): boolean {

        const currentTimestamp = new BN(Math.floor(Date.now()/1000)+ConstantBTCLNtoSol.claimGracePeriod);

        return data.expiry.lt(currentTimestamp);

    }

    static getOnchainSendTimeout(data: AtomicSwapStruct) {
        const tsDelta = (ConstantBTCtoSol.blocksTillTxConfirms + data.confirmations) * Bitcoin.blockTime * ConstantBTCtoSol.safetyFactor;
        return data.expiry.sub(new BN(tsDelta));
    }

    async getCommitStatus(intermediary: PublicKey, data: AtomicSwapStruct): Promise<number> {

        const escrowStateKey = this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex"));
        try {
            const escrowState: any = await this.program.account.escrowState.fetch(escrowStateKey);

            if(
                !escrowState.offerer.equals(intermediary) ||
                !escrowState.claimer.equals(data.intermediary) ||
                !escrowState.mint.equals(data.token) ||
                !escrowState.initializerAmount.eq(data.amount) ||
                !escrowState.expiry.eq(data.expiry)
            ) {
                return BTCLNtoEVMCommitStatus.NOT_COMMITTED;
            }

            return BTCLNtoEVMCommitStatus.COMMITTED;
        } catch (e) {
            //Check if paid or what
            const signatures = await this.provider.connection.getSignaturesForAddress(escrowStateKey, {
                limit: 500
            });
            for(let sig of signatures) {
                const tx = await this.provider.connection.getTransaction(sig.signature);
                if(tx.meta.err==null) {
                    const instructions = Utils.decodeInstructions(tx.transaction.message);
                    for(let ix of instructions) {
                        if(ix==null) continue;
                        if(ix.name==="claimerClaim" || ix.name==="claimerClaimPayOut" || ix.name==="claimerClaimWithExtData" || ix.name==="claimerClaimPayOutWithExtData") {
                            return BTCLNtoEVMCommitStatus.PAID;
                        }
                        if(ix.name==="offererRefund" || ix.name==="offererRefundPayOut" || ix.name==="offererRefundWithSignature" || ix.name==="offererRefundWithSignaturePayOut") {
                            if(BTCLNtoSol.isExpired(data)) {
                                return BTCLNtoEVMCommitStatus.EXPIRED;
                            }
                            return BTCLNtoEVMCommitStatus.NOT_COMMITTED;
                        }
                    }
                }
            }
            if(BTCLNtoSol.isExpired(data)) {
                return BTCLNtoEVMCommitStatus.EXPIRED;
            }
            return BTCLNtoEVMCommitStatus.NOT_COMMITTED;
        }
    }

    async isClaimable(intermediary: PublicKey, data: AtomicSwapStruct): Promise<boolean> {

        if(BTCLNtoSol.isExpired(data)) {
            return false;
        }

        try {
            const escrowState: any = await this.program.account.escrowState.fetch(this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex")));
            if(
                !escrowState.offerer.equals(intermediary) ||
                !escrowState.claimer.equals(data.intermediary) ||
                !escrowState.mint.equals(data.token) ||
                !escrowState.initializerAmount.eq(data.amount) ||
                !escrowState.expiry.eq(data.expiry)
            ) {
                return false;
            }
        } catch (e) {
            return false;
        }

        return true;

    }

    async createBOLT11PaymentRequest(address: PublicKey, amount: BN, expirySeconds: number, url: string): Promise<{
        secret: Buffer,
        pr: string,
        swapFee: BN
    }> {

        const secret = randomBytes(32);

        const paymentHash = createHash("sha256").update(secret).digest();

        const response: Response = await fetch(url+"/createInvoice", {
            method: "POST",
            body: JSON.stringify({
                paymentHash: paymentHash.toString("hex"),
                amount: amount.toString(),
                expiry: expirySeconds,
                address: address.toBase58()
            }),
            headers: {'Content-Type': 'application/json'}
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

        const decodedPR = bolt11.decode(jsonBody.data.pr);

        if(!new BN(decodedPR.millisatoshis).div(new BN(1000)).eq(amount)) throw new Error("Invalid payment request returned, amount mismatch");

        return {
            secret,
            pr: jsonBody.data.pr,
            swapFee: new BN(jsonBody.data.swapFee)
        };

    }

    static generateLockingScript(csv_delta: number, hash: Buffer, intermediaryKey: string, offererKey: string): {
        address: string,
        scriptHash: Buffer,
        scriptBuffer: Buffer,
        scriptAsm: string
    } {

        if(csv_delta<0) {
            throw new Error("Invalid csv delta");
        }

        let script = "5187"; //PUSH_1 OP_EQUAL

        script += "63"; //OP_IF

        script += "a8"; //OP_SHA256
        script += "20"+hash.toString("hex"); //PUSH_32 <hash>
        script += "88"; //OP_EQUALVERIFY
        script += "21"+intermediaryKey; //PUSH_33 <our key>

        script += "67"; //OP_ELSE

        if(csv_delta<17) {
            if(csv_delta===0) {
                script += "00";
            } else {
                script += (csv_delta + 0x50).toString(16).padStart(2, "0"); //PUSH_<csv>
            }
        } else {
            let csvDeltaHex = csv_delta.toString(16);
            const csvDeltaLen = Math.ceil(csvDeltaHex.length/2);
            csvDeltaHex = csvDeltaHex.padStart(csvDeltaLen*2, "0");
            script += csvDeltaLen.toString(16).padStart(2, "0")+csvDeltaHex; //PUSH_x <csv>
        }
        script += "b2"; //OP_CSV
        script += "75"; //OP_DROP
        script += "21"+offererKey; //PUSH_33 <payee's key>

        script += "68"; //OP_ENDIF

        script += "ac"; //OP_CHECKSIG

        const scriptBuffer = Buffer.from(script, "hex");
        const scriptAsm = bitcoin.script.toASM(scriptBuffer);

        const scriptHash = createHash("sha256").update(scriptBuffer).digest();

        const payment = bitcoin.payments.p2wsh({
            hash: scriptHash,
            network: ConstantBTCtoSol.network
        });

        const address = payment.address;

        console.log("Computed p2wsh address: ", address);

        return {
            address,
            scriptHash,
            scriptBuffer,
            scriptAsm
        };

    }


    async createOnchainPaymentRequest(address: PublicKey, amount: BN, url: string): Promise<{
        secret: Buffer,
        hash: Buffer,
        address: string,
        swapFee: BN,
        networkFee: BN,
        generatedPrivKey: Buffer,
        intermediaryBtcPublicKey: string,
        csvDelta: number
    }> {

        const keypair = ECPair.makeRandom({
            compressed: true,
            network: ConstantBTCtoSol.network
        });

        let privateKey;
        do {
            privateKey = randomBytes(32);
        } while(!ecc.isPrivate(privateKey));

        const secret = randomBytes(32);

        const paymentHash = createHash("sha256").update(secret).digest();

        const btcPublicKey: string = keypair.publicKey.toString("hex");

        const response: Response = await fetch(url+"/createInvoice", {
            method: "POST",
            body: JSON.stringify({
                paymentHash: paymentHash.toString("hex"),
                amount: amount.toString(),
                address: address.toBase58(),
                btcPublicKey
            }),
            headers: {'Content-Type': 'application/json'}
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

        const lockingScript = BTCLNtoSol.generateLockingScript(jsonBody.data.csvDelta, paymentHash, jsonBody.data.publicKey, btcPublicKey);

        if(lockingScript.address!==jsonBody.data.address) throw new Error("Invalid payment request returned, amount mismatch");

        return {
            secret,
            hash: paymentHash,
            address: jsonBody.data.address,
            swapFee: new BN(jsonBody.data.swapFee),
            networkFee: new BN(jsonBody.data.networkFee),
            generatedPrivKey: keypair.privateKey,
            intermediaryBtcPublicKey: jsonBody.data.publicKey,
            csvDelta: jsonBody.data.csvDelta
        };

    }

    async createOnchainPaymentRequestRelay(address: PublicKey, amount: BN, url: string): Promise<{
        address: string,
        swapFee: BN,
        intermediary: PublicKey,
        data: AtomicSwapStruct
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number
    }> {
        const response: Response = await fetch(url+"/getAddress", {
            method: "POST",
            body: JSON.stringify({
                address: address.toBase58(),
                amount: amount.toString()
            }),
            headers: {'Content-Type': 'application/json'}
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

        if(jsonBody.data.data.confirmations>ConstantBTCtoSol.maxConfirmations) {
            throw new Error("Requires too many confirmations");
        }

        if(jsonBody.data.data.kind!=1) {
            throw new Error("Invalid type of the swap");
        }

        const data: AtomicSwapStruct = {
            intermediary: new PublicKey(jsonBody.data.data.intermediary),
            token: new PublicKey(jsonBody.data.data.token),
            amount: new BN(jsonBody.data.data.amount),
            paymentHash: jsonBody.data.data.paymentHash,
            expiry: new BN(jsonBody.data.data.expiry),
            kind: jsonBody.data.data.kind,
            confirmations: jsonBody.data.data.confirmations
        };

        //Check that we have enough time to send the TX and for it to confirm
        const expiry = BTCLNtoSol.getOnchainSendTimeout(data);
        const currentTimestamp = new BN(Math.floor(Date.now()/1000));

        if(expiry.sub(currentTimestamp).lt(new BN(ConstantBTCtoSol.minSendWindow))) {
            throw new Error("Send window too low");
        }

        const lockingScript = bitcoin.address.toOutputScript(jsonBody.data.btcAddress, ConstantBTCtoSol.network);

        const desiredHash = createHash("sha256").update(Buffer.concat([
            Buffer.from(new BN(0).toArray("le", 8)),
            Buffer.from(amount.toArray("le", 8)),
            lockingScript
        ])).digest();

        const suppliedHash = Buffer.from(jsonBody.data.data.paymentHash,"hex");

        if(!desiredHash.equals(suppliedHash)) throw new Error("Invalid payment hash returned!");

        return {
            address: jsonBody.data.btcAddress,
            swapFee: new BN(jsonBody.data.swapFee),
            intermediary: new PublicKey(jsonBody.data.address),
            data,
            prefix: jsonBody.data.prefix,
            timeout: jsonBody.data.timeout,
            signature: jsonBody.data.signature,
            nonce: jsonBody.data.nonce
        };

    }

    async getInvoiceStatus(bolt11PaymentReq: string, url: string, abortSignal?: AbortSignal): Promise<boolean> {

        const decodedPR = bolt11.decode(bolt11PaymentReq);

        const paymentHash = decodedPR.tagsObject.payment_hash;

        const response: Response = await fetch(url+"/getInvoicePaymentAuth", {
            method: "POST",
            body: JSON.stringify({
                paymentHash: paymentHash
            }),
            headers: {'Content-Type': 'application/json'}
        });

        if(abortSignal!=null && abortSignal.aborted) throw new Error("Aborted");

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

        if(jsonBody.code===10000) {
            return true;
        }

        if(jsonBody.code===10003) {
            //Yet unpaid
            return false;
        }

        throw new PaymentAuthError(jsonBody.msg,  jsonBody.code);
    }

    async getPaymentAuthorization(bolt11PaymentReqOrHash: string | Buffer, minOut: BN, url: string, address?: PublicKey, abortSignal?: AbortSignal): Promise<{
        is_paid: boolean,

        confirmations?: number,
        targetConfirmations?: number,
        txId?: string,
        vout?: number,
        amount?: BN,
        swapFee?: BN,
        networkFee?: BN,

        intermediary?: PublicKey,
        data?: AtomicSwapStruct,
        prefix?: string,
        timeout?: string,
        signature?: string,
        nonce?: number
    }> {

        let paymentHash;
        if(typeof(bolt11PaymentReqOrHash)==="string") {
            const decodedPR = bolt11.decode(bolt11PaymentReqOrHash);
            paymentHash = decodedPR.tagsObject.payment_hash;
        } else {
            paymentHash = bolt11PaymentReqOrHash.toString("hex");
        }

        const response: Response = await fetch(url+"/getInvoicePaymentAuth", {
            method: "POST",
            body: JSON.stringify({
                paymentHash: paymentHash
            }),
            headers: {'Content-Type': 'application/json'}
        });

        if(abortSignal!=null && abortSignal.aborted) throw new Error("Aborted");

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

        if(jsonBody.code===10000) {
            //Authorization returned
            jsonBody.data.data.intermediary = new PublicKey(jsonBody.data.data.intermediary);
            jsonBody.data.data.token = new PublicKey(jsonBody.data.data.token);
            jsonBody.data.data.expiry = new BN(jsonBody.data.data.expiry);
            jsonBody.data.data.amount = new BN(jsonBody.data.data.amount);
            jsonBody.data.address = new PublicKey(jsonBody.data.address);

            const data: AtomicSwapStruct = jsonBody.data.data;

            if(address!=null) {
                if (!data.intermediary.equals(address)) {
                    console.error("[EVM.PaymentRequest] Invalid to address used");
                    throw new PaymentAuthError("Invalid address used");
                }
            }

            const tokenAddress = data.token;

            if (!tokenAddress.equals(this.WBTC_ADDRESS)) {
                console.error("[EVM.PaymentRequest] Invalid token used");
                throw new PaymentAuthError("Invalid token used");
            }


            await this.isValidAuthorization(jsonBody.data.address, data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature, jsonBody.data.nonce);

            const paymentHashInTx = data.paymentHash.toLowerCase();

            console.log("[EVM.PaymentRequest] lightning payment hash: ", paymentHashInTx);

            if(paymentHashInTx!==paymentHash.toLowerCase()) {
                console.error("[EVM.PaymentRequest] lightning payment request mismatch");
                throw (new PaymentAuthError("Lightning payment request mismatch"));
            }

            const tokenAmount = data.amount;

            console.log("[EVM.PaymentRequest] Token amount: ", tokenAmount.toString());

            if(minOut!=null) {
                if (tokenAmount.lt(minOut)) {
                    console.error("[EVM.PaymentRequest] Not enough offered!");
                    throw (new PaymentAuthError("Not enough offered!"));
                }
            }

            return {
                is_paid: true,
                intermediary: jsonBody.data.address,
                data,
                prefix: jsonBody.data.prefix,
                timeout: jsonBody.data.timeout,
                signature: jsonBody.data.signature,
                nonce: jsonBody.data.nonce
            }
        }

        if(jsonBody.code===10003) {
            //Yet unpaid
            return {
                is_paid: false
            };
        }

        if(jsonBody.code===10005) {
            //Waiting for confirmations
            return {
                is_paid: false,
                confirmations: jsonBody.data.confirmations,
                targetConfirmations: jsonBody.data.requiredConfirmations,
                txId: jsonBody.data.txId,
                vout: jsonBody.data.vout,
                amount: new BN(jsonBody.data.amount),
                swapFee: new BN(jsonBody.data.swapFee),
                networkFee: new BN(jsonBody.data.networkFee)
            };
        }

        throw new PaymentAuthError(jsonBody.msg,  jsonBody.code);
    }

    async waitForInvoiceStatus(bolt11PaymentReq: string, url: string, abortSignal?: AbortSignal, intervalSeconds?: number): Promise<boolean> {
        if(abortSignal!=null && abortSignal.aborted) {
            throw new Error("Aborted");
        }

        const decodedPR = bolt11.decode(bolt11PaymentReq);

        //const paymentHash = decodedPR.tagsObject.payment_hash;
        //const amount = ethers.BigNumber.from(decodedPR.millisatoshis).div(ethers.BigNumber.from(1000));

        while(!abortSignal.aborted) {
            const result = await this.getInvoiceStatus(bolt11PaymentReq, url, abortSignal);
            if(result!=false) return result;
            await timeoutPromise(intervalSeconds || 5);
        }

        throw new Error("Aborted");
    }

    async waitForIncomingPaymentAuthorization(
        bolt11PaymentReqOrHash: string | Buffer,
        minOut: BN,
        url: string,
        address?: PublicKey,
        abortSignal?: AbortSignal,
        intervalSeconds?: number,
        stateUpdateCbk?: (
            confirmations: number,
            targetConfirmations: number,
            txId: string,
            vout: number,
            amount: BN,
            swapFee: BN,
            networkFee: BN
        ) => void
    ) : Promise<{
        data: AtomicSwapStruct,
        intermediary: PublicKey,
        prefix: string,
        timeout: string,
        signature: string,
        nonce: number
    }> {
        if(abortSignal!=null && abortSignal.aborted) {
            throw new Error("Aborted");
        }

        //const paymentHash = decodedPR.tagsObject.payment_hash;
        //const amount = ethers.BigNumber.from(decodedPR.millisatoshis).div(ethers.BigNumber.from(1000));

        while(!abortSignal.aborted) {
            const result = await this.getPaymentAuthorization(bolt11PaymentReqOrHash, minOut, url, address, abortSignal);
            if(result.is_paid) return <any>result;
            if(stateUpdateCbk!=null) {
                if(result.txId!=null) stateUpdateCbk(result.confirmations, result.targetConfirmations, result.txId, result.vout, result.amount, result.swapFee, result.networkFee);
            }
            await timeoutPromise(intervalSeconds || 5);
        }

        throw new Error("Aborted");
    }

    /*static waitForIncomingPayment(address: string, bolt11PaymentReq: string, minOut: ethers.BigNumber, abortSignal?: AbortSignal): Promise<{
        data: AtomicSwapStruct,
        intermediary: string
    }> {
        if(abortSignal!=null && abortSignal.aborted) {
            return Promise.reject("Aborted");
        }

        const decodedPR = bolt11.decode(bolt11PaymentReq);

        const paymentHash = decodedPR.tagsObject.payment_hash;
        const amount = ethers.BigNumber.from(decodedPR.millisatoshis).div(ethers.BigNumber.from(1000));

        return new Promise((resolve, reject) => {
            if(abortSignal!=null && abortSignal.aborted) {
                reject(new Error("Aborted"));
                return;
            }

            const filter = this.contract.filters.PaymentRequest(null, address, "0x"+paymentHash);

            this.contract.on(filter, async (offerer, claimer, commitment, data, event) => {
                //Transfers to me
                const tokenAddress = data.token;

                if (tokenAddress.toLowerCase() !== wbtcContractData.address.toLowerCase()) {
                    console.error("[EVM.PaymentRequest] Invalid token used");
                    this.contract.removeAllListeners(filter);
                    reject(new Error("Invalid token used"));
                    return;
                }

                const tokenAmount = data.amount;

                const expiryTimestamp = data.expiry;
                const currentTimestamp = Math.floor(Date.now() / 1000);

                console.log("[EVM.PaymentRequest] Expiry time: ", expiryTimestamp.toString());

                if (expiryTimestamp.sub(ethers.BigNumber.from(currentTimestamp)).lt(ethers.BigNumber.from(MIN_TIME_TO_CONFIRM))) {
                    console.error("[EVM.PaymentRequest] Not enough time to reliably pay the invoice");
                    this.contract.removeAllListeners(filter);
                    reject(new Error("Not enough time to reliably pay the invoice"));
                    return;
                }

                const paymentHashInTx = data.paymentHash.substring(2).toLowerCase();

                console.log("[EVM.PaymentRequest] lightning payment hash: ", paymentHashInTx);

                if(paymentHashInTx!==paymentHash.toLowerCase()) {
                    console.error("[EVM.PaymentRequest] lightning payment request mismatch");
                    this.contract.removeAllListeners(filter);
                    reject(new Error("Lightning payment request mismatch"));
                    return;
                }

                console.log("[EVM.PaymentRequest] Invoice amount: ", amount.toString());
                console.log("[EVM.PaymentRequest] Token amount: ", tokenAmount.toString());

                if (tokenAmount.lt(minOut)) {
                    console.error("[EVM.PaymentRequest] Not enough offered!");
                    this.contract.removeAllListeners(filter);
                    reject(new Error("Not enough offered!"));
                    return;
                }

                resolve({
                    data: this.structToAtomicSwap(data),
                    intermediary: offerer
                });
            });

            if(abortSignal!=null) abortSignal.addEventListener("abort", () => {
                this.contract.removeAllListeners(filter);
                reject(new Error("Aborted"));
            });
        });
    }*/

    async isValidAuthorization(intermediary: PublicKey, data: AtomicSwapStruct, timeout: string, prefix: string, signature: string, nonce: number): Promise<Buffer> {

        console.log("Intermediary: ", intermediary);
        console.log("data: ", data);
        console.log("timeout: ", timeout);
        console.log("prefix: ", prefix);
        console.log("signature: ", signature);
        console.log("nonce: ", nonce);

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(ConstantBTCLNtoSol.authorizationGracePeriod));

        if (isExpired) {
            throw new Error("Authorization expired!");
        }

        const swapWillExpireTooSoon = data.expiry.sub(currentTimestamp).lt(new BN(ConstantBTCLNtoSol.authorizationGracePeriod).add(new BN(ConstantBTCLNtoSol.claimGracePeriod)));

        if (swapWillExpireTooSoon) {
            throw new Error("Swap will expire too soon!");
        }

        //Check correctness of nonce
        const userAccount: any = await this.program.account.userAccount.fetch(this.getUserVaultKey(intermediary));

        if(nonce<=userAccount.nonce.toNumber()) {
            throw new Error("Invalid nonce!");
        }

        const messageBuffers = [
            Buffer.from(prefix, "ascii"),
            Buffer.from(new BN(nonce).toArray("le", 8)),
            data.token.toBuffer(),
            data.intermediary.toBuffer(),
            Buffer.from(data.amount.toArray("le", 8)),
            Buffer.from(data.expiry.toArray("le", 8)),
            Buffer.from(data.paymentHash, "hex"),
            Buffer.from(new BN(data.kind || 0).toArray("le", 1)),
            Buffer.from(new BN(data.confirmations || 0).toArray("le", 2)),
            Buffer.from(expiryTimestamp.toArray("le", 8)),
        ];

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = Buffer.concat(messageBuffers);

        if(!sign.detached.verify(messageBuffer, signatureBuffer, intermediary.toBuffer())) {
            throw new Error("Invalid signature!");
        }

        return messageBuffer;
    }

    async createPayWithAuthorizationIx(intermediary: PublicKey, data: AtomicSwapStruct, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer): Promise<TransactionInstruction[]> {

        const messageBuffer = await this.isValidAuthorization(intermediary, data, timeout, prefix, signature, nonce);

        const paymentHash = Buffer.from(data.paymentHash, "hex");
        const signatureBuffer = Buffer.from(signature, "hex");

        const claimerAta = getAssociatedTokenAddressSync(this.WBTC_ADDRESS, data.intermediary);

        let result = await this.program.methods
            .offererInitialize(new BN(nonce), data.amount, data.expiry, paymentHash, new BN(data.kind || 0), new BN(data.confirmations || 0), new BN(0), new BN(timeout), signatureBuffer, true, txoHash || Buffer.alloc(32, 0))
            .accounts({
                initializer: data.intermediary,
                offerer: intermediary,
                claimer: data.intermediary,
                claimerTokenAccount: claimerAta,
                mint: this.WBTC_ADDRESS,
                userData: this.getUserVaultKey(intermediary),
                escrowState: this.getEscrowStateKey(paymentHash),
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

        const signatureVerificationInstruction = Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: intermediary.toBuffer(),
            signature: signatureBuffer
        });

        return [
            signatureVerificationInstruction,
            result
        ];

    }

    async createPayWithAuthorizationTx(intermediary: PublicKey, data: AtomicSwapStruct, timeout: string, prefix: string, signature: string, nonce: number, txoHash?: Buffer): Promise<Transaction> {

        const ixs = await this.createPayWithAuthorizationIx(intermediary, data, timeout, prefix, signature, nonce, txoHash);
        const tx = new Transaction();
        for(let ix of ixs) {
            tx.add(ix);
        }
        return tx;

    }

    async createClaimIx(intermediary: PublicKey, data: AtomicSwapStruct, secret: Buffer): Promise<TransactionInstruction> {
        const expiryTimestamp = data.expiry;
        const currentTimestamp = Math.floor(Date.now() / 1000);

        console.log("[EVM.PaymentRequest] Expiry time: ", expiryTimestamp.toString());

        if (expiryTimestamp.sub(new BN(currentTimestamp)).lt(new BN(MIN_TIME_TO_CONFIRM))) {
            console.error("[EVM.PaymentRequest] Not enough time to reliably pay the invoice");
            throw new Error("Not enough time to reliably pay the invoice");
        }

        const ata = getAssociatedTokenAddressSync(this.WBTC_ADDRESS, data.intermediary);

        const claimIx = await this.program.methods
            .claimerClaimPayOut(secret)
            .accounts({
                signer: data.intermediary,
                claimer: data.intermediary,
                claimerReceiveTokenAccount: ata,
                offerer: intermediary,
                initializer: data.intermediary,
                escrowState: this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex")),
                vault: this.vaultKey,
                vaultAuthority: this.vaultAuthorityKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

        return claimIx;

    }

    async createClaimTx(intermediary: PublicKey, data: AtomicSwapStruct, secret: Buffer): Promise<Transaction> {
        const claimIx = await this.createClaimIx(intermediary, data, secret);

        const ata = getAssociatedTokenAddressSync(this.WBTC_ADDRESS, data.intermediary);

        const tx = new Transaction();
        try {
            const fetched = await getAccount(this.provider.connection, ata);
        } catch (e) {
            const initATAix = createAssociatedTokenAccountInstruction(
                data.intermediary,
                ata,
                data.intermediary,
                this.WBTC_ADDRESS
            );
            tx.add(initATAix);
        }
        tx.add(claimIx);

        return tx;
    }

    async createClaimTxs(intermediary: PublicKey, data: AtomicSwapStruct, txId: string, vout: number): Promise<Transaction[]> {
        const reversedTxId = Buffer.from(txId, "hex").reverse();

        const merkleProof = await ChainUtils.getTransactionProof(txId);
        const btcBlockhash = await ChainUtils.getBlockHash(merkleProof.block_height);

        const btcRelayResponse = await this.btcRelay.retrieveBlockLogAndBlockheight(btcBlockhash);

        const requiredBlockheight = merkleProof.block_height+data.confirmations-1;

        const txs: Transaction[] = [];

        let commitedHeader = btcRelayResponse.header;
        if(btcRelayResponse.height<requiredBlockheight) {
            //Need to synchronize
            const resp = await this.btcRelaySynchronizer.syncToLatestTxs();
            resp.txs.forEach(tx => txs.push(tx));
            console.log("BTC Relay not synchronized to required blockheight, synchronizing ourselves in "+resp.txs.length+" txs");
            console.log("BTC Relay computed header map: ",resp.computedHeaderMap);
            if(commitedHeader==null) {
                //Retrieve computed header
                commitedHeader = resp.computedHeaderMap[merkleProof.block_height];
            }
        }

        console.log("Target commit header ", commitedHeader);

        const swapDataKey = this.getSwapDataKey(reversedTxId, data.intermediary);

        const fetchedDataAccount = await this.getData(swapDataKey);
        if(fetchedDataAccount!=null) {
            console.log("Will erase previous data account");
            const eraseTx = await this.createCloseDataTx(reversedTxId, data.intermediary);
            txs.push(eraseTx);
        }

        const rawTxBuffer = await ChainUtils.getRawTransaction(txId);

        const writeData: Buffer = Buffer.concat([
            Buffer.from(new BN(vout).toArray("le", 4)),
            rawTxBuffer
        ]);

        let pointer = 0;
        while(pointer<writeData.length) {
            const writeLen = Math.min(writeData.length-pointer, 1000);

            const writeTx = await this.createWriteDataTx(reversedTxId, data.intermediary, writeData.length, writeData.slice(pointer, writeLen));
            txs.push(writeTx);

            pointer += writeLen;
        }

        const reversedMerkleProof: Buffer[] = merkleProof.merkle.map((e) => Buffer.from(e, "hex").reverse());

        const ata = getAssociatedTokenAddressSync(this.WBTC_ADDRESS, data.intermediary);

        const verifyIx = await this.btcRelay.createVerifyIx(reversedTxId, data.confirmations, merkleProof.pos, reversedMerkleProof, commitedHeader);
        const claimIx = await this.program.methods
            .claimerClaimPayOutWithExtData(reversedTxId)
            .accounts({
                signer: data.intermediary,
                offerer: intermediary,
                claimerReceiveTokenAccount: ata,
                escrowState: this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex")),
                vault: this.vaultKey,
                data: swapDataKey,
                vaultAuthority: this.vaultAuthorityKey,
                systemProgram: SystemProgram.programId,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

        const claimTx = new Transaction();
        claimTx.add(verifyIx);
        claimTx.add(claimIx);

        txs.push(claimTx);

        return txs;

    }

    /*createRejectTx(intermediary: PublicKey, data: AtomicSwapStruct): Promise<Transaction> {

        const expiryTimestamp = data.expiry;
        const currentTimestamp = Math.floor(Date.now() / 1000);

        console.log("[EVM.PaymentRequest] Expiry time: ", expiryTimestamp.toString());

        if (expiryTimestamp.sub(new BN(currentTimestamp)).lt(new BN(MIN_TIME_TO_CONFIRM))) {
            console.error("[EVM.PaymentRequest] Not enough time to reliably reject the invoice");
            throw new Error("Not enough time to reliably reject the invoice");
        }

        return this.program.methods
            .claimerRefundPayer()
            .accounts({
                claimer: data.intermediary,
                initializerDepositTokenAccount: this.getUserVaultKey(intermediary),
                offerer: intermediary,
                initializer: data.intermediary,
                escrowState: this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex")),
                vault: this.vaultKey,
                vaultAuthority: this.vaultAuthorityKey,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .transaction();

    }*/

    createCloseDataIx(reversedTxId: Buffer, wallet: PublicKey): Promise<TransactionInstruction> {

        return this.program.methods
            .closeData(reversedTxId)
            .accounts({
                signer: wallet,
                data: this.getSwapDataKey(reversedTxId, wallet)
            })
            .instruction();

    }

    async createCloseDataTx(reversedTxId: Buffer, wallet: PublicKey): Promise<Transaction> {
        const claimIx = await this.createCloseDataIx(reversedTxId, wallet);

        const tx = new Transaction();
        tx.add(claimIx);

        return tx;
    }

    createWriteDataIx(reversedTxId: Buffer, wallet: PublicKey, len: number, slice: Buffer): Promise<TransactionInstruction> {
        return this.program.methods
            .writeData(reversedTxId, len, slice)
            .accounts({
                signer: wallet,
                data: this.getSwapDataKey(reversedTxId, wallet),
                systemProgram: SystemProgram.programId
            })
            .instruction();
    }

    async createWriteDataTx(reversedTxId: Buffer, wallet: PublicKey, len: number, slice: Buffer): Promise<Transaction> {
        const claimIx = await this.createWriteDataIx(reversedTxId, wallet, len, slice);

        const tx = new Transaction();
        tx.add(claimIx);

        return tx;
    }

}

export default BTCLNtoSol;