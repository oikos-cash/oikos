/*
-----------------------------------------------------------------
FILE INFORMATION
-----------------------------------------------------------------

file:       RewardsDistribution.sol
version:    1.0
author:     Clinton Ennis, Jackson Chan

date:       2019-08-12

-----------------------------------------------------------------
MODULE DESCRIPTION
-----------------------------------------------------------------

Distributes the inflationary supply rewards after they have been
minted.

DistributionData can be added to the distributions array simply
with an address and an amount of tokens to send to that address.

i.e. The sTRX arb pool is assigned 5% of the current Inflationary
supply so it is allocated 72K of the tokens. If that is the only
distribution added then 72K SNX is deducted from the weeks
inflationary supply and sent to the sTRX Arb Pool then the
remainder is sent to the RewardsEscrow Contract for the SNX
Staking Rewards.

RewardDistributions can be added, edited and removed.

-----------------------------------------------------------------
*/

pragma solidity 0.5.8;

import './Owned.sol';
import './SafeDecimalMath.sol';
import './interfaces/IERC20.sol';
import './interfaces/IFeePool.sol';

contract RewardsDistribution is Owned {
	using SafeMath for uint256;
	using SafeDecimalMath for uint256;

	/**
	 * @notice Authorised address able to call distributeRewards
	 */
	address public authority;

	/**
	 * @notice Address of the Synthetix ProxyERC20
	 */
	address public synthetixProxy;

	/**
	 * @notice Address of the RewardEscrow contract
	 */
	address public rewardEscrow;

	/**
	 * @notice Address of the FeePoolProxy
	 */
	address public feePoolProxy;

	/**
	 * @notice Stores an address and amount
	 * of the inflationary supply to sent to the address.
	 */
	struct DistributionData {
		address destination;
		uint256 amount;
	}

	/**
	 * @notice An array of addresses and amounts to send
	 */
	DistributionData[] public distributions;

	/**
	 * @dev _authority maybe the underlying synthetix contract.
	 * Remember to set the autority on a synthetix upgrade
	 */
	constructor(
		address _owner,
		address _authority,
		address _synthetixProxy,
		address _rewardEscrow,
		address _feePoolProxy
	) public Owned(_owner) {
		authority = _authority;
		synthetixProxy = _synthetixProxy;
		rewardEscrow = _rewardEscrow;
		feePoolProxy = _feePoolProxy;
	}

	// ========== EXTERNAL SETTERS ==========

	function setSynthetixProxy(address _synthetixProxy) external onlyOwner {
		synthetixProxy = _synthetixProxy;
	}

	function setRewardEscrow(address _rewardEscrow) external onlyOwner {
		rewardEscrow = _rewardEscrow;
	}

	function setFeePoolProxy(address _feePoolProxy) external onlyOwner {
		feePoolProxy = _feePoolProxy;
	}

	/**
	 * @notice Set the address of the contract authorised to call distributeRewards()
	 * @param _authority Address of the authorised calling contract.
	 */
	function setAuthority(address _authority) external onlyOwner {
		authority = _authority;
	}

	// ========== EXTERNAL FUNCTIONS ==========

	/**
	 * @notice Adds a Rewards DistributionData struct to the distributions
	 * array. Any entries here will be iterated and rewards distributed to
	 * each address when tokens are sent to this contract and distributeRewards()
	 * is called by the autority.
	 * @param destination An address to send rewards tokens too
	 * @param amount The amount of rewards tokens to send
	 */
	function addRewardDistribution(address destination, uint256 amount)
		external
		onlyOwner
		returns (bool)
	{
		require(destination != address(0), 'Cant add a zero address');
		require(amount != 0, 'Cant add a zero amount');

		DistributionData memory rewardsDistribution = DistributionData(destination, amount);
		distributions.push(rewardsDistribution);

		emit RewardDistributionAdded(distributions.length - 1, destination, amount);
		return true;
	}

	/**
	 * @notice Deletes a RewardDistribution from the distributions
	 * so it will no longer be included in the call to distributeRewards()
	 * @param index The index of the DistributionData to delete
	 */
	function removeRewardDistribution(uint256 index) external onlyOwner {
		require(index <= distributions.length - 1, 'index out of bounds');

		// shift distributions indexes across
		for (uint256 i = index; i < distributions.length - 1; i++) {
			distributions[i] = distributions[i + 1];
		}
		distributions.length--;

		// Since this function must shift all later entries down to fill the
		// gap from the one it removed, it could in principle consume an
		// unbounded amount of gas. However, the number of entries will
		// presumably always be very low.
	}

	/**
	 * @notice Edits a RewardDistribution in the distributions array.
	 * @param index The index of the DistributionData to edit
	 * @param destination The destination address. Send the same address to keep or different address to change it.
	 * @param amount The amount of tokens to edit. Send the same number to keep or change the amount of tokens to send.
	 */
	function editRewardDistribution(
		uint256 index,
		address destination,
		uint256 amount
	) external onlyOwner returns (bool) {
		require(index <= distributions.length - 1, 'index out of bounds');

		distributions[index].destination = destination;
		distributions[index].amount = amount;

		return true;
	}

	/**
     * @notice Iterates the distributions sending set out amounts of
     * tokens to the specified address. The remainder is then sent to the RewardEscrow Contract
     * and applied to the FeePools staking rewards.
     * @param amount The total number of tokens being distributed

     */
	function distributeRewards(uint256 amount) external returns (bool) {
		require(msg.sender == authority, 'Caller is not authorised');
		require(rewardEscrow != address(0), 'RewardEscrow is not set');
		require(synthetixProxy != address(0), 'SynthetixProxy is not set');
		require(feePoolProxy != address(0), 'FeePoolProxy is not set');
		require(amount > 0, 'Nothing to distribute');
		require(
			IERC20(synthetixProxy).balanceOf(this) >= amount,
			'RewardsDistribution contract does not have enough tokens to distribute'
		);

		uint256 remainder = amount;

		// Iterate the array of distributions sending the configured amounts
		for (uint256 i = 0; i < distributions.length; i++) {
			if (distributions[i].destination != address(0) || distributions[i].amount != 0) {
				remainder = remainder.sub(distributions[i].amount);
				IERC20(synthetixProxy).transfer(
					distributions[i].destination,
					distributions[i].amount
				);
			}
		}

		// After all ditributions have been sent, send the remainder to the RewardsEscrow contract
		IERC20(synthetixProxy).transfer(rewardEscrow, remainder);

		// Tell the FeePool how much it has to distribute to the stakers
		IFeePool(feePoolProxy).setRewardsToDistribute(remainder);

		emit RewardsDistributed(amount);
		return true;
	}

	/* ========== VIEWS ========== */

	/**
	 * @notice Retrieve the length of the distributions array
	 */
	function distributionsLength() external view returns (uint256) {
		return distributions.length;
	}

	/* ========== Events ========== */

	event RewardDistributionAdded(uint256 index, address destination, uint256 amount);
	event RewardsDistributed(uint256 amount);
}
