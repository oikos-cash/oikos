pragma solidity 0.5.8;

/**
 * @title Synthetix interface contract
 * @notice Abstract contract to hold public getters
 * @dev pseudo interface, actually declared as contract to hold the public getters
 */
import '../interfaces/ISynthetixState.sol';
import '../interfaces/ISynth.sol';
import '../interfaces/ISynthetixEscrow.sol';
import '../interfaces/IFeePool.sol';
import '../interfaces/IExchangeRates.sol';
import '../Synth.sol';

contract ISynthetix {
	// ========== PUBLIC STATE VARIABLES ==========

	IFeePool public feePool;
	ISynthetixEscrow public escrow;
	ISynthetixEscrow public rewardEscrow;
	ISynthetixState public synthetixState;
	IExchangeRates public exchangeRates;

	uint256 public totalSupply;

	mapping(bytes32 => Synth) public synths;

	// ========== PUBLIC FUNCTIONS ==========

	function balanceOf(address account) public view returns (uint256);

	function transfer(address to, uint256 value) public returns (bool);

	function effectiveValue(
		bytes32 sourceCurrencyKey,
		uint256 sourceAmount,
		bytes32 destinationCurrencyKey
	) public view returns (uint256);

	function synthInitiatedExchange(
		address from,
		bytes32 sourceCurrencyKey,
		uint256 sourceAmount,
		bytes32 destinationCurrencyKey,
		address destinationAddress
	) external returns (bool);

	function exchange(
		bytes32 sourceCurrencyKey,
		uint256 sourceAmount,
		bytes32 destinationCurrencyKey
	) external returns (bool);

	function collateralisationRatio(address issuer) public view returns (uint256);

	function totalIssuedSynths(bytes32 currencyKey) public view returns (uint256);

	function getSynth(bytes32 currencyKey) public view returns (ISynth);

	function debtBalanceOf(address issuer, bytes32 currencyKey) public view returns (uint256);
}
