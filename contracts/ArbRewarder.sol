/*
-----------------------------------------------------------------
FILE INFORMATION
-----------------------------------------------------------------
file:       ArbRewarder.sol
version:    1.0
author:     justwanttoknowathing
checked:    Clinton Ennis, Jackson Chan
date:       2019-05-01

-----------------------------------------------------------------
MODULE DESCRIPTION
-----------------------------------------------------------------
The Synthetix ArbRewarder Contract for fixing the sTRX/TRX peg

Allows a user to send TRX to the contract via arbSynthRate()
- If the sTRX/TRX ratio is below 99/100 & there is sufficient OKS
remaining in the contract at the current exchange rate.
- Convert the TRX to sTRX via Uniswap up to the 99/100 ratio or the TRX is exhausted
- Convert the sTRX to OKS at the current exchange rate.
- Send the OKS to the wallet that sent the TRX

-----------------------------------------------------------------
*/
pragma solidity 0.5.8;

import './SelfDestructible.sol';
import './Pausable.sol';
import './SafeDecimalMath.sol';
import './interfaces/IERC20.sol';
import './interfaces/IExchangeRates.sol';

contract ArbRewarder is SelfDestructible, Pausable {
	using SafeMath for uint256;
	using SafeDecimalMath for uint256;

	/* How far off the peg the pool must be to allow its ratio to be pushed up or down
	 * by this contract, thus granting the caller arbitrage rewards.
	 * Parts-per-hundred-thousand: 100 = 1% */
	uint256 off_peg_min = 100;

	/* Additional slippage we'll allow on top of the uniswap trade
	 * Parts-per-hundred-thousand: 100 = 1%
	 * Example: 95 sTRX, 100 TRX, buy 1 sTRX -> expected: 1.03857 TRX
	 * After acceptable_slippage:  1.02818 TRX */
	uint256 acceptable_slippage = 100;

	/* How long we'll let a uniswap transaction sit before it becomes invalid
	 * In seconds. Prevents miners holding our transaction and using it later. */
	uint256 max_delay = 600;

	/* Divisor for off_peg_min and acceptable_slippage */
	uint256 constant divisor = 10000;

	/* Contract Addresses */
	address public uniswapAddress = 0xe9Cf7887b93150D4F2Da7dFc6D502B216438F244;
	address public synthetixProxy = 0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F;

	IExchangeRates public exchangeRates = IExchangeRates(
		0x99a46c42689720d9118FF7aF7ce80C2a92fC4f97
	);
	IUniswapExchange public uniswapExchange = IUniswapExchange(uniswapAddress);

	IERC20 public synth = IERC20(0x5e74C9036fb86BD7eCdcb084a0673EFc32eA31cb);
	IERC20 public synthetix = IERC20(synthetixProxy);

	/* ========== CONSTRUCTOR ========== */

	/**
	 * @dev Constructor
	 */
	constructor(address _owner)
		public
		/* Owned is initialised in SelfDestructible */
		SelfDestructible(_owner)
		Pausable(_owner)
	{}

	/* ========== SETTERS ========== */

	function setParams(
		uint256 _acceptable_slippage,
		uint256 _max_delay,
		uint256 _off_peg_min
	) external onlyOwner {
		require(_off_peg_min < divisor, '_off_peg_min less than divisor');
		require(_acceptable_slippage < divisor, '_acceptable_slippage less than divisor');
		acceptable_slippage = _acceptable_slippage;
		max_delay = _max_delay;
		off_peg_min = _off_peg_min;
	}

	function setSynthetix(address _address) external onlyOwner {
		synthetixProxy = _address;
		synthetix = IERC20(synthetixProxy);
	}

	function setSynthAddress(address _synthAddress) external onlyOwner {
		synth = IERC20(_synthAddress);
		synth.approve(uniswapAddress, uint256(-1));
	}

	function setUniswapExchange(address _uniswapAddress) external onlyOwner {
		uniswapAddress = _uniswapAddress;
		uniswapExchange = IUniswapExchange(uniswapAddress);
		synth.approve(uniswapAddress, uint256(-1));
	}

	function setExchangeRates(address _exchangeRatesAddress) external onlyOwner {
		exchangeRates = IExchangeRates(_exchangeRatesAddress);
	}

	/* ========== OWNER ONLY ========== */

	function recoverETH(address to_addr) external onlyOwner {
		to_addr.transfer(address(this).balance);
	}

	function recoverERC20(address erc20_addr, address to_addr) external onlyOwner {
		IERC20 erc20_interface = IERC20(erc20_addr);
		erc20_interface.transfer(to_addr, erc20_interface.balanceOf(address(this)));
	}

	/* ========== PUBLIC FUNCTIONS ========== */

	/**
	 * Here the caller gives us some TRX. We convert the TRX->sTRX  and reward the caller with OKS worth
	 * the value of the sTRX received from the earlier swap.
	 */
	function arbSynthRate()
		public
		payable
		rateNotStale('TRX')
		rateNotStale('OKS')
		notPaused
		returns (uint256 reward_tokens)
	{
		/* Ensure there is enough more sTRX than TRX in the Uniswap pool */
		uint256 seth_in_uniswap = synth.balanceOf(uniswapAddress);
		uint256 eth_in_uniswap = uniswapAddress.balance;
		require(
			eth_in_uniswap.divideDecimal(seth_in_uniswap) <
				uint256(divisor - off_peg_min).divideDecimal(divisor),
			'sTRX/TRX ratio is too high'
		);

		/* Get maximum TRX we'll convert for caller */
		uint256 max_eth_to_convert = maxConvert(
			eth_in_uniswap,
			seth_in_uniswap,
			divisor,
			divisor - off_peg_min
		);
		uint256 eth_to_convert = min(msg.value, max_eth_to_convert);
		uint256 unspent_input = msg.value - eth_to_convert;

		/* Actually swap TRX for sTRX */
		uint256 min_seth_bought = expectedOutput(uniswapExchange, eth_to_convert);
		uint256 tokens_bought = uniswapExchange.ethToTokenSwapInput.value(eth_to_convert)(
			min_seth_bought,
			now + max_delay
		);

		/* Reward caller */
		reward_tokens = rewardCaller(tokens_bought, unspent_input);
	}

	function isArbable() public returns (bool) {
		uint256 seth_in_uniswap = synth.balanceOf(uniswapAddress);
		uint256 eth_in_uniswap = uniswapAddress.balance;
		return
			eth_in_uniswap.divideDecimal(seth_in_uniswap) <
			uint256(divisor - off_peg_min).divideDecimal(divisor);
	}

	/* ========== PRIVATE FUNCTIONS ========== */

	function rewardCaller(uint256 bought, uint256 unspent_input)
		private
		returns (uint256 reward_tokens)
	{
		uint256 snx_rate = exchangeRates.rateForCurrency('OKS');
		uint256 eth_rate = exchangeRates.rateForCurrency('TRX');

		reward_tokens = eth_rate.multiplyDecimal(bought).divideDecimal(snx_rate);
		synthetix.transfer(msg.sender, reward_tokens);

		if (unspent_input > 0) {
			msg.sender.transfer(unspent_input);
		}
	}

	function expectedOutput(IUniswapExchange exchange, uint256 input)
		private
		view
		returns (uint256 output)
	{
		output = exchange.getTokenToEthInputPrice(input);
		output = applySlippage(output);
	}

	function applySlippage(uint256 input) private view returns (uint256 output) {
		output = input - (input * (acceptable_slippage / divisor));
	}

	/**
	 * maxConvert determines how many tokens need to be swapped to bring a market to a n:d ratio
	 * This can be derived by solving a system of equations.
	 *
	 * First, we know that once we're done balanceA and balanceB should be related by our ratio:
	 *
	 * n * (A + input) = d * (B - output)
	 *
	 * From Uniswap's code, we also know how input and output are related:
	 *
	 * output = (997*input*B) / (1000*A + 997*input)
	 *
	 * So:
	 *
	 * n * (A + input) = d * (B - ((997*input*B) / (1000*A + 997*input)))
	 *
	 * Solving for input (given n>d>0 and B>A>0):
	 *
	 * input = (sqrt((A * (9*A*n + 3988000*B*d)) / n) - 1997*A) / 1994
	 */
	function maxConvert(
		uint256 a,
		uint256 b,
		uint256 n,
		uint256 d
	) private pure returns (uint256 result) {
		result = (sqrt((a * (9 * a * n + 3988000 * b * d)) / n) - 1997 * a) / 1994;
	}

	function sqrt(uint256 x) private pure returns (uint256 y) {
		uint256 z = (x + 1) / 2;
		y = x;
		while (z < y) {
			y = z;
			z = (x / z + z) / 2;
		}
	}

	function min(uint256 a, uint256 b) private pure returns (uint256 result) {
		result = a > b ? b : a;
	}

	/* ========== MODIFIERS ========== */

	modifier rateNotStale(bytes32 currencyKey) {
		require(!exchangeRates.rateIsStale(currencyKey), 'Rate stale or not a synth');
		_;
	}
}

