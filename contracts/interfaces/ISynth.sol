pragma solidity 0.5.8;

interface ISynth {
	function burn(address account, uint256 amount) external;

	function issue(address account, uint256 amount) external;

	function transfer(address to, uint256 value) external returns (bool);

	function transferFrom(
		address from,
		address to,
		uint256 value
	) external returns (bool);
}
