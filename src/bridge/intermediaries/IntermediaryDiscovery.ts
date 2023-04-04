import Intermediary, {ServicesType} from "./Intermediary";
import fetch, {Response} from "cross-fetch";
import ClientSwapContract from "../swaps/ClientSwapContract";
import SwapData from "../swaps/SwapData";
import {randomBytes} from "crypto-browserify";
import SwapType from "../swaps/SwapType";
import * as BN from "bn.js";

export enum SwapHandlerType {
    TO_BTC = "TO_BTC",
    FROM_BTC = "FROM_BTC",
    TO_BTCLN = "TO_BTCLN",
    FROM_BTCLN = "FROM_BTCLN",
}

export type SwapHandlerInfoType = {
    swapFeePPM: number,
    swapBaseFee: number,
    min: number,
    max: number,
    data?: any
};

type InfoHandlerResponseEnvelope = {
    nonce: string,
    services: {
        [key in SwapHandlerType]?: SwapHandlerInfoType
    }
};

type InfoHandlerResponse = {
    address: string,
    envelope: string,
    signature: string
}

function swapHandlerTypeToSwapType(swapHandlerType: SwapHandlerType): SwapType {

    switch (swapHandlerType) {
        case SwapHandlerType.FROM_BTC:
            return SwapType.BTC_TO_SOL;
        case SwapHandlerType.TO_BTC:
            return SwapType.SOL_TO_BTC;
        case SwapHandlerType.FROM_BTCLN:
            return SwapType.BTCLN_TO_SOL;
        case SwapHandlerType.TO_BTCLN:
            return SwapType.SOL_TO_BTCLN;
    }

}
function getIntermediaryComparator(swapType: SwapType, swapAmount: BN) {

    if(swapType===SwapType.SOL_TO_BTC) {
        //TODO: Also take reputation into account
    }

    return (a: Intermediary, b: Intermediary): number => {
        const feeA = new BN(a.services[swapType].swapBaseFee).add(swapAmount.mul(new BN(a.services[swapType].swapFeePPM)).div(new BN(1000000)));
        const feeB = new BN(b.services[swapType].swapBaseFee).add(swapAmount.mul(new BN(b.services[swapType].swapFeePPM)).div(new BN(1000000)));

        return feeA.sub(feeB).toNumber();
    }

}

const REGISTRY_URL = "https://api.github.com/repos/adambor/SolLightning-registry/contents/registry.json?ref=main";
const BATCH_SIZE = 10;
const TIMEOUT = 3000;

class IntermediaryDiscovery<T extends SwapData> {

    intermediaries: Intermediary[];

    swapContract: ClientSwapContract<T>;

    constructor(swapContract: ClientSwapContract<T>) {
        this.swapContract = swapContract;
    }

    async getIntermediaryUrls(abortSignal?: AbortSignal): Promise<string[]> {

        const response: Response = await fetch(REGISTRY_URL, {
            method: "GET",
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

        const content = jsonBody.content.replace(new RegExp("\\n", "g"), "");
        console.log(content);

        const urls: string[] = JSON.parse(Buffer.from(content, "base64").toString());

        return urls;

    }

    async getNodeInfo(url: string, abortSignal?: AbortSignal, timeout?: number) : Promise<{address: string, info: InfoHandlerResponseEnvelope}> {

        const nonce = randomBytes(32).toString("hex");

        const createdAbortController = new AbortController();

        let timeoutTimer;
        if(timeout!=null) {
            timeoutTimer = setTimeout(() => {
                if(abortSignal!=null) abortSignal.onabort = null;
                createdAbortController.abort();
            }, timeout);
        }

        if(abortSignal!=null) {
            abortSignal.onabort = () => {
                if(timeoutTimer!=null) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
                createdAbortController.abort();
            }
        }

        const response: Response = await fetch(url+"/info", {
            method: "POST",
            body: JSON.stringify({
                nonce
            }),
            headers: {'Content-Type': 'application/json'},
            signal: createdAbortController.signal
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

        let jsonBody: InfoHandlerResponse = await response.json();
        const info: InfoHandlerResponseEnvelope = JSON.parse(jsonBody.envelope);

        if(nonce!==info.nonce) throw new Error("Invalid response - nonce");

        await this.swapContract.isValidDataSignature(Buffer.from(jsonBody.envelope), jsonBody.signature, jsonBody.address);

        console.log("Returned info: ", info);

        return {
            address: jsonBody.address,
            info
        };

    }

    async init(abortSignal?: AbortSignal) {

        this.intermediaries = [];

        const urls = await this.getIntermediaryUrls(abortSignal);

        const activeNodes: {
            url: string,
            address: string,
            info: InfoHandlerResponseEnvelope
        }[] = [];

        let promises = [];
        for(let url of urls) {
            promises.push(this.getNodeInfo(url).then((resp) => {
                activeNodes.push({
                    address: resp.address,
                    url,
                    info: resp.info,
                })
            }).catch(e => console.error(e)));
            if(promises.length>=BATCH_SIZE) {
                await Promise.all(promises);
                promises = [];
            }
        }

        await Promise.all(promises);

        for(let node of activeNodes) {
            //Fetch reputation
            try {
                const reputation = await this.swapContract.getIntermediaryReputation(node.address);

                const services: ServicesType = {};

                for(let key in node.info.services) {
                    services[swapHandlerTypeToSwapType(key as SwapHandlerType)] = node.info.services[key];
                }

                this.intermediaries.push(new Intermediary(node.url, node.address, services, reputation));
            } catch (e) {
                console.error(e);
            }
        }

        console.log("Swap intermediaries: ", this.intermediaries);

    }

    getSwapMinimum(swapType: SwapType): number {
        let min;
        this.intermediaries.forEach(intermediary => {
            const swapService = intermediary.services[swapType];
            if(swapService!=null) {
                min==null ? min = swapService.min : min = Math.min(min, swapService.min);
            }
        });
        return min;
    }

    getSwapMaximum(swapType: SwapType): number {
        let max;
        this.intermediaries.forEach(intermediary => {
            const swapService = intermediary.services[swapType];
            if(swapService!=null) {
                max==null ? max = swapService.max : max = Math.max(max, swapService.max);
            }
        });
        return max;
    }

    getSwapCandidates(swapType: SwapType, amount: BN, count: number): Intermediary[] {

        const candidates = this.intermediaries.filter(e => {
            const swapService = e.services[swapType];
            if(swapService==null) return false;
            if(amount.lt(new BN(swapService.min))) return false;
            if(amount.gt(new BN(swapService.max))) return false;
            return true;
        });

        candidates.sort(getIntermediaryComparator(swapType, amount));

        const result = [];

        for(let i=0;i<count && i<candidates.length;i++) {
            result.push(candidates[i]);
        }

        return result;

    }

}

export default IntermediaryDiscovery;