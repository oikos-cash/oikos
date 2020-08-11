pragma solidity 0.5.8;

/**
 * @title SynthetixEscrow interface
 */
interface ISynthetixEscrow {
	function balanceOf(address account) public view returns (uint256);

	function appendVestingEntry(address account, uint256 quantity) public;
}
