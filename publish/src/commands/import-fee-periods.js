'use strict';

const path = require('path');
const fs = require('fs');
const w3utils = require('web3-utils');
const Web3 = require('web3');
const { red, gray, green, yellow } = require('chalk');
const { createJavaTronProvider } = require('@opentron/java-tron-provider');

const { CONFIG_FILENAME, DEPLOYMENT_FILENAME } = require('../constants');

const isAddress = addr => {
	// todo: check if tron address
	return true;
};

const DEFAULTS = {
	gasPrice: '1',
	gasLimit: 1.5e6, // 1.5m
	network: 'mainnet',
};

const {
	ensureNetwork,
	ensureDeploymentPath,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	stringify,
} = require('../util');

const pathToLocal = name => path.join(__dirname, `${name}.json`);

const saveFeePeriodsToFile = async ({ network, feePeriods, sourceContractAddress }) => {
	await fs.writeFileSync(
		pathToLocal(`recent-feePeriods-${network}-${sourceContractAddress}`),
		stringify(feePeriods)
	);
};

const importFeePeriods = async ({
	deploymentPath,
	network = DEFAULTS.network,
	gasPrice = DEFAULTS.gasPrice,
	gasLimit = DEFAULTS.gasLimit,
	sourceContractAddress,
	privateKey,
	yes,
	override,
}) => {
	ensureNetwork(network);
	ensureDeploymentPath(deploymentPath);

	if (!isAddress(sourceContractAddress)) {
		throw Error(
			'Invalid address detected for source (please check your inputs): ',
			sourceContractAddress
		);
	}

	const { deployment } = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	const { providerUrl, privateKey: envPrivateKey, etherscanLinkPrefix } = loadConnections({
		network,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	const web3 = new Web3(
		createJavaTronProvider({
			network,
			privateKey,
		})
	);
	// web3.eth.accounts.wallet.add(privateKey);
	// const account = web3.eth.accounts.wallet[0].address;
	const account = web3.eth.accounts.privateKeyToAccount(privateKey).address;
	console.log(gray(`Using account with public key ${account}`));

	const feePeriods = [];

	const { address: targetContractAddress_, source } = deployment.targets['FeePool'];
	const targetContractAddress = targetContractAddress_.replace(/^41/, '0x');
	const { abi } = deployment.sources[source];
	if (sourceContractAddress.toLowerCase() === targetContractAddress.toLowerCase()) {
		throw Error(
			'Cannot use same FeePool address as the source and the target. Check your source input.'
		);
	} else {
		console.log(gray(`Reading from old FeePool at: ${sourceContractAddress}`));
		console.log(gray(`Importing into new FeePool at: ${targetContractAddress}`));
	}
	const sourceContract = new web3.eth.Contract(abi, sourceContractAddress);
	const targetContract = new web3.eth.Contract(abi, targetContractAddress);

	const feePeriodLength = await sourceContract.methods.FEE_PERIOD_LENGTH().call();

	// Check sources
	for (let i = 0; i <= feePeriodLength - 1; i++) {
		const period = await sourceContract.methods.recentFeePeriods(i).call();
		if (period.feePeriodId === '0') {
			throw Error(
				`Fee period at index ${i} has NOT been set. Are you sure this is the right FeePool source? ${etherscanLinkPrefix}/address/${sourceContractAddress} `
			);
		} else if (i === 0 && period.startTime < Date.now() / 1000 - 3600 * 24 * 7) {
			throw Error(
				`The initial fee period is more than one week ago - this is likely an error. ` +
					`Please check to make sure you are using the correct FeePool source (this should ` +
					`be the one most recently replaced). Given: ${etherscanLinkPrefix}/address/${sourceContractAddress}`
			);
		}
		// remove redundant index keys (returned from struct calls)
		Object.keys(period)
			.filter(key => /^[0-9]+$/.test(key))
			.forEach(key => delete period[key]);
		feePeriods.push(period);
		console.log(
			gray(`loaded feePeriod ${i} from FeePool (startTime: ${new Date(period.startTime * 1000)})`)
		);
	}

	// Check target does not have existing periods
	if (!override) {
		for (let i = 0; i <= feePeriodLength - 1; i++) {
			const period = await targetContract.methods.recentFeePeriods(i).call();
			// ignore any initial entry where feePeriodId is 1 as this is created by the FeePool constructor
			if (period.feePeriodId !== '1' && period.startTime !== '0') {
				throw Error(
					`The new target FeePool already has imported fee periods (one or more entries has ` +
						`startTime as 0. Please check to make sure you are using the latest FeePool ` +
						`(this should be the most recently deployed). Given: ${etherscanLinkPrefix}/address/${targetContractAddress}`
				);
			}
		}
	} else {
		console.log(
			gray('Warning: Setting target to override - ignoring existing FeePool periods in target!')
		);
	}

	console.log(gray('The fee periods to import over are as follows:'));
	console.log(gray(stringify(feePeriods)));

	console.log(gray(`Gas Price: ${gasPrice} gwei`));

	if (network !== 'local') {
		await saveFeePeriodsToFile({ network, feePeriods, sourceContractAddress });
	}

	let index = 0;
	for (const feePeriod of feePeriods) {
		console.log('Fee period to import is as follows:');
		console.log(stringify(feePeriod));

		if (!yes) {
			try {
				await confirmAction(
					yellow(
						`Do you want to continue importing this fee period in index position ${index} (y/n) ?`
					)
				);
			} catch (err) {
				console.log(gray('Operation cancelled'));
				return;
			}
		}

		const importArgs = [
			index,
			feePeriod.feePeriodId,
			feePeriod.startingDebtIndex,
			feePeriod.startTime,
			feePeriod.feesToDistribute,
			feePeriod.feesClaimed,
			feePeriod.rewardsToDistribute,
			feePeriod.rewardsClaimed,
		];
		console.log(yellow(`Attempting action FeePool.importFeePeriod(${importArgs})`));
		const { transactionHash } = await targetContract.methods.importFeePeriod(...importArgs).send({
			from: account,
			gasLimit: Number(gasLimit),
			gasPrice: w3utils.toWei(gasPrice.toString(), 'gwei'),
		});
		index++;

		console.log(
			green(
				`Successfully emitted importFeePeriod with transaction: ${etherscanLinkPrefix}/tx/${transactionHash}`
			)
		);
	}

	console.log(gray('Action complete.'));
};

module.exports = {
	importFeePeriods,
	cmd: program =>
		program
			.command('import-fee-periods')
			.description('Import fee periods')
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file (${CONFIG_FILENAME}) and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option('-g, --gas-price <value>', 'Gas price in GWEI', DEFAULTS.gasPrice)
			.option('-l, --gas-limit <value>', 'Gas limit', parseInt, DEFAULTS.gasLimit)
			.option('-s, --source-contract-address <value>', 'The Fee Pool source contract address')
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-v, --private-key [value]',
				'The private key to deploy with (only works in local mode, otherwise set in .env).'
			)
			.option(
				'-o, --override',
				'Override fee periods in target - use when resuming an import process that failed or was cancelled partway through'
			)

			.option('-y, --yes', 'Dont prompt, just reply yes.')

			.action(async (...args) => {
				try {
					await importFeePeriods(...args);
				} catch (err) {
					// show pretty errors for CLI users
					console.error(red(err));
					process.exitCode = 1;
				}
			}),
};
