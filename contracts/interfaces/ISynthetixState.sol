pragma solidity 0.5.8;

/**
 * @title SynthetixState interface contract
 * @notice Abstract contract to hold public getters
 */
contract ISynthetixState {
	// A struct for handing values associated with an individual user's debt position
	struct IssuanceData {
		// Percentage of the total debt owned at the time
		// of issuance. This number is modified by the global debt
		// delta array. You can figure out a user's exit price and
		// collateralisation ratio using a combination of their initial
		// debt and the slice of global debt delta which applies to them.
		uint256 initialDebtOwnership;
		// This lets us know when (in relative terms) the user entered
		// the debt pool so we can calculate their exit price and
		// collateralistion ratio
		uint256 debtEntryIndex;
	}

	uint256[] public debtLedger;
	uint256 public issuanceRatio;
	mapping(address => IssuanceData) public issuanceData;

	function debtLedgerLength() external view returns (uint256);

	function hasIssued(address account) external view returns (bool);

	function incrementTotalIssuerCount() external;

	function decrementTotalIssuerCount() external;

	function setCurrentIssuanceData(address account, uint256 initialDebtOwnership) external;

	function lastDebtLedgerEntry() external view returns (uint256);

	function appendDebtLedgerValue(uint256 value) external;

	function clearIssuanceData(address account) external;
}
