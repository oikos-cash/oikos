'use strict';

const path = require('path');
const fs = require('fs');
const { gray, green, yellow, redBright, red } = require('chalk');
const { table } = require('table');
const Deployer = require('../Deployer');
const { loadCompiledFiles, getLatestSolTimestamp } = require('../solidity');
const checkAggregatorPrices = require('../check-aggregator-prices');
const TronWeb = require('tronweb');
const w3utils = require('web3-utils');

// converts from tronweb bignumber to web3 bignumber (they use different bignumber libraries)
const toWeb3BN = tronBN => {
	if (!TronWeb.utils.isBigNumber(tronBN)) throw new Error(`${tronBN} is not a Tron bignumber`);
	const str = tronBN.toString();
	return w3utils.toBN(str);
};

const toTronBN = web3BN => {
	return new TronWeb.BigNumber(web3BN.toString());
};

const toBNArg = web3BN => {
	return toTronBN(web3BN).toString(10);
};

// token(s) use 18 decimals like Ethereum
const toWei = (number, unit) => w3utils.toWei(number, unit);
const fromWei = (...args) => w3utils.fromWei(...args);
const toBN = (...args) => w3utils.toBN(...args);

const {
	BUILD_FOLDER,
	CONFIG_FILENAME,
	CONTRACTS_FOLDER,
	SYNTHS_FILENAME,
	DEPLOYMENT_FILENAME,
	ZERO_ADDRESS,
} = require('../constants');

const {
	ensureNetwork,
	ensureDeploymentPath,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	appendOwnerActionGenerator,
	performTransactionalStep,
	stringify,
} = require('../util');

const { toBytes32 } = require('../../../.');

const parameterNotice = props => {
	console.log(gray('-'.repeat(50)));
	console.log('Please check the following parameters are correct:');
	console.log(gray('-'.repeat(50)));

	Object.entries(props).forEach(([key, val]) => {
		console.log(gray(key) + ' '.repeat(30 - key.length) + redBright(val));
	});

	console.log(gray('-'.repeat(50)));
};

// TODO! originEnergyLimit
const DEFAULTS = {
	// gasPrice: '1',
	// methodCallGasLimit: 250e3, // 250k (ethereum)
	methodCallFeeLimit: 1e9, // tron
	// contractDeploymentGasLimit: 6.9e6, // TODO split out into seperate limits for different contracts, Proxys, Synths, Synthetix
	contractDeploymentFeeLimit: 1e9, // tron
	network: 'shasta',
	buildPath: path.join(__dirname, '..', '..', '..', BUILD_FOLDER),
	oracleExrates: '41aad3910a630b033cef3b1f8ea1eb93a71e5f7376',
};

