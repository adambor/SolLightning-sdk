import {AnchorProvider, BN, Wallet} from "@coral-xyz/anchor";
import {bs58} from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {Connection, Keypair, PublicKey} from "@solana/web3.js";
import {BTCLNtoSolSwap, SolanaChains, SolanaSwapData, SolanaSwapper, SoltoBTCLNSwap} from "sollightning-sdk";
import {createNodeJSSwapperOptions} from "sollightning-sdk/dist/NodeJSSwapperOptions";

const _solanaRpcUrl = "https://api.mainnet-beta.solana.com";
const _privateKey = "<fill in your private key here>";

let _network;
let swapper;

async function initialize() {
    ///////////////////////////////////////////////
    /////////////// Initialization ////////////////
    ///////////////////////////////////////////////

    //Creating a wallet and connection from scratch
    const signer = Keypair.fromSecretKey(bs58.decode(_privateKey)); //Or Keypair.generate() to generate new one
    const wallet = new Wallet(signer);
    const connection = new Connection(_solanaRpcUrl, "confirmed");

    //Create anchor provider
    const anchorProvider = new AnchorProvider(connection, wallet, {preflightCommitment: "confirmed"});

    //Defines max swap price difference to the current market price as fetched from CoinGecko API tolerance in PPM (1000000 = 100%)
    const _swapDifferenceTolerance = new BN(2500); //Max allowed difference 0.25%

    //Set swapper options
    _network = "DEVNET"; //"DEVNET" or "MAINNET"

    //For NodeJS environment (using filesystem storage)
    const _options = createNodeJSSwapperOptions(_network, _swapDifferenceTolerance); //import from "sollightning-sdk/dist/NodeJSSwapperOptions"

    //Create the swapper instance
    swapper = new SolanaSwapper(anchorProvider, _options);
    //Initialize the swapper
    await swapper.init();
}

async function payViaLNURL() {
    //////////////////////////////////////////////////////
    /// Swap Solana -> Bitcoin lightning (using LNURL) ///
    //////////////////////////////////////////////////////

    const _useToken: string = SolanaChains[_network].tokens.WSOL; //Token to swap from
    const _lnurlOrIdentifier: string = "lnurl1dp68gurn8ghj7ampd3kx2ar0veekzar0wd5xjtnrdakj7tnhv4kxctttdehhwm30d3h82unvwqhkx6rfvdjx2ctvxyesuk0a27"; //Destination LNURL-pay or readable identifier
    const _amount: BN = new BN(1000); //Amount of satoshis to send (1 BTC = 100 000 000 satoshis)
    const _comment: (string | null) = "Hello, Lightning!"; //Optional comment for the payment

    //Create the swap: swapping _useToken to Bitcoin lightning network, sending _amount of satoshis to _lnurlOrIdentifier
    console.log("Creating swap...");
    const swap: SoltoBTCLNSwap<SolanaSwapData> = await swapper.createSolToBTCLNSwapViaLNURL(new PublicKey(_useToken), _lnurlOrIdentifier, _amount, _comment);

    //Get the amount required to pay and fee
    const amountToBePaid: BN = swap.getInAmount(); //Amount to be paid in the SPL token on Solana (including fee), in base units (no decimals)
    const fee: BN = swap.getFee(); //Swap fee paid in the SPL token on Solana (already included in the getInAmount()), in base units (no decimals)

    console.log("Paying amount: ", amountToBePaid.toString());
    console.log("Fee: ", fee.toString());

    //Get swap expiration time
    const expiry: number = swap.getExpiry(); //Expiration time of the swap in UNIX milliseconds, swap needs to be initiated before this time

    //Initiate and pay for the swap
    console.log("Swap committing...");
    await swap.commit();
    console.log("Swap committed...");

    //Wait for the swap to conclude
    const result: boolean = await swap.waitForPayment();
    console.log("Payment result: ", result);
    if(!result) {
        //Swap failed, money can be refunded
        await swap.refund();
    } else {
        //Swap successful
        if(swap.hasSuccessAction()) {
            //Contains a success action that should displayed to the user
            const successMessage = swap.getSuccessAction();
            const description: string = successMessage.description; //Description of the message
            const text: (string | null) = successMessage.text; //Main text of the message
            const url: (string | null) = successMessage.url; //URL link which should be displayed
        }
    }
}

async function receiveLN() {
    const _useToken: string = SolanaChains[_network].tokens.WSOL; //Token to swap from
    const _amount: BN = new BN(1000); //Amount of satoshis to receive (1 BTC = 100 000 000 satoshis)

    //Create the swap: swapping _amount of satoshis from Bitcoin lightning network to _useToken
    const swap: BTCLNtoSolSwap<SolanaSwapData> = await swapper.createBTCLNtoSolSwap(new PublicKey(_useToken), _amount);

    //Get the bitcoin lightning network invoice (the invoice contains pre-entered amount)
    const receivingLightningInvoice: string = swap.getAddress();
    //Get the QR code (contains the lightning network invoice)
    const qrCodeData: string = swap.getQrData(); //Data that can be displayed in the form of QR code

    //Get the amount we will receive on Solana
    const amountToBeReceivedOnSolana: BN = swap.getOutAmount(); //Get the amount we will receive on Solana (excluding fee), in base units (no decimals)
    const fee: BN = swap.getFee(); //Swap fee paid in the SPL token on Solana, in base units (no decimals)

    console.log("Receiving amount: ", amountToBeReceivedOnSolana.toString());
    console.log("Fee: ", fee.toString());

    console.log("RECEIVING LN INVOICE: ", receivingLightningInvoice);

    try {
        //Wait for the payment to arrive
        await swap.waitForPayment();
        //Claim the swap funds
        await swap.commitAndClaim();
    } catch(e) {
        //Error occurred while waiting for payment
    }
}

async function main() {
    await initialize();

    //await payViaLNURL();

    await receiveLN();

    await swapper.stop();
}

main();