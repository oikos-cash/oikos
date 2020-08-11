pragma solidity 0.5.8;

/**
 * @title ExchangeRates interface
 */
interface IExchangeRates {
	function effectiveValue(
		bytes32 sourceCurrencyKey,
		uint256 sourceAmount,
		bytes32 destinationCurrencyKey
	) external view returns (uint256);

	function rateForCurrency(bytes32 currencyKey) external view returns (uint256);

	function ratesForCurrencies(bytes32[] currencyKeys) external view returns (uint256[] memory);

	function rateIsStale(bytes32 currencyKey) external view returns (bool);

	function anyRateIsStale(bytes32[] currencyKeys) external view returns (bool);
}
