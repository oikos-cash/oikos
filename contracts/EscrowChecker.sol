pragma solidity 0.5.8;

contract SynthetixEscrow {
	function numVestingEntries(address account) public returns (uint256);

	function getVestingScheduleEntry(address account, uint256 index) public returns (uint256[2]);
}

contract EscrowChecker {
	SynthetixEscrow public synthetix_escrow;

	constructor(SynthetixEscrow _esc) public {
		synthetix_escrow = _esc;
	}

	function checkAccountSchedule(address account) public view returns (uint256[16]) {
		uint256[16] memory _result;
		uint256 schedules = synthetix_escrow.numVestingEntries(account);
		for (uint256 i = 0; i < schedules; i++) {
			uint256[2] memory pair = synthetix_escrow.getVestingScheduleEntry(account, i);
			_result[i * 2] = pair[0];
			_result[i * 2 + 1] = pair[1];
		}
		return _result;
	}
}
