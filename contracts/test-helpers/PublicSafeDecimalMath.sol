/* PublicSafeDecimalMath.sol: expose the internal functions in SafeDecimalMath
 * for testing purposes.
 */
pragma solidity 0.5.8;

import '../SafeDecimalMath.sol';

contract PublicSafeDecimalMath {
	using SafeDecimalMath for uint256;

	function unit() public pure returns (uint256) {
		return SafeDecimalMath.unit();
	}

	function preciseUnit() public pure returns (uint256) {
		return SafeDecimalMath.preciseUnit();
	}

	function multiplyDecimal(uint256 x, uint256 y) public pure returns (uint256) {
		return x.multiplyDecimal(y);
	}

	function multiplyDecimalRound(uint256 x, uint256 y) public pure returns (uint256) {
		return x.multiplyDecimalRound(y);
	}

	function multiplyDecimalRoundPrecise(uint256 x, uint256 y) public pure returns (uint256) {
		return x.multiplyDecimalRoundPrecise(y);
	}

	function divideDecimal(uint256 x, uint256 y) public pure returns (uint256) {
		return x.divideDecimal(y);
	}

	function divideDecimalRound(uint256 x, uint256 y) public pure returns (uint256) {
		return x.divideDecimalRound(y);
	}

	function divideDecimalRoundPrecise(uint256 x, uint256 y) public pure returns (uint256) {
		return x.divideDecimalRoundPrecise(y);
	}

	function decimalToPreciseDecimal(uint256 i) public pure returns (uint256) {
		return i.decimalToPreciseDecimal();
	}

	function preciseDecimalToDecimal(uint256 i) public pure returns (uint256) {
		return i.preciseDecimalToDecimal();
	}
}
