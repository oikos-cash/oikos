/*
-----------------------------------------------------------------
Depot contract.
-----------------------------------------------------------------
*/

pragma solidity 0.4.25;

import "openzeppelin-solidity/contracts/utils/ReentrancyGuard.sol";
import "./SelfDestructible.sol";
import "./Pausable.sol";
import "./SafeDecimalMath.sol";
import "./interfaces/ISynth.sol";
import "./interfaces/IERC20.sol";

/**
 * @title Depot Contract.
 */
contract Depot is SelfDestructible, Pausable, ReentrancyGuard {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    /* ========== STATE VARIABLES ========== */
    address public oksProxy;
    ISynth public synth;

    address SUSD = 0x6fe12d8ed302f0fc7829864a2286838b832fad2b;
    address USDT = 0xa614f803b6fd780986a42c78ec9c7f77e6ded13c;

    uint SUSD_DECIMALS = 18;
    uint USDT_DECIMALS = 6;

    // Address where the ether and Synths raised for selling OKS is transfered to
    // Any ether raised for selling Synths gets sent back to whoever deposited the Synths,
    // and doesn't have anything to do with this address.
    address public fundsWallet;

    /* Stores deposits from users. */
    struct USDTDeposit {
        // The user that made the deposit
        address user;
        // The amount (in USDT) that they deposited
        uint amount;
    }
    /* Stores deposits from users. */
    struct SUSDDeposit {
        // The user that made the deposit
        address user;
        // The amount (in Synths) that they deposited
        uint amount;
    }


    /* User deposits are sold on a FIFO (First in First out) basis. When users deposit
       synths with us, they get added this queue, which then gets fulfilled in order.
       Conceptually this fits well in an array, but then when users fill an order we
       end up copying the whole array around, so better to use an index mapping instead
       for gas performance reasons.

       The indexes are specified (inclusive, exclusive), so (0, 0) means there's nothing
       in the array, and (3, 6) means there are 3 elements at 3, 4, and 5. You can obtain
       the length of the "array" by querying depositEndIndex - depositStartIndex. All index
       operations use safeAdd, so there is no way to overflow, so that means there is a
       very large but finite amount of deposits this contract can handle before it fills up. */

    mapping(uint => USDTDeposit) public USDTdeposits;
    // The starting index of our queue inclusive
    uint public USDTdepositStartIndex;
    // The ending index of our queue exclusive
    uint public USDTdepositEndIndex;

    mapping(uint => SUSDDeposit) public SUSDdeposits;
    // The starting index of our queue inclusive
    uint public SUSDdepositStartIndex;
    // The ending index of our queue exclusive
    uint public SUSDdepositEndIndex;

    /* This is a convenience variable so users and dApps can just query how much sUSD
       we have available for purchase without having to iterate the mapping with a
       O(n) amount of calls for something we'll probably want to display quite regularly. */
    uint public USDTtotalSellableDeposits;
    uint public SUSDtotalSellableDeposits;

    // The minimum amount of USDT required to enter the FiFo queue
    uint public USDTminimumDepositAmount = 10 * SafeDecimalMath.unit() / 10**(SUSD_DECIMALS-USDT_DECIMALS);

    // The minimum amount of USDT required to enter the FiFo queue
    uint public SUSDminimumDepositAmount = 10 * SafeDecimalMath.unit();

    // If a user deposits a synth amount < the minimumDepositAmount the contract will keep
    // the total of small deposits which will not be sold on market and the sender
    // must call withdrawMyDepositedSynths() to get them back.
    mapping(address => uint) public USDTsmallDeposits;
    mapping(address => uint) public SUSDsmallDeposits;

    /**
     * @dev Constructor
     * @param _owner The owner of this contract.
     * @param _fundsWallet The recipient of TRX and Synths that are sent to this contract while exchanging.
     * @param _oksProxy The Synthetix Proxy contract we'll interact with for balances and transfers.
     * @param _synth The Synth contract we'll interact with for balances and sending.
     */
    constructor(
        // Ownable
        address _owner,

        // Funds Wallet
        address _fundsWallet,

        // Other contracts needed
        address _oksProxy,
        ISynth _synth
    )
        /* Owned is initialised in SelfDestructible */
        SelfDestructible(_owner)
        Pausable(_owner)
        public
    {
        fundsWallet = _fundsWallet;
        oksProxy = _oksProxy;
        synth = _synth;
    }

    /**
     * @notice Fallback function 
     */
    function ()
        external
        payable
    {
        fundsWallet.transfer(msg.value);
    }

    /**
     * @notice Exchange USDT to sUSD.
     */
    function exchangeUSDTForSynths(uint amount)
        public
        nonReentrant
        notPaused
        returns (
            uint // Returns the number of Synths (sUSD) received
        )
    {
        //require(amount <= maxUSDTpurchase, "amount above maxUSDTpurchase limit");
        uint usdtToSend;
        // The multiplication works here because exchangeRates().rateForCurrency(ETH) is specified in
        // 18 decimal places, just like our currency base.
        uint requestedToPurchase = amount * 10 ** (SUSD_DECIMALS-USDT_DECIMALS); //msg.value.multiplyDecimal(exchangeRates().rateForCurrency(ETH));
        uint remainingToFulfill = requestedToPurchase;

        // Iterate through our outstanding deposits and sell them one at a time.
        for (uint i = SUSDdepositStartIndex; remainingToFulfill > 0 && i < SUSDdepositEndIndex; i++) {
            SUSDDeposit memory deposit = SUSDdeposits[i];

            // If it's an empty spot in the queue from a previous withdrawal, just skip over it and
            // update the queue. It's already been deleted.
            if (deposit.user == address(0)) {
                SUSDdepositStartIndex = SUSDdepositStartIndex.add(1);
            } else {
                // If the deposit can more than fill the order, we can do this
                // without touching the structure of our queue.
                if (deposit.amount > remainingToFulfill) {
                    // Ok, this deposit can fulfill the whole remainder. We don't need
                    // to change anything about our queue we can just fulfill it.
                    // Subtract the amount from our deposit and total.
                    uint newAmount = deposit.amount.sub(remainingToFulfill);
                    SUSDdeposits[i] = SUSDDeposit({user: deposit.user, amount: newAmount});

                    SUSDtotalSellableDeposits = SUSDtotalSellableDeposits.sub(remainingToFulfill);
                    usdtToSend = remainingToFulfill / 10**(SUSD_DECIMALS-USDT_DECIMALS);

                    IERC20(USDT).transfer(deposit.user, usdtToSend);
                    emit ClearedDeposit(msg.sender, deposit.user, usdtToSend, remainingToFulfill, i);
                    IERC20(SUSD).transfer(msg.sender, remainingToFulfill);

                    // And we have nothing left to fulfill on this order.
                    remainingToFulfill = 0;
                } else if (deposit.amount <= remainingToFulfill) {
                    // We need to fulfill this one in its entirety and kick it out of the queue.
                    // Start by kicking it out of the queue.
                    // Free the storage because we can.
                    delete SUSDdeposits[i];
                    // Bump our start index forward one.
                    SUSDdepositStartIndex = SUSDdepositStartIndex.add(1);
                    // We also need to tell our total it's decreased
                    SUSDtotalSellableDeposits = SUSDtotalSellableDeposits.sub(deposit.amount);
                    usdtToSend = deposit.amount / 10**(SUSD_DECIMALS-USDT_DECIMALS);

                    IERC20(USDT).transfer(deposit.user, usdtToSend);
                    emit ClearedDeposit(msg.sender, deposit.user, usdtToSend, deposit.amount, i);
                    IERC20(SUSD).transfer(msg.sender, deposit.amount);

                    // And subtract the order from our outstanding amount remaining
                    // for the next iteration of the loop.
                    remainingToFulfill = remainingToFulfill.sub(deposit.amount);
                }
            }
        }

        // Ok, if we're here and 'remainingToFulfill' isn't zero, then
        // we need to refund the remainder of their ETH back to them.
        if (remainingToFulfill > 0) {
            IERC20(USDT).transfer(msg.sender, remainingToFulfill / 10**(SUSD_DECIMALS-USDT_DECIMALS));
        }

        // How many did we actually give them?
        uint fulfilled = requestedToPurchase.sub(remainingToFulfill);

        if (fulfilled > 0) {
            // Now tell everyone that we gave them that many (only if the amount is greater than 0).
            emit Exchange("USDT", msg.value, "sUSD", fulfilled);
        }

        return fulfilled;
    }

    /**
     * @notice Exchange USDT to sUSD.
     */
    function exchangeSynthsForUSDT(uint amount)
        public
        nonReentrant
        notPaused
        returns (
            uint // Returns the number of Synths (sUSD) received
        )
    {
        //require(amount <= maxUSDTpurchase, "amount above maxUSDTpurchase limit");
        uint susdToSend;
        uint requestedToPurchase = amount / 10 ** (SUSD_DECIMALS-USDT_DECIMALS);
        uint remainingToFulfill = requestedToPurchase;

        // Iterate through our outstanding deposits and sell them one at a time.
        for (uint i = USDTdepositStartIndex; remainingToFulfill > 0 && i < USDTdepositEndIndex; i++) {
            USDTDeposit memory deposit = USDTdeposits[i];

            // If it's an empty spot in the queue from a previous withdrawal, just skip over it and
            // update the queue. It's already been deleted.
            if (deposit.user == address(0)) {
                USDTdepositStartIndex = USDTdepositStartIndex.add(1);
            } else {
                // If the deposit can more than fill the order, we can do this
                // without touching the structure of our queue.
                if (deposit.amount > remainingToFulfill) {
                    // Ok, this deposit can fulfill the whole remainder. We don't need
                    // to change anything about our queue we can just fulfill it.
                    // Subtract the amount from our deposit and total.
                    uint newAmount = deposit.amount.sub(remainingToFulfill);
                    USDTdeposits[i] = USDTDeposit({user: deposit.user, amount: newAmount});

                    USDTtotalSellableDeposits = USDTtotalSellableDeposits.sub(remainingToFulfill);
                    susdToSend = remainingToFulfill * 10 ** (SUSD_DECIMALS-USDT_DECIMALS);

                    IERC20(SUSD).transfer(deposit.user, susdToSend);
                    emit ClearedDeposit(msg.sender, deposit.user, susdToSend, remainingToFulfill, i);
                    IERC20(USDT).transfer(msg.sender, remainingToFulfill);

                    // And we have nothing left to fulfill on this order.
                    remainingToFulfill = 0;
                } else if (deposit.amount <= remainingToFulfill) {
                    // We need to fulfill this one in its entirety and kick it out of the queue.
                    // Start by kicking it out of the queue.
                    // Free the storage because we can.
                    delete USDTdeposits[i];
                    // Bump our start index forward one.
                    USDTdepositStartIndex = USDTdepositStartIndex.add(1);
                    // We also need to tell our total it's decreased
                    USDTtotalSellableDeposits = USDTtotalSellableDeposits.sub(deposit.amount);

                    susdToSend = deposit.amount * 10 ** (SUSD_DECIMALS-USDT_DECIMALS);

                    IERC20(SUSD).transfer(deposit.user, susdToSend);
                    emit ClearedDeposit(msg.sender, deposit.user, susdToSend, deposit.amount, i);
                    IERC20(USDT).transfer(msg.sender, deposit.amount);

                    // And subtract the order from our outstanding amount remaining
                    // for the next iteration of the loop.
                    remainingToFulfill = remainingToFulfill.sub(deposit.amount);
                }
            }
        }

        // Ok, if we're here and 'remainingToFulfill' isn't zero, then
        // we need to refund the remainder of their ETH back to them.
        if (remainingToFulfill > 0) {
            IERC20(USDT).transfer(msg.sender, remainingToFulfill);
        }

        // How many did we actually give them?
        uint fulfilled = requestedToPurchase.sub(remainingToFulfill);

        if (fulfilled > 0) {
            // Now tell everyone that we gave them that many (only if the amount is greater than 0).
            emit Exchange("SUSD", msg.value, "USDT", fulfilled);
        }

        return fulfilled;
    }

    /**
     * @notice depositUSDT: Allows users to deposit USDT via the approve / transferFrom workflow
     * @param amount The amount of USDT you wish to deposit (must have been approved first)
     */
    function depositUSDT(uint amount)
        external
        returns (uint[2])
    {
        
        // Grab the amount of USDT. Will fail if not approved first
        IERC20(USDT).transferFrom(msg.sender, this, amount);

        // A minimum deposit amount is designed to protect purchasers from over paying
        // gas for fullfilling multiple small synth deposits
        if (amount < USDTminimumDepositAmount) {
            // We cant fail/revert the transaction or send the synths back in a reentrant call.
            // So we will keep your synths balance seperate from the FIFO queue so you can withdraw them
            USDTsmallDeposits[msg.sender] = USDTsmallDeposits[msg.sender].add(amount);
            emit USDTDepositNotAccepted(msg.sender, amount, USDTminimumDepositAmount);
        } else {
            // Ok, thanks for the deposit, let's queue it up.
            USDTdeposits[USDTdepositEndIndex] = USDTDeposit({ user: msg.sender, amount: amount });
            emit eUSDTDeposit(msg.sender, amount, USDTdepositEndIndex);

            // Walk our index forward as well.
            USDTdepositEndIndex = USDTdepositEndIndex.add(1);

            // And add it to our total.
            USDTtotalSellableDeposits = USDTtotalSellableDeposits.add(amount);

            //Swap USDT for SUSD
            if (SUSDtotalSellableDeposits >= amount * 10 ** (SUSD_DECIMALS-USDT_DECIMALS) ) {
                exchangeUSDTForSynths(amount);
            }
        }
        return [SUSDtotalSellableDeposits, amount * 10 ** (SUSD_DECIMALS-USDT_DECIMALS)];
    }


    /**
     * @notice depositUSDT: Allows users to deposit USDT via the approve / transferFrom workflow
     * @param amount The amount of USDT you wish to deposit (must have been approved first)
     */
    function depositSUSD(uint amount)
        external
        returns (uint[2])
    {
        
        // Grab the amount of USDT. Will fail if not approved first
        IERC20(SUSD).transferFrom(msg.sender, this, amount);

        // A minimum deposit amount is designed to protect purchasers from over paying
        // gas for fullfilling multiple small synth deposits
        if (amount < SUSDminimumDepositAmount) {
            // We cant fail/revert the transaction or send the synths back in a reentrant call.
            // So we will keep your synths balance seperate from the FIFO queue so you can withdraw them
            SUSDsmallDeposits[msg.sender] = SUSDsmallDeposits[msg.sender].add(amount);
            emit SUSDDepositNotAccepted(msg.sender, amount, SUSDminimumDepositAmount);
        } else {
            // Ok, thanks for the deposit, let's queue it up.
            SUSDdeposits[SUSDdepositEndIndex] = SUSDDeposit({ user: msg.sender, amount: amount });
            emit eSUSDDeposit(msg.sender, amount, SUSDdepositEndIndex);

            // Walk our index forward as well.
            SUSDdepositEndIndex = SUSDdepositEndIndex.add(1);

            // And add it to our total.
            SUSDtotalSellableDeposits = SUSDtotalSellableDeposits.add(amount);

            if (USDTtotalSellableDeposits >= amount / 10 ** (SUSD_DECIMALS-USDT_DECIMALS)) {
                exchangeSynthsForUSDT(amount);
            }
        }
        return [USDTtotalSellableDeposits, amount / 10 ** (SUSD_DECIMALS-USDT_DECIMALS)];
    }

    /**
     * @notice Allows the owner to withdraw OKS from this contract if needed.
     * @param amount The amount of OKS to attempt to withdraw (in 18 decimal places).
     */
    function withdrawOikos(uint amount)
        external
        onlyOwner
    {
        IERC20(oksProxy).transfer(owner, amount);

        // We don't emit our own events here because we assume that anyone
        // who wants to watch what the Depot is doing can
        // just watch ERC20 events from the Synth and/or Synthetix contracts
        // filtered to our address.
    }

    /**
     * @notice Allows a user to withdraw all of their previously deposited synths from this contract if needed.
     *         Developer note: We could keep an index of address to deposits to make this operation more efficient
     *         but then all the other operations on the queue become less efficient. It's expected that this
     *         function will be very rarely used, so placing the inefficiency here is intentional. The usual
     *         use case does not involve a withdrawal.
     */
    function withdrawMyDepositedUSDT()
        external
        returns (uint)
    {
        uint usdtToSend = 0;

        for (uint i = USDTdepositStartIndex; i < USDTdepositEndIndex; i++) {
            USDTDeposit memory deposit = USDTdeposits[i];

            if (deposit.user == msg.sender) {
                // The user is withdrawing this deposit. Remove it from our queue.
                // We'll just leave a gap, which the purchasing logic can walk past.
                usdtToSend = usdtToSend.add(deposit.amount);
                delete USDTdeposits[i];
                //Let the DApps know we've removed this deposit
                emit USDTDepositRemoved(deposit.user, deposit.amount, i);
            }
        }

        if (usdtToSend > 0) {
            // Update our total
            USDTtotalSellableDeposits = USDTtotalSellableDeposits.sub(usdtToSend);
        }

        // Check if the user has tried to send deposit amounts < the minimumDepositAmount to the FIFO
        // queue which would have been added to this mapping for withdrawal only
        usdtToSend = usdtToSend.add(USDTsmallDeposits[msg.sender]);
        USDTsmallDeposits[msg.sender] = 0;

        // If there's nothing to do then go ahead and revert the transaction
        require(usdtToSend > 0, "You have no deposits to withdraw.");

        // Send their deposits back to them (minus fees)
        IERC20(USDT).transfer(msg.sender, usdtToSend);

        emit USDTWithdrawal(msg.sender, usdtToSend);
        return usdtToSend;
    }

    function withdrawMyDepositedSUSD()
        external
        returns (uint)
    {
        uint susdToSend = 0;

        for (uint i = SUSDdepositStartIndex; i < SUSDdepositEndIndex; i++) {
            SUSDDeposit memory deposit = SUSDdeposits[i];

            if (deposit.user == msg.sender) {
                // The user is withdrawing this deposit. Remove it from our queue.
                // We'll just leave a gap, which the purchasing logic can walk past.
                susdToSend = susdToSend.add(deposit.amount);
                delete SUSDdeposits[i];
                //Let the DApps know we've removed this deposit
                emit SUSDDepositRemoved(deposit.user, deposit.amount, i);
            }
        }

        if (susdToSend > 0) {
            // Update our total
            SUSDtotalSellableDeposits = SUSDtotalSellableDeposits.sub(susdToSend);
        }

        // Check if the user has tried to send deposit amounts < the minimumDepositAmount to the FIFO
        // queue which would have been added to this mapping for withdrawal only
        susdToSend = susdToSend.add(SUSDsmallDeposits[msg.sender]);
        SUSDsmallDeposits[msg.sender] = 0;

        // If there's nothing to do then go ahead and revert the transaction
        require(susdToSend > 0, "You have no deposits to withdraw.");

        // Send their deposits back to them (minus fees)
        IERC20(SUSD).transfer(msg.sender, susdToSend);

        emit SUSDWithdrawal(msg.sender, susdToSend);
        return susdToSend;
    }
    /* ========== SETTERS ========== */

    /**
     * @notice Set the funds wallet where TRX raised is held
     * @param _fundsWallet The new address to forward TRX and Synths to
     */
    function setFundsWallet(address _fundsWallet)
        external
        onlyOwner
    {
        fundsWallet = _fundsWallet;
        emit FundsWalletUpdated(fundsWallet);
    }

    /**
     * @notice Set the sUSD contract
     * @param _synth The new synth contract target
     */
    function setSynth(ISynth _synth)
        external
        onlyOwner
    {
        synth = _synth;
        emit SynthUpdated(_synth);
    }

    /**
     * @notice Set the Synthetix Proxy contract
     * @param _oksProxy The new synthetix Proxy contract
     */
    function setOikos(address _oksProxy)
        external
        onlyOwner
    {
        oksProxy = _oksProxy;
        emit OikosUpdated(oksProxy);
    }

    event FundsWalletUpdated(address newFundsWallet);
    event SynthUpdated(ISynth newSynthContract);
    event OikosUpdated(address newOKSProxy);
    event Exchange(string fromCurrency, uint fromAmount, string toCurrency, uint toAmount);
    event USDTWithdrawal(address user, uint amount);
    event eUSDTDeposit(address indexed user, uint amount, uint indexed depositIndex);
    event USDTDepositRemoved(address indexed user, uint amount, uint indexed depositIndex);
    event USDTDepositNotAccepted(address user, uint amount, uint minimum);
    event SUSDWithdrawal(address user, uint amount);
    event eSUSDDeposit(address indexed user, uint amount, uint indexed depositIndex);
    event SUSDDepositRemoved(address indexed user, uint amount, uint indexed depositIndex);
    event SUSDDepositNotAccepted(address user, uint amount, uint minimum);    
    event MinimumDepositAmountUpdated(uint amount);
    event NonPayableContract(address indexed receiver, uint amount);
    event ClearedDeposit(address indexed fromAddress, address indexed toAddress, uint fromETHAmount, uint toAmount, uint indexed depositIndex);
}


