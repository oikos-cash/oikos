/* PublicMath.sol: expose the internal functions in Math library
 * for testing purposes.
 */
pragma solidity 0.5.8;

import '../Math.sol';

contract PublicMath {
	using Math for uint256;

	function powerDecimal(uint256 x, uint256 y) public pure returns (uint256) {
		return x.powDecimal(y);
	}
}
