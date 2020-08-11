const { merge } = require('sol-merger');

const go = async () => {
// Get the merged code as a string
const mergedCode = await merge("./contracts/ProxyERC20.sol");
// Print it out or write it to a file etc.
console.log(mergedCode);
}

go();
