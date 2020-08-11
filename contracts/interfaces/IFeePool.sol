pragma solidity 0.5.8;

/**
 * @title FeePool Interface
 * @notice Abstract contract to hold public getters
 */
contract IFeePool {
	address public FEE_ADDRESS;
	uint256 public exchangeFeeRate;

	function amountReceivedFromExchange(uint256 value) external view returns (uint256);

	function amountReceivedFromTransfer(uint256 value) external view returns (uint256);

	function recordFeePaid(uint256 xdrAmount) external;

	function appendAccountIssuanceRecord(
		address account,
		uint256 lockedAmount,
		uint256 debtEntryIndex
	) external;

	function setRewardsToDistribute(uint256 amount) external;
}
