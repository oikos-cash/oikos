# Oikos Tron Contracts

[![npm version](https://badge.fury.io/js/@oikos/oikos.svg)](https://badge.fury.io/js/@oikos/oikos)
[![Twitter Follow](https://img.shields.io/twitter/follow/oikos_cash.svg?label=oikos_cash&style=social)](https://twitter.com/oikos_cash)

Oikos is Synthetix for Tron: a crypto-backed synthetic asset platform.

It is a multitoken system, powered by OKS, the Oikos Network Token. OKS holders can lock OKS to issue on-chain synthetic assets. The network currently supports seven synthetic assets, sUSD (Synthetic USD), sAUD, sEUR, sGBP, sJPY, sKRW, sXAU (a synthetic gold ounce) and sXDR (a basket of synthetic currencies).

Oikos uses a proxy system so that upgrades will not be disruptive to the functionality of the contract. This smooths user interaction, since new functionality will become available without any interruption in their experience. It is also transparent to the community at large, since each upgrade is accompanied by events announcing those upgrades.

Prices are currently introduced into the blockchain by a trusted oracle. A parallel avenue of research is the ongoing decentralisation of this price oracle.

Please note that this repository is under development.

The code here will be under continual audit and improvement as the project progresses.

## DApps

- https://mint.oikos.cash
- https://oikos.exchange
- https://swat.oikos.cash

## Branching

A note on the branches used in this repo.

- `master` represents the contracts live on `mainnet` and all testnets.

When a new version of the contracts makes its way through all testnets, it eventually becomes promoted in `master`, with [semver](https://semver.org/) reflecting contract changes in the `major` or `minor` portion of the version (depending on backwards compatibility). `patch` changes are simply for changes to the JavaScript interface.

## Usage and requirements

### As an npm module

```javascript
const oikos = require('@oikos/oikos');

// retrieve an object detailing the contract deployed to the given network.
oikos.getTarget({ network: 'shasta', contract: 'ProxySynthetix' });

// retrieve an object detailing the contract ABI and bytecode
oikos.getSource({ network: 'shasta', contract: 'Proxy' });
/*
{
  bytecode: '0..0',
  abi: [ ... ]
}
*/

// retrieve the array of assets used
oikos.getSynths({ network: 'shasta' }).map(({ name }) => name);
// ['XDR', 'sUSD', 'sEUR', ...]
```

### As an npm CLI tool

Same as above but as a CLI tool that outputs JSON:

```bash
npx oikos target --network rinkeby --contract ProxySynthetix

npx oikos source --network rinkeby --contract Proxy
# {
#   "bytecode": "0..0",
#   "abi": [ ... ]
# }

npx oikos synths --network rinkeby --key name
# ["XDR", "sUSD", "sEUR", ... ]
```

### For tests (in JavaScript)

Install the dependencies for the project using npm

```
$ npm i
```

To run the tests:

```
$ npm test
```

## System Summary

Traditionally gold was used as a reserve store of value by various governments around the world to prove that there was value to back their currency. The Oikos system replicates this setup, but completely on-chain, and with multiple flavours of stablecoin, and a store of value backing them up (OKS - Oikos Network Token).

As users transact in the system, small fees are remitted, which get sent to OKS holders that enable the economy to exist. Multicurrency is the latest piece of work on the system.

Users are able to withdraw their fees in any nomin currency that we support. Users are entitled to fees once they've issued synthetic assets (to help create the economy generating the fees) and waited for a complete fee period to elapse (currently 7 days). Issuers are incentivised to maintain the ratio of collateral (OKS) to assets such that the assets in circulation are generally only worth 20% of the value of the Oikos Network Tokens backing them up via a penalty for being over 20% collateralised. This allows pretty severe price shocks to OKS without threatening the value of the assets.

We have also invented a nomin currency called XDRs (Oikos Drawing Rights, loosely modeled on SDRs from the UN). Its exchange rate is derived by looking at a basket aggregate of currencies to avoid biasing towards any particular fiat currency. Fees are stored in this currency, and users can hold these assets if they want to lessen the impact on their holdings from a particular fiat currency changing in value.

Now that we have an `exchange()` mechanism that allows users to switch between assets, it made sense to move the fee logic out the asset token into its own standalone contract. This allows us to have more complex fee collection logic as well.

Also it's worth noting that there's a decimal library being used for "floating point" math with 10^18 as the base. Also many of the contracts are provided behind a proxy contract for easy upgradability.

---

## Contracts

- **ExchangeRates.sol:** A key value store (bytes4 -> uint) of currency exchange rates, all priced in USD. Understands the concept of whether a rate is stale (as in hasn't been updated frequently enough), and only allows a single annointed oracle address to do price updates.
- **ExternStateToken.sol:** The concept of an ERC20 token which stores its allowances and balances outside of the contract for upgradability.
- **FeePool.sol:** Understands fee information for Oikos. As users transact, their fees are kept in `0xfeefeefee...` and stored in XDRs. Allows users to claim fees they're entitled to.
- **Synthetix.sol:** Has a list of assets and understands issuance data for users to be able to mint and burn asssets.
- **SynthetixEscrow.sol:** During the crowdsale, users were asked to escrow their Havvens to insulate against price shocks on the token. Users are able to unlock their OKS on a vesting schedule.
- **Depot.sol:** Allows users to exchange ETH for sUSD and OKS (has not yet been updated for multicurrency).
- **LimitedSetup.sol:** Some contracts have actions that should only be able to be performed during a specific limited setup period. After this period elapses, any functions using the `onlyDuringSetup` modifier should no longer be callable.
- **Migrations.sol:** Truffle's migrations contract.
- **Synth.sol:** Oikos token contract which remits fees on transfers, and directs the Oikos contract to do exchanges when appropriate.
- **SynthAirdropper.sol:** Used to optimise gas during our initial airdrop of asset.
- **Owned.sol:** Allows us to leverage the concept of a contract owner that is specially priviledged and can perform certain actions.
- **Pausable.sol:** Implements the concept of a pause button on a contract. Methods that should be paused use a particular modifier.
- **Proxy.sol:** Our proxy contracts which forward all calls they receive to their target. Events are always emitted at the proxy, not within the target, even if you call the target directly.
- **Proxyable.sol:** Implemented on a contract so it can be the target of a proxy contract.
- **SafeDecimalMath.sol:** Safe math + decimal math. Using `_dec` on an operation makes it operate "on decimals" by either dividing out the extra UNIT after a multiplication, or multiplying it in before a division.
- **SelfDestructible.sol:** Allows an owner of a contract to set a self destruct timer on it, then once the timer has expired, to kill the contract with `selfdestruct`.
- **State.sol:** Implements the concept of an associated contract which can be changed by the owner.
- **TokenState.sol:** Holds approval and balance information for tokens.
