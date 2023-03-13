import BTCLNtoSolSwap from "./btclntosol/BTCLNtoSolSwap";
export default class LocalWrapperStorage {
    constructor(storageKey) {
        this.data = null;
        this.storageKey = storageKey;
    }
    loadIfNeeded() {
        if (this.data == null) {
            const completedTxt = window.localStorage.getItem(this.storageKey);
            if (completedTxt != null) {
                this.data = JSON.parse(completedTxt);
                if (this.data == null)
                    this.data = {};
            }
            else {
                this.data = {};
            }
        }
    }
    removeSwapData(swap) {
        this.loadIfNeeded();
        const paymentHash = swap.getPaymentHash().toString("hex");
        if (this.data[paymentHash] != null) {
            delete this.data[paymentHash];
            return this.save().then(() => true);
        }
        return Promise.resolve(false);
    }
    saveSwapData(swap) {
        this.loadIfNeeded();
        const paymentHash = swap.getPaymentHash().toString("hex");
        this.data[paymentHash] = swap.serialize();
        return this.save();
    }
    saveSwapDataArr(swapData) {
        this.loadIfNeeded();
        for (let swap of swapData) {
            const paymentHash = swap.getPaymentHash().toString("hex");
            this.data[paymentHash] = swap.serialize();
        }
        return this.save();
    }
    loadSwapData(wrapper) {
        this.loadIfNeeded();
        const returnObj = {};
        Object.keys(this.data).forEach(paymentHash => {
            returnObj[paymentHash] = new BTCLNtoSolSwap(wrapper, this.data[paymentHash]);
        });
        return Promise.resolve(returnObj);
    }
    save() {
        this.loadIfNeeded();
        window.localStorage.setItem(this.storageKey, JSON.stringify(this.data));
        return Promise.resolve();
    }
}