const deploy = async ({
	addNewSynths,
	// gasPrice = DEFAULTS.gasPrice,
	methodCallFeeLimit = DEFAULTS.methodCallFeeLimit,
	contractDeploymentFeeLimit = DEFAULTS.contractDeploymentFeeLimit,
	network = DEFAULTS.network,
	buildPath = DEFAULTS.buildPath,
	deploymentPath,
	oracleExrates,
	oracleGasLimit,
	oracleDepot,
	privateKey,
	yes,
} = {}) => {
	ensureNetwork(network);
	ensureDeploymentPath(deploymentPath);

	const {
		config,
		configFile,
		synths,
		deployment,
		deploymentFile,
		ownerActions,
		ownerActionsFile,
	} = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	console.log(
		gray('Checking all contracts not flagged for deployment have addresses in this network...')
	);
	const missingDeployments = Object.keys(config).filter(name => {
		return !config[name].deploy && (!deployment.targets[name] || !deployment.targets[name].address);
	});

	if (missingDeployments.length) {
		throw Error(
			`Cannot use existing contracts for deployment as addresses not found for the following contracts on ${network}:\n` +
				missingDeployments.join('\n') +
				'\n' +
				gray(`Used: ${deploymentFile} as source`)
		);
	}

	console.log(gray('Loading the compiled contracts locally...'));
	const { earliestCompiledTimestamp, compiled } = loadCompiledFiles({ buildPath });

	// now get the latest time a Solidity file was edited
	const latestSolTimestamp = getLatestSolTimestamp(CONTRACTS_FOLDER);

	// now clone these so we can update and write them after each deployment but keep the original
	// flags available
	const updatedConfig = JSON.parse(JSON.stringify(config));

	const { providerUrl, privateKey: envPrivateKey, tronscanLinkPrefix } = loadConnections({
		network,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	const deployer = new Deployer({
		compiled,
		config,
		// gasPrice,
		methodCallFeeLimit,
		contractDeploymentFeeLimit,
		deployment,
		privateKey,
		providerUrl,
	});

	const { account } = deployer;

	const getExistingContract = async ({ contract }) => {
		if (!deployment.targets[contract]) return;
		const { address, source } = deployment.targets[contract];
		const { abi } = deployment.sources[source];

		return deployer.getContract({
			address,
			abi,
		});
	};

	let currentSynthetixSupply;
	let currentExchangeFee;
	let currentSynthetixPrice;
	let oldExrates;
	let currentLastMintEvent;
	let currentWeekOfInflation;

	try {
		const oldSynthetix = await getExistingContract({ contract: 'Synthetix' });
		if (oldSynthetix) {
			// TODO: make sure the constants make sense for Tron
			currentSynthetixSupply = toWeb3BN(await oldSynthetix.methods.totalSupply().call());
			if (!oracleGasLimit) {
				oracleGasLimit = await oldSynthetix.methods.gasLimitOracle().call();
			}

			// inflationSupplyToDate = total supply - 100m
			const inflationSupplyToDate = toBN(currentSynthetixSupply).sub(
				toBN(toWei((100e6).toString()))
			);

			// current weekly inflation 75m / 52
			const weeklyInflation = toBN(toWei((75e6 / 52).toString()));
			currentWeekOfInflation = inflationSupplyToDate.div(weeklyInflation);

			// Check result is > 0 else set to 0 for currentWeek
			currentWeekOfInflation = currentWeekOfInflation.gt(toBN('0'))
				? currentWeekOfInflation.toNumber()
				: 0;

			// Calculate lastMintEvent as Inflation start date + number of weeks issued * secs in weeks
			const mintingBuffer = 86400;
			const secondsInWeek = 604800;
			const inflationStartDate = 1551830400;
			currentLastMintEvent =
				inflationStartDate + currentWeekOfInflation * secondsInWeek + mintingBuffer;
		} else {
			// TODO! kevin: not sure this is right... need to dig into this.
			currentSynthetixSupply = toWei((100e6).toString());
			oracleGasLimit = account;
			currentWeekOfInflation = 0;
			currentLastMintEvent = 0;
		}
	} catch (err) {
		console.error(err);
		if (network === 'local') {
			currentSynthetixSupply = toWei((100e6).toString());
			oracleGasLimit = account;
			currentWeekOfInflation = 0;
			currentLastMintEvent = 0;
		} else {
			console.error(
				red(
					'Cannot connect to existing Synthetix contract. Please double check the deploymentPath is correct for the network allocated'
				)
			);
			process.exitCode = 1;
			return;
		}
	}

	try {
		const oldFeePool = await getExistingContract({ contract: 'FeePool' });
		if (oldFeePool) {
			currentExchangeFee = toWeb3BN(await oldFeePool.methods.exchangeFeeRate().call());
		} else {
			// TODO! kevin: not sure this is right... need to dig into this.
			currentExchangeFee = toWei('0.003'.toString());
		}
	} catch (err) {
		if (network === 'local') {
			currentExchangeFee = toWei('0.003'.toString());
		} else {
			console.error(
				red(
					'Cannot connect to existing FeePool contract. Please double check the deploymentPath is correct for the network allocated'
				)
			);
			process.exitCode = 1;
			return;
		}
	}

	try {
		oldExrates = await getExistingContract({ contract: 'ExchangeRates' });
		if (oldExrates) {
			currentSynthetixPrice = toWeb3BN(
				await oldExrates.methods.rateForCurrency(toBytes32('OKS')).call()
			);
			if (!oracleExrates) {
				oracleExrates = await oldExrates.methods.oracle().call();
			}
		} else {
			// TODO! kevin: not sure this is right... need to dig into this.
			// should oracle use same account as main deployment account?
			if (!oracleExrates) {
				oracleExrates = account;
			}
			currentSynthetixPrice = toWei('0.2');
		}
	} catch (err) {
		if (network === 'local') {
			currentSynthetixPrice = toWei('0.2');
			oracleExrates = account;
			oldExrates = undefined; // unset to signify that a fresh one will be deployed
		} else {
			console.error(
				red(
					'Cannot connect to existing ExchangeRates contract. Please double check the deploymentPath is correct for the network allocated'
				)
			);
			process.exitCode = 1;
			return;
		}
	}

	oracleDepot = account;
	/*
	try {
		if (!oracleDepot) {
			console.log({ currentDepot });
			if (currentDepot) {
				oracleDepot = await currentDepot.methods.oracle().call();
			} else {
				// TODO! kevin: not sure this is right... need to dig into this.
				// should oracle use same account as main deployment account?
				oracleDepot = account;
			}
		}
	} catch (err) {
		if (network === 'local') {
			oracleDepot = account;
		} else {
			console.error(
				red(
					'Cannot connect to existing Depot contract. Please double check the deploymentPath is correct for the network allocated'
				)
			);
			process.exitCode = 1;
			return;
		}
	}
  */

	for (const address of [account, oracleExrates, oracleDepot]) {
		if (!TronWeb.isAddress(address)) {
			console.error(red('Invalid address detected (please check your inputs):', address));
			process.exitCode = 1;
			return;
		}
	}

	const newSynthsToAdd = synths
		.filter(({ name }) => !config[`Synth${name}`])
		.map(({ name }) => name);

	let aggregatedPriceResults = 'N/A';

	if (oldExrates && network !== 'local') {
		const padding = '\n\t\t\t\t';
		const aggResults = await checkAggregatorPrices({
			network,
			providerUrl,
			synths,
			oldExrates,
		});
		aggregatedPriceResults = padding + aggResults.join(padding);
	}

	parameterNotice({
		Network: network,
		// 'Gas price to use': `${gasPrice} GWEI`,
		'Deployment Path': new RegExp(network, 'gi').test(deploymentPath)
			? deploymentPath
			: yellow('⚠⚠⚠ cant find network name in path. Please double check this! ') + deploymentPath,
		'Local build last modified': `${new Date(earliestCompiledTimestamp)} ${yellow(
			((new Date().getTime() - earliestCompiledTimestamp) / 60000).toFixed(2) + ' mins ago'
		)}`,
		'Last Solidity update':
			new Date(latestSolTimestamp) +
			(latestSolTimestamp > earliestCompiledTimestamp
				? yellow(' ⚠⚠⚠ this is later than the last build! Is this intentional?')
				: green(' ✅')),
		'Add any new synths found?': addNewSynths
			? green('✅ YES\n\t\t\t\t') + newSynthsToAdd.join(', ')
			: yellow('⚠ NO'),
		'Deployer account:': account,
		'Synthetix totalSupply': `${Math.round(fromWei(currentSynthetixSupply) / 1e6)}m`,
		'FeePool exchangeFeeRate': `${fromWei(currentExchangeFee)}`,
		'ExchangeRates Oracle': oracleExrates,
		'Depot Oracle': oracleDepot,
		'Gas Limit Oracle': oracleGasLimit,
		'Last Mint Event': `${currentLastMintEvent} (${new Date(currentLastMintEvent * 1000)})`,
		'Current Weeks Of Inflation': currentWeekOfInflation,
		'Aggregated Prices': aggregatedPriceResults,
	});

	if (!yes) {
		try {
			await confirmAction(
				yellow(
					`⚠⚠⚠ WARNING: This action will deploy the following contracts to ${network}:\n${Object.entries(
						config
					)
						.filter(([, { deploy }]) => deploy)
						.map(([contract]) => contract)
						.join(', ')}` + `\nIt will also set proxy targets and add synths to Synthetix.\n`
				) +
					gray('-'.repeat(50)) +
					'\nDo you want to continue? (y/n) '
			);
		} catch (err) {
			console.log(gray('Operation cancelled'));
			return;
		}
	}

	console.log(gray(`Starting deployment to ${network.toUpperCase()} via TronGrid...`));
	const newContractsDeployed = [];
	// force flag indicates to deploy even when no config for the entry (useful for new synths)
	const deployContract = async ({ name, source = name, args, deps, force = false }) => {
		const deployedContract = await deployer.deploy({ name, source, args, deps, force });
		if (!deployedContract) {
			return;
		}
		const { address } = deployedContract;

		let timestamp = new Date();
		let txn = '';
		if (config[name] && !config[name].deploy) {
			// deploy is false, so we reused a deployment, thus lets grab the details that already exist
			// TODO! not sure those properties are set
			timestamp = deployment.targets[name].timestamp;
			txn = deployment.targets[name].txn;
		}
		// now update the deployed contract information
		const subdomain = network !== 'mainnet' ? network + '.' : '';
		const tronAddress = TronWeb.address.fromHex(address);
		const link = `https://${subdomain}tronscan.org/#/address/${tronAddress}`;
		deployment.targets[name] = {
			name,
			address,
			source,
			link,
			timestamp,
			txn,
			network,
		};
		deployment.sources[source] = {
			bytecode: compiled[source].evm.bytecode.object,
			abi: compiled[source].abi,
		};
		fs.writeFileSync(deploymentFile, stringify(deployment));

		// now update the flags to indicate it no longer needs deployment,
		// ignoring this step for local, which wants a full deployment by default
		if (network !== 'local') {
			updatedConfig[name] = { deploy: false };
			fs.writeFileSync(configFile, stringify(updatedConfig));
		}

		if (deployedContract.deployed) {
			// add to the list of deployed contracts for later reporting
			newContractsDeployed.push({
				name,
				address,
			});
		}

		return deployedContract;
	};

	// track an action we cannot perform because we aren't an OWNER (so we can iterate later in the owner step)
	const appendOwnerAction = appendOwnerActionGenerator({
		ownerActions,
		ownerActionsFile,
		tronscanLinkPrefix,
	});

	const runStep = async opts =>
		performTransactionalStep({
			...opts,
			account,
			feeLimit: methodCallFeeLimit,
			// gasPrice,
			tronscanLinkPrefix,
			ownerActions,
			ownerActionsFile,
		});

	await deployContract({
		name: 'SafeDecimalMath',
	});

	// TODO!: @kev this contract throws an error when deploying because it has no ABI...
	// it does not seem to be used by any of the other contracts so let's just skip it entirely.. :/ YOLO
	/*
	await deployContract({
		name: 'Math',
	});
  */

	const exchangeRates = await deployContract({
		name: 'ExchangeRates',
		args: [account, oracleExrates, [toBytes32('OKS')], [currentSynthetixPrice]],
	});

	// Set exchangeRates.stalePeriod to 1 sec if mainnet
	if (exchangeRates && config['ExchangeRates'].deploy && network === 'mainnet') {
		// const rateStalePeriod = 1;
		const rateStalePeriod = 60 * 30; // 30 minutes
		await runStep({
			contract: 'ExchangeRates',
			target: exchangeRates,
			read: 'rateStalePeriod',
			expected: input => Number(input.toString()) === rateStalePeriod,
			write: 'setRateStalePeriod',
			writeArg: rateStalePeriod,
		});
	}

	const exchangeRatesAddress = exchangeRates ? exchangeRates.address : '';

	const rewardEscrow = await deployContract({
		name: 'RewardEscrow',
		args: [account, ZERO_ADDRESS, ZERO_ADDRESS],
	});

	const synthetixEscrow = await deployContract({
		name: 'SynthetixEscrow',
		args: [account, ZERO_ADDRESS],
	});

	const synthetixState = await deployContract({
		name: 'SynthetixState',
		args: [account, account],
	});

	const proxyFeePool = await deployContract({
		name: 'ProxyFeePool',
		source: 'Proxy',
		args: [account],
	});

	const feePoolDelegateApprovals = await deployContract({
		name: 'DelegateApprovals',
		args: [account, ZERO_ADDRESS],
	});

	const feePoolEternalStorage = await deployContract({
		name: 'FeePoolEternalStorage',
		args: [account, ZERO_ADDRESS],
	});

	const feePool = await deployContract({
		name: 'FeePool',
		deps: ['ProxyFeePool'],
		args: [
			proxyFeePool ? proxyFeePool.address : '',
			account,
			ZERO_ADDRESS, // Synthetix
			ZERO_ADDRESS, // FeePoolState
			feePoolEternalStorage ? feePoolEternalStorage.address : '',
			synthetixState ? synthetixState.address : '',
			rewardEscrow ? rewardEscrow.address : '',
			ZERO_ADDRESS,
			currentExchangeFee, // exchange fee
		],
	});

	const feePoolAddress = feePool ? feePool.address : '';

	if (proxyFeePool && feePool) {
		await runStep({
			contract: 'ProxyFeePool',
			target: proxyFeePool,
			read: 'target',
			expected: input => input === feePoolAddress,
			write: 'setTarget',
			writeArg: feePoolAddress,
		});
	}

	if (feePoolEternalStorage && feePool) {
		await runStep({
			contract: 'FeePoolEternalStorage',
			target: feePoolEternalStorage,
			read: 'associatedContract',
			expected: input => input === feePoolAddress,
			write: 'setAssociatedContract',
			writeArg: feePoolAddress,
		});
	}

	if (feePoolDelegateApprovals && feePool) {
		const delegateApprovalsAddress = feePoolDelegateApprovals.address;
		await runStep({
			contract: 'FeePool',
			target: feePool,
			read: 'delegates',
			expected: input => input === delegateApprovalsAddress,
			write: 'setDelegateApprovals',
			writeArg: delegateApprovalsAddress,
		});

		await runStep({
			contract: 'DelegateApprovals',
			target: feePoolDelegateApprovals,
			read: 'associatedContract',
			expected: input => input === feePoolAddress,
			write: 'setAssociatedContract',
			writeArg: feePoolAddress,
		});
	}

	const feePoolState = await deployContract({
		name: 'FeePoolState',
		deps: ['FeePool'],
		args: [account, feePoolAddress],
	});

	if (feePool && feePoolState) {
		const feePoolStateAddress = feePoolState.address;
		await runStep({
			contract: 'FeePool',
			target: feePool,
			read: 'feePoolState',
			expected: input => input === feePoolStateAddress,
			write: 'setFeePoolState',
			writeArg: feePoolStateAddress,
		});

		// Rewire feePoolState if there is a feePool upgrade
		await runStep({
			contract: 'FeePoolState',
			target: feePoolState,
			read: 'feePool',
			expected: input => input === feePoolAddress,
			write: 'setFeePool',
			writeArg: feePoolAddress,
		});
	}

	const rewardsDistribution = await deployContract({
		name: 'RewardsDistribution',
		deps: ['RewardEscrow', 'ProxyFeePool'],
		args: [
			account, // owner
			ZERO_ADDRESS, // authority (synthetix)
			ZERO_ADDRESS, // Synthetix Proxy
			rewardEscrow ? rewardEscrow.address : '',
			proxyFeePool ? proxyFeePool.address : '',
		],
	});

	if (rewardsDistribution && feePool) {
		const rewardsDistributionAddress = rewardsDistribution.address;
		await runStep({
			contract: 'FeePool',
			target: feePool,
			read: 'rewardsAuthority',
			expected: input => input === rewardsDistributionAddress,
			write: 'setRewardsAuthority',
			writeArg: rewardsDistributionAddress,
		});
	}

	// constructor(address _owner, uint _lastMintEvent, uint _currentWeek)
	const supplySchedule = await deployContract({
		name: 'SupplySchedule',
		args: [account, currentLastMintEvent, currentWeekOfInflation],
	});

	const proxySynthetix = await deployContract({
		name: 'ProxySynthetix',
		source: 'Proxy',
		args: [account],
	});

	const tokenStateSynthetix = await deployContract({
		name: 'TokenStateSynthetix',
		source: 'TokenState',
		args: [account, account],
	});

	const synthetix = await deployContract({
		name: 'Synthetix',
		deps: [
			'ProxySynthetix',
			'TokenStateSynthetix',
			'SynthetixState',
			'ExchangeRates',
			'FeePool',
			'SupplySchedule',
			'RewardEscrow',
			'SynthetixEscrow',
			'RewardsDistribution',
		],
		args: [
			proxySynthetix ? proxySynthetix.address : '',
			tokenStateSynthetix ? tokenStateSynthetix.address : '',
			synthetixState ? synthetixState.address : '',
			account,
			exchangeRates ? exchangeRates.address : '',
			feePool ? feePool.address : '',
			supplySchedule ? supplySchedule.address : '',
			rewardEscrow ? rewardEscrow.address : '',
			synthetixEscrow ? synthetixEscrow.address : '',
			rewardsDistribution ? rewardsDistribution.address : '',
			toBNArg(currentSynthetixSupply),
		],
	});

	const synthetixAddress = synthetix ? synthetix.address : '';

	if (proxySynthetix && synthetix) {
		await runStep({
			contract: 'ProxySynthetix',
			target: proxySynthetix,
			read: 'target',
			expected: input => input === synthetixAddress,
			write: 'setTarget',
			writeArg: synthetixAddress,
		});
	}

	if (synthetix && feePool) {
		await runStep({
			contract: 'Synthetix',
			target: synthetix,
			read: 'feePool',
			expected: input => input === feePoolAddress,
			write: 'setFeePool',
			writeArg: feePoolAddress,
		});

		await runStep({
			contract: 'FeePool',
			target: feePool,
			read: 'synthetix',
			expected: input => input === synthetixAddress,
			write: 'setSynthetix',
			writeArg: synthetixAddress,
		});
	}

	if (synthetix && exchangeRates) {
		await runStep({
			contract: 'Synthetix',
			target: synthetix,
			read: 'exchangeRates',
			expected: input => input === exchangeRatesAddress,
			write: 'setExchangeRates',
			writeArg: exchangeRatesAddress,
		});
	}

	// setup gasLimitOracle on Synthetix
	/*
	await runStep({
		contract: 'Synthetix',
		target: synthetix,
		read: 'gasLimitOracle',
		expected: input => input === oracleGasLimit,
		write: 'setGasLimitOracle',
		writeArg: oracleGasLimit,
  });
  */

	// setup exchange gasPriceLimit on Synthetix for local only
	/*
	if (network === 'local') {
		const gasPriceLimit = toWei('35', 'gwei');
		await runStep({
			contract: 'Synthetix',
			target: synthetix,
			account: oracleGasLimit,
			read: 'gasPriceLimit',
			expected: input => input === gasPriceLimit,
			write: 'setGasPriceLimit',
			writeArg: gasPriceLimit,
		});
	}
  */

	// only reset token state if redeploying
	if (tokenStateSynthetix && config['TokenStateSynthetix'].deploy) {
		const initialIssuance = toWei('100000000');
		await runStep({
			contract: 'TokenStateSynthetix',
			target: tokenStateSynthetix,
			read: 'balanceOf',
			readArg: account,
			expected: input => input === initialIssuance,
			write: 'setBalanceOf',
			writeArg: [account, initialIssuance],
		});
	}

	if (tokenStateSynthetix && synthetix) {
		await runStep({
			contract: 'TokenStateSynthetix',
			target: tokenStateSynthetix,
			read: 'associatedContract',
			expected: input => input === synthetixAddress,
			write: 'setAssociatedContract',
			writeArg: synthetixAddress,
		});
	}

	if (synthetixState && synthetix) {
		await runStep({
			contract: 'SynthetixState',
			target: synthetixState,
			read: 'associatedContract',
			expected: input => input === synthetixAddress,
			write: 'setAssociatedContract',
			writeArg: synthetixAddress,
		});
	}

	if (synthetixEscrow) {
		await deployContract({
			name: 'EscrowChecker',
			deps: ['SynthetixEscrow'],
			args: [synthetixEscrow.address],
		});
	}

	if (rewardEscrow && synthetix) {
		await runStep({
			contract: 'RewardEscrow',
			target: rewardEscrow,
			read: 'synthetix',
			expected: input => input === synthetixAddress,
			write: 'setSynthetix',
			writeArg: synthetixAddress,
		});
	}

	if (rewardEscrow && feePool) {
		await runStep({
			contract: 'RewardEscrow',
			target: rewardEscrow,
			read: 'feePool',
			expected: input => input === feePoolAddress,
			write: 'setFeePool',
			writeArg: feePoolAddress,
		});
	}

	// Skip setting unless redeploying either of these,
	if (config['Synthetix'].deploy || config['SynthetixEscrow'].deploy) {
		// Note: currently on mainnet SynthetixEscrow.methods.synthetix() does NOT exist
		// it is "havven" and the ABI we have here is not sufficient
		/*
		if (network === 'mainnet') {
			appendOwnerAction({
				key: `SynthetixEscrow.setHavven(Synthetix)`,
				target: synthetixEscrow.address,
				action: `setHavven(${synthetixAddress})`,
			});
		} else {
			await runStep({
				contract: 'SynthetixEscrow',
				target: synthetixEscrow,
				read: 'synthetix',
				expected: input => input === synthetixAddress,
				write: 'setSynthetix',
				writeArg: synthetixAddress,
			});
    }
    */
		await runStep({
			contract: 'SynthetixEscrow',
			target: synthetixEscrow,
			read: 'synthetix',
			expected: input => input === synthetixAddress,
			write: 'setSynthetix',
			writeArg: synthetixAddress,
		});
	}

	// Read Synthetix Proxy address
	const synthetixProxyAddress = await synthetix.methods.proxy().call();

	if (supplySchedule && synthetix) {
		await runStep({
			contract: 'SupplySchedule',
			target: supplySchedule,
			read: 'synthetixProxy',
			expected: input => input === synthetixProxyAddress,
			write: 'setSynthetixProxy',
			writeArg: synthetixProxyAddress,
		});
	}

	// Setup Synthetix and deploy proxyERC20 for use in Synths
	const proxyERC20Synthetix = await deployContract({
		name: 'ProxyERC20',
		deps: ['Synthetix'],
		args: [account],
	});
	const proxyERC20SynthetixAddress = proxyERC20Synthetix ? proxyERC20Synthetix.address : '';

	if (synthetix && proxyERC20Synthetix) {
		await runStep({
			contract: 'ProxyERC20',
			target: proxyERC20Synthetix,
			read: 'target',
			expected: input => input === synthetixAddress,
			write: 'setTarget',
			writeArg: synthetixAddress,
		});

		await runStep({
			contract: 'Synthetix',
			target: synthetix,
			read: 'integrationProxy',
			expected: input => input === proxyERC20SynthetixAddress,
			write: 'setIntegrationProxy',
			writeArg: proxyERC20SynthetixAddress,
		});
	}

	if (synthetix && rewardsDistribution) {
		await runStep({
			contract: 'RewardsDistribution',
			target: rewardsDistribution,
			read: 'authority',
			expected: input => input === synthetixAddress,
			write: 'setAuthority',
			writeArg: synthetixAddress,
		});

		await runStep({
			contract: 'RewardsDistribution',
			target: rewardsDistribution,
			read: 'synthetixProxy',
			expected: input => input === proxyERC20SynthetixAddress,
			write: 'setSynthetixProxy',
			writeArg: proxyERC20SynthetixAddress,
		});
	}

	// ----------------
	// Synths
	// ----------------
	let proxysTRXAddress;
	for (const { name: currencyKey, inverted, subclass, aggregator } of synths) {
		const tokenStateForSynth = await deployContract({
			name: `TokenState${currencyKey}`,
			source: 'TokenState',
			args: [account, ZERO_ADDRESS],
			force: addNewSynths,
		});

		const proxyForSynth = await deployContract({
			name: `Proxy${currencyKey}`,
			// source: synthProxyIsLegacy ? 'Proxy' : 'ProxyERC20',
			source: 'ProxyERC20',
			args: [account],
			force: addNewSynths,
		});

		if (currencyKey === 'sTRX') {
			proxysTRXAddress = proxyForSynth.address;
		}

		const currencyKeyInBytes = toBytes32(currencyKey);

		const synthConfig = config[`Synth${currencyKey}`] || {};

		// track the original supply if we're deploying a new synth contract for an existing synth
		let originalTotalSupply = 0;
		if (synthConfig.deploy) {
			try {
				const oldSynth = await getExistingContract({ contract: `Synth${currencyKey}` });
				if (oldSynth) {
					originalTotalSupply = await oldSynth.methods.totalSupply().call();
				}
			} catch (err) {
				if (network !== 'local') {
					// only throw if not local - allows local environments to handle both new
					// and updating configurations
					throw err;
				}
			}
		}

		// PurgeableSynth needs additionalConstructorArgs to be ordered
		const additionalConstructorArgsMap = {
			Synth: [originalTotalSupply],
			PurgeableSynth: [exchangeRatesAddress, originalTotalSupply],
			// future subclasses...
		};

		console.log(yellow(`Original TotalSupply on Synth${currencyKey} is ${originalTotalSupply}`));

		// user confirm totalSupply is correct for oldSynth before deploy new Synth
		if (synthConfig.deploy && !yes) {
			try {
				await confirmAction(
					yellow(
						`⚠⚠⚠ WARNING: Please confirm - ${network}:\n` +
							`Synth${currencyKey} totalSupply is ${originalTotalSupply} \n`
					) +
						gray('-'.repeat(50)) +
						'\nDo you want to continue? (y/n) '
				);
			} catch (err) {
				console.log(gray('Operation cancelled'));
				return;
			}
		}

		const sourceContract = subclass || 'Synth';
		const synth = await deployContract({
			name: `Synth${currencyKey}`,
			source: sourceContract,
			deps: [`TokenState${currencyKey}`, `Proxy${currencyKey}`, 'Synthetix', 'FeePool'],
			args: [
				proxyForSynth ? proxyForSynth.address : '',
				tokenStateForSynth ? tokenStateForSynth.address : '',
				synthetixProxyAddress,
				proxyFeePool ? proxyFeePool.address : '',
				`Synth ${currencyKey}`,
				currencyKey,
				account,
				currencyKeyInBytes,
			].concat(additionalConstructorArgsMap[sourceContract] || []),
			force: addNewSynths,
		});

		const synthAddress = synth ? synth.address : '';

		if (tokenStateForSynth && synth) {
			await runStep({
				contract: `TokenState${currencyKey}`,
				target: tokenStateForSynth,
				read: 'associatedContract',
				expected: input => input === synthAddress,
				write: 'setAssociatedContract',
				writeArg: synthAddress,
			});
		}

		// Setup proxy for synth
		if (proxyForSynth && synth) {
			await runStep({
				contract: `Proxy${currencyKey}`,
				target: proxyForSynth,
				read: 'target',
				expected: input => input === synthAddress,
				write: 'setTarget',
				writeArg: synthAddress,
			});

			// ensure proxy on synth set
			await runStep({
				contract: `Synth${currencyKey}`,
				target: synth,
				read: 'proxy',
				expected: input => input === proxyForSynth.address,
				write: 'setProxy',
				writeArg: proxyForSynth.address,
			});
		}

		// Setup integration proxy (ProxyERC20) for Synth (Remove when sUSD Proxy cuts over)
		/*
		if (proxyERC20ForSynth && synth) {
			await runStep({
				contract: `Synth${currencyKey}`,
				target: synth,
				read: 'integrationProxy',
				expected: input => input === proxyERC20ForSynth.address,
				write: 'setIntegrationProxy',
				writeArg: proxyERC20ForSynth.address,
			});

			await runStep({
				contract: `ProxyERC20${currencyKey}`,
				target: proxyERC20ForSynth,
				read: 'target',
				expected: input => input === synthAddress,
				write: 'setTarget',
				writeArg: synthAddress,
			});
		}
    */

		// Now setup connection to the Synth with Synthetix
		if (synth && synthetix) {
			await runStep({
				contract: 'Synthetix',
				target: synthetix,
				read: 'synths',
				readArg: currencyKeyInBytes,
				expected: input => input === synthAddress,
				write: 'addSynth',
				writeArg: synthAddress,
			});

			await runStep({
				contract: `Synth${currencyKey}`,
				target: synth,
				read: 'synthetixProxy',
				expected: input => input === synthetixProxyAddress,
				write: 'setSynthetixProxy',
				writeArg: synthetixProxyAddress,
			});
		}

		if (proxyFeePool && synth) {
			await runStep({
				contract: `Synth${currencyKey}`,
				target: synth,
				read: 'feePoolProxy',
				expected: input => input === proxyFeePool.address,
				write: 'setFeePoolProxy',
				writeArg: proxyFeePool.address,
			});
		}

		// now setup price aggregator if any for the synth
		if (aggregator && TronWeb.isAddress(aggregator) && exchangeRates) {
			await runStep({
				contract: `ExchangeRates`,
				target: exchangeRates,
				read: 'aggregators',
				readArg: currencyKeyInBytes,
				expected: input => input === aggregator,
				write: 'addAggregator',
				writeArg: [toBytes32(currencyKey), aggregator],
			});
		}

		// ensure correct exchange rates is set on the synth (if say, ExchangeRates has changed)
		// and the synth hasn't
		if (subclass === 'PurgeableSynth' && synth && exchangeRates) {
			await runStep({
				contract: `Synth${currencyKey}`,
				target: synth,
				read: 'exchangeRates',
				expected: input => input === exchangeRatesAddress,
				write: 'setExchangeRates',
				writeArg: exchangeRatesAddress,
			});
		}

		// now configure inverse synths in exchange rates
		if (inverted) {
			const { entryPoint, upperLimit, lowerLimit } = inverted;

			// helper function
			const setInversePricing = ({ freeze, freezeAtUpperLimit }) =>
				runStep({
					contract: 'ExchangeRates',
					target: exchangeRates,
					write: 'setInversePricing',
					writeArg: [
						toBytes32(currencyKey),
						toWei(entryPoint.toString()),
						toWei(upperLimit.toString()),
						toWei(lowerLimit.toString()),
						freeze,
						freezeAtUpperLimit,
					],
				});

			// when the oldExrates exists - meaning there is a valid ExchangeRates in the existing deployment.json
			// for this environment (true for all environments except the initial deploy in 'local' during those tests)
			if (oldExrates) {
				// get inverse synth's params from the old exrates, if any exist
				const inversePricing = await oldExrates.methods
					.inversePricing(toBytes32(currencyKey))
					.call();
				const { frozen: currentRateIsFrozen } = inversePricing;
				const oldEntryPoint = toWeb3BN(inversePricing.entryPoint);
				const oldUpperLimit = toWeb3BN(inversePricing.upperLimit);
				const oldLowerLimit = toWeb3BN(inversePricing.lowerLimit);

				// and the last rate if any exists
				const currentRateForCurrency = toWeb3BN(
					await oldExrates.methods.rateForCurrency(toBytes32(currencyKey)).call()
				);

				// and total supply, if any
				const totalSynthSupply = toWeb3BN(await synth.methods.totalSupply().call());

				// When there's an inverted synth with matching parameters
				if (
					entryPoint === +fromWei(oldEntryPoint) &&
					upperLimit === +fromWei(oldUpperLimit) &&
					lowerLimit === +fromWei(oldLowerLimit)
				) {
					const freezeAtUpperLimit = +fromWei(currentRateForCurrency) === upperLimit;
					console.log(
						gray(
							`Detected an existing inverted synth for ${currencyKey} with identical parameters. ` +
								`Persisting its frozen status (${currentRateIsFrozen}) and if frozen, then freeze rate at upper (${freezeAtUpperLimit}) or lower (${!freezeAtUpperLimit}).`
						)
					);

					// then ensure it gets set to the same frozen status and frozen rate
					// as the old exchange rates
					await setInversePricing({
						freeze: currentRateIsFrozen,
						freezeAtUpperLimit,
					});
				} else if (Number(currentRateForCurrency) === 0) {
					console.log(gray(`Detected a new inverted synth for ${currencyKey}. Proceeding to add.`));
					// Then a new inverted synth is being added (as there's no previous rate for it)
					await setInversePricing({ freeze: false, freezeAtUpperLimit: false });
				} else if (Number(totalSynthSupply) === 0) {
					console.log(
						gray(
							`Inverted synth at ${currencyKey} has 0 total supply and its inverted parameters have changed. ` +
								`Proceeding to reconfigure its parameters as instructed, unfreezing it if currently frozen.`
						)
					);
					// Then a new inverted synth is being added (as there's no existing supply)
					await setInversePricing({ freeze: false, freezeAtUpperLimit: false });
				} else {
					// Then an existing synth's inverted parameters have changed.
					// For safety sake, let's inform the user and skip this step
					console.log(
						redBright(
							`⚠⚠⚠ WARNING: The parameters for the inverted synth ${currencyKey} ` +
								`have changed and it has non-zero totalSupply. This use-case is not supported by the deploy script. ` +
								`This should be done as a purge() and setInversePricing() separately`
						)
					);
				}
			} else {
				// When no exrates, then totally fresh deploy (local deployment)
				await setInversePricing({ freeze: false, freezeAtUpperLimit: false });
			}
		}
	}

	// ----------------
	// Depot setup
	// ----------------
	const sUSDAddress = deployer.deployedContracts['SynthsUSD']
		? deployer.deployedContracts['SynthsUSD'].address
		: '';

	const depot = await deployContract({
		name: 'Depot',
		deps: ['ProxySynthetix', 'SynthsUSD', 'FeePool'],
		args: [account, account, synthetix ? synthetixAddress : '', sUSDAddress],
	});

	// TODO - no longer selling OKS in depot, will revisit when deploying new Depot

	// if (synthetix && depot) {
	// 	if (network !== 'local') {
	// 		await runStep({
	// 			contract: 'Depot',
	// 			target: depot,
	// 			read: 'synthetix',
	// 			expected: input => input === synthetixAddress,
	// 			write: 'setSynthetix',
	// 			writeArg: synthetixAddress,
	// 		});
	// 	} else {
	// 		await runStep({
	// 			contract: 'Depot',
	// 			target: depot,
	// 			read: 'snxProxy',
	// 			expected: input => input === proxyERC20SynthetixAddress,
	// 			write: 'setSynthetix',
	// 			writeArg: proxyERC20SynthetixAddress,
	// 		});
	// 	}
	// }

	// ensure Depot has sUSD synth address setup correctly
	await runStep({
		contract: 'Depot',
		target: depot,
		read: 'synth',
		expected: input => input === sUSDAddress,
		write: 'setSynth',
		writeArg: sUSDAddress,
	});

	// ----------------
	// ArbRewarder setup
	// ----------------

	// ArbRewarder contract for sTRX uniswap
	const arbRewarder = await deployContract({
		name: 'ArbRewarder',
		deps: ['Synthetix', 'ExchangeRates'],
		args: [account],
	});

	if (arbRewarder) {
		// ensure exchangeRates on arbRewarder set
		await runStep({
			contract: 'ArbRewarder',
			target: arbRewarder,
			read: 'exchangeRates',
			expected: input => input === exchangeRates.address,
			write: 'setExchangeRates',
			writeArg: exchangeRates.address,
		});

		// Ensure synthetix ProxyERC20 on arbRewarder set
		await runStep({
			contract: 'ArbRewarder',
			target: arbRewarder,
			read: 'synthetixProxy',
			expected: input => input === proxyERC20SynthetixAddress,
			write: 'setSynthetix',
			writeArg: proxyERC20SynthetixAddress,
		});

		// Ensure sTRX uniswap exchange address on arbRewarder set
		// @TODO kev: this should be uniswap address on TRON
		const requiredUniswapExchange = '0xe9Cf7887b93150D4F2Da7dFc6D502B216438F244';
		// @TODO kev: this should probably be proxysTRONAddress
		const requiredSynthAddress = proxysTRXAddress;
		await runStep({
			contract: 'ArbRewarder',
			target: arbRewarder,
			read: 'uniswapAddress',
			expected: input => input === requiredUniswapExchange,
			write: 'setUniswapExchange',
			writeArg: requiredUniswapExchange,
		});

		// Ensure sTRX proxy address on arbRewarder set
		await runStep({
			contract: 'ArbRewarder',
			target: arbRewarder,
			read: 'synth',
			expected: input => input === requiredSynthAddress,
			write: 'setSynthAddress',
			writeArg: requiredSynthAddress,
		});
	}

	// ----------------
	// DappMaintenance setup
	// ----------------
	await deployContract({
		name: 'DappMaintenance',
		args: [account],
	});

	console.log(green(`\nSuccessfully deployed ${newContractsDeployed.length} contracts!\n`));

	const tableData = newContractsDeployed.map(({ name, address }) => [name, address]);
	console.log();
	if (tableData.length) {
		console.log(gray(`All contracts deployed on "${network}" network:`));
		console.log(table(tableData));
	} else {
		console.log(gray('Note: No new contracts deployed.'));
	}
};

module.exports = {
	deploy,
	DEFAULTS,
	cmd: program =>
		program
			.command('deploy')
			.description('Deploy compiled solidity files')
			.option(
				'-a, --add-new-synths',
				`Whether or not any new synths in the ${SYNTHS_FILENAME} file should be deployed if there is no entry in the config file`
			)
			.option(
				'-b, --build-path [value]',
				'Path to a folder hosting compiled files from the "build" step in this script',
				DEFAULTS.buildPath
			)
			.option(
				'-c, --contract-deployment-gas-limit <value>',
				'Contract deployment gas limit',
				parseInt,
				DEFAULTS.contractDeploymentFeeLimit
			)
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file ${CONFIG_FILENAME}, the synth list ${SYNTHS_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option(
				'-f, --fee-auth <value>',
				'The address of the fee authority for this network (default is to use existing)'
			)
			.option('-g, --gas-price <value>', 'Gas price in GWEI', DEFAULTS.gasPrice)
			.option(
				'-l, --oracle-gas-limit <value>',
				'The address of the gas limit oracle for this network (default is use existing)'
			)
			.option(
				'-m, --method-call-fee-limit <value>',
				'Method call gas limit',
				parseInt,
				DEFAULTS.methodCallFeeLimit
			)
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-o, --oracle-exrates <value>',
				'The address of the oracle for this network (default is use existing)',
				DEFAULTS.oracleExrates
			)
			.option(
				'-p, --oracle-depot <value>',
				'The address of the depot oracle for this network (default is use existing)'
			)
			.option(
				'-v, --private-key [value]',
				'The private key to deploy with (only works in local mode, otherwise set in .env).'
			)
			.option('-y, --yes', 'Dont prompt, just reply yes.')
			.action(deploy),
};
