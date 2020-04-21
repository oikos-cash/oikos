'use strict';

const linker = require('solc/linker');
const Web3 = require('web3');
const TronWeb = require('tronweb');
const { gray, green, yellow } = require('chalk');

/**
 *
 */
class Deployer {
	/**
	 *
	 * @param {object} compiled An object with full combined contract name keys mapping to ABIs and bytecode
	 * @param {object} config An object with full combined contract name keys mapping to a deploy flag and the contract source file name
	 * @param {object} deployment An object with full combined contract name keys mapping to existing deployment addresses (if any)
	 */
	constructor({
		compiled,
		config,
		deployment,
		gasPrice,
		methodCallFeeLimit,
		contractDeploymentFeeLimit,
		providerUrl,
		privateKey,
	}) {
		this.compiled = compiled;
		this.config = config;
		this.deployment = deployment;
		this.gasPrice = gasPrice;
		this.methodCallFeeLimit = methodCallFeeLimit;
		this.contractDeploymentFeeLimit = contractDeploymentFeeLimit;

		// Configure Web3 so we can sign transactions and connect to the network.
		const HttpProvider = TronWeb.providers.HttpProvider;
		const fullNode = new HttpProvider(providerUrl);
		const solidityNode = new HttpProvider(providerUrl);
		const eventServer = new HttpProvider(providerUrl);
		this.tronWeb = new TronWeb(fullNode, solidityNode, eventServer, privateKey);
		// console.log(this.tronWeb);
		this.web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));

		this.web3.eth.accounts.wallet.add(privateKey);
		this.web3.eth.defaultAccount = this.web3.eth.accounts.wallet[0].address;
		// this.account = this.web3.eth.defaultAccount;
		this.account = this.tronWeb.defaultAddress.base58;
		this.deployedContracts = {};
	}

	sendParameters(type = 'method-call') {
		// TODO! proper limits for Tron network
		return {
			// feeLimit: type === 'method-call' ? this.methodCallFeeLimit : this.contractDeploymentFeeLimit,
			// callValue: 0,
			// userFeePercentage: 1,
		};
	}

	async deploy({ name, source, args = [], deps = [], force = false }) {
		const tronWeb = this.tronWeb;
		if (!this.config[name] && !force) {
			console.log(yellow(`Skipping ${name} as it is NOT in contract flags file for deployment.`));
			return;
		}
		const missingDeps = deps.filter(d => !this.deployedContracts[d]);
		if (missingDeps.length) {
			throw Error(`Cannot deploy ${name} as it is missing dependencies: ${missingDeps.join(',')}`);
		} // by default, we deploy if force tells us to
		let deploy = force;
		// though use what's in the config if it exists
		if (this.config[name]) {
			deploy = this.config[name].deploy;
		}
		const compiled = this.compiled[source];
		const existingAddress = this.deployment.targets[name]
			? this.deployment.targets[name].address
			: '';

		if (!compiled) {
			throw new Error(
				`No compiled source for: ${name}. The source file is set to ${source}.sol - is that correct?`
			);
		}

		// Any contract after SafeDecimalMath can automatically get linked.
		// Doing this with bytecode that doesn't require the library is a no-op.
		let bytecode = compiled.evm.bytecode.object;
		['SafeDecimalMath', 'Math'].forEach(contractName => {
			if (this.deployedContracts[contractName]) {
				// @kev: remove "41" hex prefix, otherwise solc thinks it's an invalid
				// adddress
				// https://github.com/TRON-US/tronbox/blob/a2620da6e669c595fef5e7068b20638a43fbb382/src/components/Contract/contract.js#L259
				let addr = this.deployedContracts[contractName].address;
				addr = addr.replace(/^41/, '0x');
				const linkerOpts = {
					[source + '.sol']: {
						[contractName]: addr,
					},
				};
				bytecode = linker.linkBytecode(bytecode, linkerOpts);
			}
		});

		compiled.evm.bytecode.linkedObject = bytecode;

		let contractInstance;

		if (deploy) {
			console.log(gray(` - Attempting to deploy ${name}`));

			// https://developers.tron.network/reference#tronwebcontractnew
			const contractOpts = {
				abi: compiled.abi,
				bytecode: bytecode,
				parameters: args,
				...this.sendParameters('contract-deployment'),
			};
			try {
				contractInstance = await tronWeb.contract().new(contractOpts);
			} catch (err) {
				console.log(contractOpts);
				console.error(err);
				if (
					err.message &&
					err.message.match(/account not exists/) &&
					tronWeb.fullNode.host.match(/shasta/)
				) {
					console.info(
						`You can get testnet coins for ${this.account} at https://www.trongrid.io/faucet`
					);
				}
				throw err;
			}
			console.log(green(` - Deployed ${name} to ${contractInstance.address}`));
		} else if (existingAddress) {
			console.log(`getting contract at address ${existingAddress}`);
			contractInstance = await this.getContract({ abi: compiled.abi, address: existingAddress });
			console.log(gray(` - Reusing instance of ${name} at ${existingAddress}`));
		} else {
			throw new Error(
				`Settings for contract: ${name} specify an existing contract, but do not give an address.`
			);
		}

		// append new deployedContract
		this.deployedContracts[name] = contractInstance;

		return contractInstance;
	}

	async getContract({ abi, address }) {
		// return new this.web3.eth.Contract(abi, address);
		// console.log(abi);
		return this.tronWeb.contract(abi, address);
	}
}

module.exports = Deployer;
