import * as bolt11 from "bolt11";

import fetch, {Response} from "cross-fetch";
import {
    Ed25519Program,
    PublicKey,
    SystemProgram,
    SYSVAR_INSTRUCTIONS_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    Transaction, TransactionInstruction
} from "@solana/web3.js";
import {AnchorProvider, BN, Program} from "@project-serum/anchor";
import {programIdl} from "../contracts/programIdl";
import {getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {sign} from "tweetnacl";
import Utils from "../../Utils";
import {Bitcoin, ConstantSoltoBTC, ConstantSoltoBTCLN} from "../../Constants";
import * as bitcoin from "bitcoinjs-lib";
import {createHash, randomBytes} from "crypto-browserify";
import ChainUtils, {BitcoinTransaction} from "../../ChainUtils";

const timeoutPromise = (timeoutSeconds) => {
    return new Promise(resolve => {
        setTimeout(resolve, timeoutSeconds*1000)
    });
};

export type PaymentRequestStruct = {
    intermediary: PublicKey,
    token: PublicKey,
    amount: BN,
    paymentHash: string,
    expiry: BN
};

export const PaymentRequestStatus = {
    EXPIRED: 0,
    NOT_FOUND: 1,
    PAYING: 2,
    PAID: 3,
    REFUNDABLE: 4
};

const WBTC_ADDRESS = Bitcoin.wbtcToken;

const STATE_SEED = "state";
const VAULT_SEED = "vault";
const USER_VAULT_SEED = "uservault";
const AUTHORITY_SEED = "authority";

class SoltoBTCLN {

    static paymentRequestToStruct(data: PaymentRequestStruct) {
        return [
            data.intermediary,
            data.token,
            data.amount,
            data.paymentHash,
            data.expiry
        ];
    }

    provider: AnchorProvider;
    program: Program;
    vaultAuthorityKey: PublicKey;
    vaultKey: PublicKey;

    constructor(provider: AnchorProvider) {
        this.provider = provider;
        this.program = new Program(programIdl, programIdl.metadata.address, this.provider);
        this.vaultAuthorityKey = PublicKey.findProgramAddressSync(
            [Buffer.from(AUTHORITY_SEED)],
            this.program.programId
        )[0];
        this.vaultKey = PublicKey.findProgramAddressSync(
            [Buffer.from(VAULT_SEED), WBTC_ADDRESS.toBuffer()],
            this.program.programId
        )[0];
    }

    getUserVaultKey(wallet: PublicKey) {
        return PublicKey.findProgramAddressSync(
            [Buffer.from(USER_VAULT_SEED), wallet.toBuffer(), WBTC_ADDRESS.toBuffer()],
            this.program.programId
        )[0];
    }

    getEscrowStateKey(hash: Buffer) {
        console.log("getEscrowStateKey:", hash);
        return PublicKey.findProgramAddressSync(
            [Buffer.from(STATE_SEED), hash],
            this.program.programId
        )[0];
    }

    async getBalance(address: PublicKey): Promise<BN> {
        const ata = getAssociatedTokenAddressSync(WBTC_ADDRESS, address);

        try {
            const account = await getAccount(this.provider.connection, ata);
            return new BN(account.amount.toString());
        } catch (e) {
            return new BN(0);
        }
    }

    static isExpired(data: PaymentRequestStruct) {
        const currentTimestamp = new BN(Math.floor(Date.now()/1000)-ConstantSoltoBTCLN.refundGracePeriod);

        const isExpired = data.expiry.lt(currentTimestamp);

        return isExpired;
    }

    private static isValidAuthorization(address: PublicKey, data: PaymentRequestStruct, timeout: string, prefix: string, signature: string) {

        const expiryTimestamp = new BN(timeout);
        const currentTimestamp = new BN(Math.floor(Date.now() / 1000));

        const isExpired = expiryTimestamp.sub(currentTimestamp).lt(new BN(ConstantSoltoBTCLN.authorizationGracePeriod));

        if (isExpired) {
            throw new Error("Authorization expired!");
        }

        const messageBuffers = [
            Buffer.from(prefix, "ascii"),
            Buffer.from(data.amount.toArray("le", 8)),
            Buffer.from(data.expiry.toArray("le", 8)),
            Buffer.from(data.paymentHash, "hex"),
            Buffer.from(expiryTimestamp.toArray("le", 8)),
        ];

        const signatureBuffer = Buffer.from(signature, "hex");
        const messageBuffer = Buffer.concat(messageBuffers);

        if(!sign.detached.verify(messageBuffer, signatureBuffer, data.intermediary.toBuffer())) {
            throw new Error("Invalid signature!");
        }

        return messageBuffer;

    }

    async getCommitStatus(address: PublicKey, data: PaymentRequestStruct): Promise<number> {

        const escrowStateKey = this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex"));
        try {
            const escrowState: any = await this.program.account.escrowState.fetch(escrowStateKey);

            console.log("Escrow state: ", escrowState);
            console.log("Data: ", data);

            if(
                !escrowState.offerer.equals(address) ||
                !escrowState.claimer.equals(data.intermediary) ||
                !escrowState.mint.equals(data.token) ||
                !escrowState.initializerAmount.eq(data.amount) ||
                !escrowState.expiry.eq(data.expiry)
            ) {
                if(SoltoBTCLN.isExpired(data)) {
                    return PaymentRequestStatus.EXPIRED;
                }

                return PaymentRequestStatus.NOT_FOUND;
            }

            if(SoltoBTCLN.isExpired(data)) {
                return PaymentRequestStatus.REFUNDABLE;
            }
            return PaymentRequestStatus.PAYING;
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
                            return PaymentRequestStatus.PAID;
                        }
                        if(ix.name==="offererRefund" || ix.name==="offererRefundPayOut" || ix.name==="offererRefundWithSignature" || ix.name==="offererRefundWithSignaturePayOut") {
                            if(SoltoBTCLN.isExpired(data)) {
                                return PaymentRequestStatus.EXPIRED;
                            }

                            return PaymentRequestStatus.NOT_FOUND;
                        }
                    }
                }
            }

            if(SoltoBTCLN.isExpired(data)) {
                return PaymentRequestStatus.EXPIRED;
            }

            return PaymentRequestStatus.NOT_FOUND;
        }

    }

    async getPaymentHashStatus(paymentHash: string): Promise<number> {
        //Check if is commited
        const escrowStateKey = this.getEscrowStateKey(Buffer.from(paymentHash, "hex"));
        try {
            const escrowState = await this.program.account.escrowState.fetch(escrowStateKey);
            if(escrowState!=null) return PaymentRequestStatus.PAYING;
        } catch (e) {
            console.log(e);
        }

        //Check if paid or what
        const signatures = await this.provider.connection.getSignaturesForAddress(escrowStateKey, {
            limit: 500
        });

        for(let sig of signatures) {
            const tx = await this.provider.connection.getTransaction(sig.signature);
            if(tx.meta.err==null) {
                const instructions = Utils.decodeInstructions(tx.transaction.message);
                for(let ix of instructions) {
                    if(ix.name==="claimerClaim" || ix.name==="claimerClaimPayOut") {
                        return PaymentRequestStatus.PAID;
                    }
                    if(ix.name==="offererRefund" || ix.name==="offererRefundPayOut" || ix.name==="offererRefundWithSignature" || ix.name==="offererRefundWithSignaturePayOut") {
                        return PaymentRequestStatus.NOT_FOUND;
                    }
                }
            }
        }

        return PaymentRequestStatus.NOT_FOUND;
    }

    async isRequestRefundable(address: PublicKey, data: PaymentRequestStruct): Promise<boolean> {

        const currentTimestamp = new BN(Math.floor(Date.now()/1000)-ConstantSoltoBTCLN.refundGracePeriod);

        const isExpired = data.expiry.lt(currentTimestamp);

        if(!isExpired) return false;

        const escrowStateKey = this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex"));
        try {
            const escrowState: any = await this.program.account.escrowState.fetch(escrowStateKey);

            if(
                !escrowState.offerer.equals(address) ||
                !escrowState.claimer.equals(data.intermediary) ||
                !escrowState.mint.equals(data.token) ||
                !escrowState.initializerAmount.eq(data.amount) ||
                !escrowState.expiry.eq(data.expiry)
            ) {
                return false;
            }

            return true;
        } catch (e) {
            console.log(e);
            return false;
        }

    }

    async isCommitted(address: PublicKey, data: PaymentRequestStruct): Promise<boolean> {
        const escrowStateKey = this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex"));
        try {
            const escrowState: any = await this.program.account.escrowState.fetch(escrowStateKey);

            if(
                !escrowState.offerer.equals(address) ||
                !escrowState.claimer.equals(data.intermediary) ||
                !escrowState.mint.equals(data.token) ||
                !escrowState.initializerAmount.eq(data.amount) ||
                !escrowState.expiry.eq(data.expiry)
            ) {
                return false;
            }

            return true;
        } catch (e) {
            console.log(e);
            return false;
        }
    }

    static getHashForOnchain(outputScript: Buffer, amount: BN, nonce: BN): Buffer {
        console.log("Buffer: ", outputScript);
        console.log("amount: ", amount);
        console.log("nonce: ", nonce);
        return createHash("sha256").update(Buffer.concat([
            Buffer.from(nonce.toArray("le", 8)),
            Buffer.from(amount.toArray("le", 8)),
            outputScript
        ])).digest();
    }

    async payOnchain(address: string, amount: BN, confirmationTarget: number, confirmations: number, url: string): Promise<{
        address: PublicKey,
        networkFee: BN,
        swapFee: BN,
        totalFee: BN,
        total: BN,
        minRequiredExpiry: BN,
        offerExpiry: number,
        data: PaymentRequestStruct,
        nonce: BN
    }> {
        const firstPart = new BN(Math.floor((Date.now()/1000)) - 700000000);

        const nonceBuffer = Buffer.concat([
            Buffer.from(firstPart.toArray("be", 5)),
            randomBytes(3)
        ]);

        const nonce = new BN(nonceBuffer, "be");

        let outputScript;
        try {
            outputScript = bitcoin.address.toOutputScript(address, ConstantSoltoBTC.network);
        } catch (e) {
            throw new Error("Invalid address specified");
        }

        const hash = SoltoBTCLN.getHashForOnchain(outputScript, amount, nonce).toString("hex");

        console.log("Generated hash: ", hash);

        const payStatus = await this.getPaymentHashStatus(hash);

        if(payStatus!==PaymentRequestStatus.NOT_FOUND) {
            throw new Error("Invoice already being paid for or paid");
        }

        const response: Response = await fetch(url+"/payInvoice", {
            method: "POST",
            body: JSON.stringify({
                address,
                amount: amount.toString(10),
                confirmationTarget,
                confirmations,
                nonce: nonce.toString(10)
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

        const total = new BN(jsonBody.data.total);
        const expiryTimestamp = new BN(jsonBody.data.minRequiredExpiry);

        return {
            address: new PublicKey(jsonBody.data.address),
            networkFee: new BN(jsonBody.data.networkFee),
            swapFee: new BN(jsonBody.data.swapFee),
            totalFee: new BN(jsonBody.data.totalFee),
            total: total,
            minRequiredExpiry: expiryTimestamp,
            offerExpiry: jsonBody.data.offerExpiry,
            nonce,
            data: {
                intermediary: new PublicKey(jsonBody.data.address),
                token: WBTC_ADDRESS,
                amount: total,
                paymentHash: hash,
                expiry: expiryTimestamp
            }
        }

    }

    async createChainPayIx(address: PublicKey, data: PaymentRequestStruct, confirmations: number, nonce: BN): Promise<TransactionInstruction> {
        const payStatus = await this.getPaymentHashStatus(data.paymentHash);

        if(payStatus!==PaymentRequestStatus.NOT_FOUND) {
            throw new Error("Invoice already being paid for or paid");
        }

        const paymentHash = Buffer.from(data.paymentHash, "hex");

        const ata = getAssociatedTokenAddressSync(WBTC_ADDRESS, address);

        console.log("Authority key: ", this.vaultAuthorityKey);

        const ix = await this.program.methods
            .offererInitializePayIn(data.amount, data.expiry, paymentHash, new BN(2), new BN(confirmations), nonce)
            .accounts({
                initializer: address,
                initializerDepositTokenAccount: ata,
                claimer: data.intermediary,
                escrowState: this.getEscrowStateKey(paymentHash),
                vault: this.vaultKey,
                vaultAuthority: this.vaultAuthorityKey,
                mint: WBTC_ADDRESS,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                tokenProgram: TOKEN_PROGRAM_ID
            })
            .instruction();

        console.log("IX: ", ix);

        return ix;
    }

    async createChainPayTx(address: PublicKey, data: PaymentRequestStruct, confirmations: number, nonce: BN): Promise<Transaction> {
        const ix = await this.createChainPayIx(address, data, confirmations, nonce);
        return new Transaction().add(ix);
    }


    async payBOLT11PaymentRequest(bolt11PayReq: string, expirySeconds: number, maxFee: BN, url: string): Promise<{
        confidence: string,
        address: PublicKey,
        swapFee: BN,
        data: PaymentRequestStruct
    }> {

        const parsedPR = bolt11.decode(bolt11PayReq);

        if(parsedPR.satoshis==null) {
            throw new Error("Must be an invoice with amount");
        }

        const payStatus = await this.getPaymentHashStatus(parsedPR.tagsObject.payment_hash);

        if(payStatus!==PaymentRequestStatus.NOT_FOUND) {
            throw new Error("Invoice already being paid for or paid");
        }

        const sats: BN = new BN(parsedPR.satoshis);

        const expiryTimestamp = (Math.floor(Date.now()/1000)+expirySeconds).toString();

        const response: Response = await fetch(url+"/payInvoice", {
            method: "POST",
            body: JSON.stringify({
                pr: bolt11PayReq,
                maxFee: maxFee.toString(),
                expiryTimestamp
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

        const swapFee = new BN(jsonBody.data.swapFee);

        return {
            confidence: jsonBody.data.confidence,
            address: new PublicKey(jsonBody.data.address),
            swapFee: swapFee,
            data: {
                intermediary: new PublicKey(jsonBody.data.address),
                token: WBTC_ADDRESS,
                amount: sats.add(maxFee).add(swapFee),
                paymentHash: parsedPR.tagsObject.payment_hash,
                expiry: new BN(expiryTimestamp)
            }
        }

    }

    async createPayIx(address: PublicKey, data: PaymentRequestStruct): Promise<TransactionInstruction> {
        const payStatus = await this.getPaymentHashStatus(data.paymentHash);

        if(payStatus!==PaymentRequestStatus.NOT_FOUND) {
            throw new Error("Invoice already being paid for or paid");
        }

        const paymentHash = Buffer.from(data.paymentHash, "hex");

        const ata = getAssociatedTokenAddressSync(WBTC_ADDRESS, address);

        const ix = await this.program.methods
            .offererInitializePayIn(data.amount, data.expiry, paymentHash, new BN(0), new BN(0), new BN(0))
            .accounts({
                initializer: address,
                initializerDepositTokenAccount: ata,
                claimer: data.intermediary,
                escrowState: this.getEscrowStateKey(paymentHash),
                vault: this.vaultKey,
                vaultAuthority: this.vaultAuthorityKey,
                mint: WBTC_ADDRESS,
                systemProgram: SystemProgram.programId,
                rent: SYSVAR_RENT_PUBKEY,
                tokenProgram: TOKEN_PROGRAM_ID
            })
            .instruction();

        console.log("IX: ", ix);

        return ix;
    }

    async createPayTx(address: PublicKey, data: PaymentRequestStruct): Promise<Transaction> {
        const ix = await this.createPayIx(address, data);
        return new Transaction().add(ix);
    }

    async getRefundAuthorization(address: PublicKey, data: PaymentRequestStruct, url: string, nonce?: BN): Promise<{
        is_paid: boolean,
        txId?: string,
        secret?: string,
        prefix?: string,
        timeout?: string,
        signature?: string
    }> {

        const response: Response = await fetch(url+"/getRefundAuthorization", {
            method: "POST",
            body: JSON.stringify({
                paymentHash: data.paymentHash
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

        if(jsonBody.code===20007) {
            //Not found
            return null;
        }

        if(jsonBody.code===20008) {
            //In-flight
            return null;
        }

        if(jsonBody.code===20006) {
            //Already paid
            let txId = null;
            let secret = null;
            if(jsonBody.data!=null) {
                txId = jsonBody.data.txId;
                secret = jsonBody.data.secret;
            }

            if(txId!=null) {
                const btcTx = await ChainUtils.getTransaction(txId).catch(e => console.error(e));
                if(btcTx==null) {
                    console.log("BTC tx not found yet!");
                    return null;
                }

                const paymentHashBuffer = Buffer.from(data.paymentHash, "hex");

                const foundVout = (btcTx as BitcoinTransaction).vout.find(e =>
                    SoltoBTCLN.getHashForOnchain(Buffer.from(e.scriptpubkey, "hex"), new BN(e.value), nonce).equals(paymentHashBuffer));

                if(foundVout==null) {
                    console.error("Invalid btc txId returned, dishonest node?");
                    return null;
                }
            } else if(secret!=null) {

                const secretBuffer = Buffer.from(secret, "hex");
                const hash = createHash("sha256").update(secretBuffer).digest();

                const paymentHashBuffer = Buffer.from(data.paymentHash, "hex");

                if(!hash.equals(paymentHashBuffer)) {
                    console.error("Invalid payment secret returned, dishonest node?");
                    return null;
                }
            }

            return {
                is_paid: true,
                txId,
                secret
            };
        }

        if(jsonBody.code===20000) {
            //Success
            SoltoBTCLN.isValidAuthorization(address, data, jsonBody.data.timeout, jsonBody.data.prefix, jsonBody.data.signature);

            return {
                is_paid: false,
                prefix: jsonBody.data.prefix,
                timeout: jsonBody.data.timeout,
                signature: jsonBody.data.signature
            }
        }


    }

    async waitForRefundAuthorization(address: PublicKey, data: PaymentRequestStruct, url: string, abortSignal?: AbortSignal, intervalSeconds?: number, nonce?: BN): Promise<{
        is_paid: boolean,
        txId?: string,
        secret?: string,
        prefix?: string,
        timeout?: string,
        signature?: string
    }> {
        if(abortSignal!=null && abortSignal.aborted) {
            throw new Error("Aborted");
        }

        //const paymentHash = decodedPR.tagsObject.payment_hash;
        //const amount = ethers.BigNumber.from(decodedPR.millisatoshis).div(ethers.BigNumber.from(1000));

        while(abortSignal!=null && !abortSignal.aborted) {
            const result = await this.getRefundAuthorization(address, data, url, nonce);
            if(result!=null) return result;
            await timeoutPromise(intervalSeconds || 5);
        }

        throw new Error("Aborted");
    }

    async createRefundIx(address: PublicKey, data: PaymentRequestStruct, noCheck?: boolean): Promise<TransactionInstruction> {
        if(!noCheck) {
            if(!(await this.isRequestRefundable(address, data))) {
                throw new Error("Not refundable yet!");
            }
        }

        const ata = getAssociatedTokenAddressSync(WBTC_ADDRESS, address);

        const ix = await this.program.methods
            .offererRefundPayOut()
            .accounts({
                offerer: address,
                initializer: address,
                vault: this.vaultKey,
                vaultAuthority: this.vaultAuthorityKey,
                initializerDepositTokenAccount: ata,
                escrowState: this.getEscrowStateKey(Buffer.from(data.paymentHash, "hex")),
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .instruction();

        return ix;
    }

    async createRefundTx(address: PublicKey, data: PaymentRequestStruct, noCheck?: boolean): Promise<Transaction> {
        const ix = await this.createRefundIx(address, data, noCheck);
        return new Transaction().add(ix);
    }

    async createRefundTxWithAuthorizationIx(address: PublicKey, data: PaymentRequestStruct, timeout: string, prefix: string, signature: string, noCheck?: boolean): Promise<TransactionInstruction[]> {
        if(!noCheck) {
            if(!(await this.isCommitted(address, data))) {
                throw new Error("Not correctly committed");
            }
        }

        const messageBuffer = SoltoBTCLN.isValidAuthorization(address, data, timeout, prefix, signature);

        const paymentHash = Buffer.from(data.paymentHash, "hex");
        const signatureBuffer = Buffer.from(signature, "hex");

        const ata = getAssociatedTokenAddressSync(WBTC_ADDRESS, address);

        let result = await this.program.methods
            .offererRefundWithSignaturePayOut(new BN(timeout), signatureBuffer)
            .accounts({
                offerer: address,
                initializer: address,
                claimer: data.intermediary,
                vault: this.vaultKey,
                vaultAuthority: this.vaultAuthorityKey,
                initializerDepositTokenAccount: ata,
                escrowState: this.getEscrowStateKey(paymentHash),
                tokenProgram: TOKEN_PROGRAM_ID,
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY
            })
            .instruction();

        const signatureVerificationInstruction = Ed25519Program.createInstructionWithPublicKey({
            message: messageBuffer,
            publicKey: data.intermediary.toBuffer(),
            signature: signatureBuffer
        });

        // console.log(signatureVerificationInstruction);

        return [
            signatureVerificationInstruction,
            result
        ];
    }

    async createRefundTxWithAuthorizationTx(address: PublicKey, data: PaymentRequestStruct, timeout: string, prefix: string, signature: string, noCheck?: boolean): Promise<Transaction> {

        const ixs = await this.createRefundTxWithAuthorizationIx(address, data, timeout, prefix, signature, noCheck);
        const tx = new Transaction();
        for(let ix of ixs) {
            tx.add(ix);
        }
        return tx;

    }

    //TODO: Not implemented yet because of a 10k max block range limitation on QuickNode RPCs
    async getPastConversions(address: string, startBlockHeight?: number): Promise<PaymentRequestStruct[]> {
        throw new Error("Not implemented");
        // const structs: PaymentRequestStruct[] = [];
        // return structs;
    }

}

export default SoltoBTCLN;