contract IUniswapExchange {
	// Address of ERC20 token sold on this exchange
	function tokenAddress() external view returns (address token);

	// Address of Uniswap Factory
	function factoryAddress() external view returns (address factory);

	// Provide Liquidity
	function addLiquidity(
		uint256 min_liquidity,
		uint256 max_tokens,
		uint256 deadline
	) external payable returns (uint256);

	function removeLiquidity(
		uint256 amount,
		uint256 min_eth,
		uint256 min_tokens,
		uint256 deadline
	) external returns (uint256, uint256);

	// Get Prices
	function getEthToTokenInputPrice(uint256 eth_sold)
		external
		view
		returns (uint256 tokens_bought);

	function getEthToTokenOutputPrice(uint256 tokens_bought)
		external
		view
		returns (uint256 eth_sold);

	function getTokenToEthInputPrice(uint256 tokens_sold)
		external
		view
		returns (uint256 eth_bought);

	function getTokenToEthOutputPrice(uint256 eth_bought)
		external
		view
		returns (uint256 tokens_sold);

	// Trade TRX to ERC20
	function ethToTokenSwapInput(uint256 min_tokens, uint256 deadline)
		external
		payable
		returns (uint256 tokens_bought);

	function ethToTokenTransferInput(
		uint256 min_tokens,
		uint256 deadline,
		address recipient
	) external payable returns (uint256 tokens_bought);

	function ethToTokenSwapOutput(uint256 tokens_bought, uint256 deadline)
		external
		payable
		returns (uint256 eth_sold);

	function ethToTokenTransferOutput(
		uint256 tokens_bought,
		uint256 deadline,
		address recipient
	) external payable returns (uint256 eth_sold);

	// Trade ERC20 to TRX
	function tokenToEthSwapInput(
		uint256 tokens_sold,
		uint256 min_eth,
		uint256 deadline
	) external returns (uint256 eth_bought);

	function tokenToEthTransferInput(
		uint256 tokens_sold,
		uint256 min_eth,
		uint256 deadline,
		address recipient
	) external returns (uint256 eth_bought);

	function tokenToEthSwapOutput(
		uint256 eth_bought,
		uint256 max_tokens,
		uint256 deadline
	) external returns (uint256 tokens_sold);

	function tokenToEthTransferOutput(
		uint256 eth_bought,
		uint256 max_tokens,
		uint256 deadline,
		address recipient
	) external returns (uint256 tokens_sold);

	// Trade ERC20 to ERC20
	function tokenToTokenSwapInput(
		uint256 tokens_sold,
		uint256 min_tokens_bought,
		uint256 min_eth_bought,
		uint256 deadline,
		address token_addr
	) external returns (uint256 tokens_bought);

	function tokenToTokenTransferInput(
		uint256 tokens_sold,
		uint256 min_tokens_bought,
		uint256 min_eth_bought,
		uint256 deadline,
		address recipient,
		address token_addr
	) external returns (uint256 tokens_bought);

	function tokenToTokenSwapOutput(
		uint256 tokens_bought,
		uint256 max_tokens_sold,
		uint256 max_eth_sold,
		uint256 deadline,
		address token_addr
	) external returns (uint256 tokens_sold);

	function tokenToTokenTransferOutput(
		uint256 tokens_bought,
		uint256 max_tokens_sold,
		uint256 max_eth_sold,
		uint256 deadline,
		address recipient,
		address token_addr
	) external returns (uint256 tokens_sold);

	// Trade ERC20 to Custom Pool
	function tokenToExchangeSwapInput(
		uint256 tokens_sold,
		uint256 min_tokens_bought,
		uint256 min_eth_bought,
		uint256 deadline,
		address exchange_addr
	) external returns (uint256 tokens_bought);

	function tokenToExchangeTransferInput(
		uint256 tokens_sold,
		uint256 min_tokens_bought,
		uint256 min_eth_bought,
		uint256 deadline,
		address recipient,
		address exchange_addr
	) external returns (uint256 tokens_bought);

	function tokenToExchangeSwapOutput(
		uint256 tokens_bought,
		uint256 max_tokens_sold,
		uint256 max_eth_sold,
		uint256 deadline,
		address exchange_addr
	) external returns (uint256 tokens_sold);

	function tokenToExchangeTransferOutput(
		uint256 tokens_bought,
		uint256 max_tokens_sold,
		uint256 max_eth_sold,
		uint256 deadline,
		address recipient,
		address exchange_addr
	) external returns (uint256 tokens_sold);

	// ERC20 comaptibility for liquidity tokens
	bytes32 public name;
	bytes32 public symbol;
	uint256 public decimals;

	function transfer(address _to, uint256 _value) external returns (bool);

	function transferFrom(
		address _from,
		address _to,
		uint256 value
	) external returns (bool);

	function approve(address _spender, uint256 _value) external returns (bool);

	function allowance(address _owner, address _spender) external view returns (uint256);

	function balanceOf(address _owner) external view returns (uint256);

	function totalSupply() external view returns (uint256);

	// Never use
	function setup(address token_addr) external;
}
