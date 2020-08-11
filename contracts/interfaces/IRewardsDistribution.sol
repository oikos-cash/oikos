pragma solidity 0.5.8;

/**
 * @title RewardsDistribution interface
 */
interface IRewardsDistribution {
	function distributeRewards(uint256 amount) external;
}
