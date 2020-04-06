'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { gray, cyan, yellow, redBright } = require('chalk');
// const w3utils = require('web3-utils');
const TronWeb = require('tronweb');

const {
	CONFIG_FILENAME,
	DEPLOYMENT_FILENAME,
	OWNER_ACTIONS_FILENAME,
	SYNTHS_FILENAME,
} = require('./constants');

const stringify = input => JSON.stringify(input, null, '\t') + '\n';

const ensureNetwork = network => {
	if (!/^(local|mainnet|shasta|tronex|nile)$/.test(network)) {
		throw Error(
			`Invalid network name of "${network}" supplied. Must be one of local, kovan, rinkeby, ropsten or mainnet`
		);
	}
};
const ensureDeploymentPath = deploymentPath => {
	if (!fs.existsSync(deploymentPath)) {
		throw Error(
			`Invalid deployment path. Please provide a folder with a compatible ${CONFIG_FILENAME}`
		);
	}
};

// Load up all contracts in the flagged source, get their deployed addresses (if any) and compiled sources
const loadAndCheckRequiredSources = ({ deploymentPath, network }) => {
	console.log(gray(`Loading the list of synths for ${network.toUpperCase()}...`));
	const synthsFile = path.join(deploymentPath, SYNTHS_FILENAME);
	const synths = JSON.parse(fs.readFileSync(synthsFile));
	console.log(gray(`Loading the list of contracts to deploy on ${network.toUpperCase()}...`));
	const configFile = path.join(deploymentPath, CONFIG_FILENAME);
	const config = JSON.parse(fs.readFileSync(configFile));

	console.log(
		gray(`Loading the list of contracts already deployed for ${network.toUpperCase()}...`)
	);
	const deploymentFile = path.join(deploymentPath, DEPLOYMENT_FILENAME);
	if (!fs.existsSync(deploymentFile)) {
		fs.writeFileSync(deploymentFile, stringify({ targets: {}, sources: {} }));
	}
	const deployment = JSON.parse(fs.readFileSync(deploymentFile));

	const ownerActionsFile = path.join(deploymentPath, OWNER_ACTIONS_FILENAME);
	if (!fs.existsSync(ownerActionsFile)) {
		fs.writeFileSync(ownerActionsFile, stringify({}));
	}
	const ownerActions = JSON.parse(fs.readFileSync(ownerActionsFile));

	return {
		config,
		configFile,
		synths,
		synthsFile,
		deployment,
		deploymentFile,
		ownerActions,
		ownerActionsFile,
	};
};

const loadConnections = ({ network }) => {
	const privateKey = process.env.DEPLOY_PRIVATE_KEY;
	if (network !== 'local' && !privateKey)
		throw new Error('Set environment variable DEPLOY_PRIVATE_KEY to a Tron private key');

	let providerUrl = 'http://127.0.0.1:9090';
	if (network === 'local' && process.env.TRONBOX_URL) {
		providerUrl = process.env.TRONBOX_URL;
	}
	if (network === 'shasta') {
		providerUrl = 'https://api.shasta.trongrid.io';
	}
	if (network === 'mainnet') {
		providerUrl = 'https://api.trongrid.io';
	}

	// TODO!

	const tronscanLinkPrefix = `https://${network !== 'mainnet' ? network + '.' : ''}tronscan.org`;
	const tronscanUrl = tronscanLinkPrefix;
	return { providerUrl, privateKey, tronscanUrl, tronscanLinkPrefix };
};

const confirmAction = prompt =>
	new Promise((resolve, reject) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

		rl.question(prompt, answer => {
			if (/y|Y/.test(answer)) resolve();
			else reject(Error('Not confirmed'));
			rl.close();
		});
	});

const appendOwnerActionGenerator = ({ ownerActions, ownerActionsFile, tronscanLinkPrefix }) => ({
	key,
	action,
	target,
}) => {
	ownerActions[key] = {
		target,
		action,
		complete: false,
		link: `${tronscanLinkPrefix}/address/${target}#writeContract`,
	};
	fs.writeFileSync(ownerActionsFile, stringify(ownerActions));
	console.log(cyan(`Cannot invoke ${key} as not owner. Appended to actions.`));
};

/**
 * Run a single transaction step, first checking to see if the value needs
 * changing at all, and then whether or not its the owner running it.
 *
 * @returns transaction hash if successful, true if user completed, or falsy otherwise
 */
const performTransactionalStep = async ({
	account,
	contract,
	target,
	read,
	readArg, // none, 1 or an array of args, array will be spread into params
	expected,
	write,
	writeArg, // none, 1 or an array of args, array will be spread into params
	feeLimit,
	tronscanLinkPrefix,
	ownerActions,
	ownerActionsFile,
}) => {
	const action = `${contract}.${write}(${writeArg})`;

	// check to see if action required
	console.log(yellow(`Attempting action: ${action}`));

	if (read) {
		// web3 counts provided arguments - even undefined ones - and they must match the expected args, hence the below
		const argumentsForReadFunction = [].concat(readArg).filter(entry => entry !== undefined); // reduce to array of args
		const response = await target.methods[read](...argumentsForReadFunction).call();

		if (expected(response)) {
			console.log(gray(`Nothing required for this action.`));
			return;
		}
	}
	// otherwuse check the owner
	const owner = await target.methods.owner().call();
	const argumentsForWriteFunction = [].concat(writeArg).filter(entry => entry !== undefined); // reduce to array of args
	const accountHex = TronWeb.address.toHex(account);
	if (owner === accountHex) {
		// perform action
		const txn = await target.methods[write](...argumentsForWriteFunction).send({
			from: account,
			// gas: Number(feeLimit),
			// gasPrice: w3utils.toWei(gasPrice.toString(), 'gwei'),
		});

		console.log(gray(`Successfully completed ${action} in hash: ${txn}`));

		return txn;
	}

	if (ownerActions && ownerActionsFile) {
		// append to owner actions if supplied
		const appendOwnerAction = appendOwnerActionGenerator({
			ownerActions,
			ownerActionsFile,
			tronscanLinkPrefix,
		});

		appendOwnerAction({
			key: action,
			target: target.address,
			action: `${write}(${argumentsForWriteFunction})`,
		});
		return true;
	} else {
		// otherwise wait for owner in real time
		try {
			await confirmAction(
				redBright(
					`YOUR TASK: Invoke ${write}(${argumentsForWriteFunction}) via ${tronscanLinkPrefix}/address/` +
						target.address +
						'#writeContract'
				) + '\nPlease enter Y when the transaction has been mined and not earlier. '
			);

			return true;
		} catch (err) {
			console.log(gray('Cancelled'));
		}
	}
};

module.exports = {
	ensureNetwork,
	ensureDeploymentPath,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	appendOwnerActionGenerator,
	stringify,
	performTransactionalStep,
};
