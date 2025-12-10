const fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));
const bip39 = require('bip39');
const BIP32Factory = require('bip32').BIP32Factory;
const ecc = require('tiny-secp256k1');
const bip32 = BIP32Factory(ecc);
const bitcoin = require('bitcoinjs-lib');

const NETWORK = bitcoin.networks.testnet;

async function deriveKeyAndAddress(mnemonic, accountIndex = 1, changeIndex = 0, addressIndex = 0) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed, NETWORK);
  // BIP44 path для testnet: m/44'/1'/account'/change/address_index
  const path = `m/44'/1'/${accountIndex}'/${changeIndex}/${addressIndex}`;
  const child = root.derivePath(path);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: NETWORK });
  return { address, path };
}

async function checkWallet(mnemonic, accountIndex = 1, gapLimit = 20) {
  console.log(`🔍 Сканирование адресов (account = ${accountIndex}, gap limit = ${gapLimit})...\n`);
  
  let totalBalance = 0;
  let addressesWithBalance = [];
  let emptyCount = 0;
  let addressIndex = 0;
  
  // Сканируем по алгоритму gap limit
  while (emptyCount < gapLimit) {
    const { address, path } = await deriveKeyAndAddress(mnemonic, accountIndex, 0, addressIndex);
    
    try {
      const response = await fetch(`https://mempool.space/testnet4/api/address/${address}`);
      const data = await response.json();
      
      const balanceBTC = (data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum) / 1e8;
      const txCount = data.chain_stats.tx_count;
      
      // Показываем только адреса с балансом
      if (balanceBTC > 0) {
        console.log(`${path}`);
        console.log(`Адрес: ${address}`);
        console.log(`Баланс: ${balanceBTC} BTC`);
        console.log(`Транзакций: ${txCount}`);
        console.log('---');
      }
      
      if (balanceBTC > 0) {
        addressesWithBalance.push({ address, path, balance: balanceBTC });
        totalBalance += balanceBTC;
        emptyCount = 0; // Сбрасываем счётчик пустых
      } else if (txCount === 0) {
        emptyCount++; // Увеличиваем счётчик пустых
      } else {
        emptyCount = 0; // Были транзакции, но баланс 0
      }
    } catch (err) {
      console.error(`Ошибка для ${address}:`, err.message);
      emptyCount++;
    }
    
    addressIndex++;
  }
  
  console.log(`\n✅ Просканировано receiving адресов: ${addressIndex}`);
  
  // Сканируем change адреса (сдача)
  console.log(`\n🔍 Сканирование change адресов (сдача)...\n`);
  emptyCount = 0;
  addressIndex = 0;
  
  while (emptyCount < gapLimit) {
    const { address, path } = await deriveKeyAndAddress(mnemonic, accountIndex, 1, addressIndex);
    
    try {
      const response = await fetch(`https://mempool.space/testnet4/api/address/${address}`);
      const data = await response.json();
      
      const balanceBTC = (data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum) / 1e8;
      const txCount = data.chain_stats.tx_count;
      
      if (balanceBTC > 0) {
        console.log(`${path}`);
        console.log(`Адрес: ${address}`);
        console.log(`Баланс: ${balanceBTC} BTC`);
        console.log(`Транзакций: ${txCount}`);
        console.log('---');
        
        addressesWithBalance.push({ address, path, balance: balanceBTC });
        totalBalance += balanceBTC;
        emptyCount = 0;
      } else if (txCount === 0) {
        emptyCount++;
      } else {
        emptyCount = 0;
      }
    } catch (err) {
      console.error(`Ошибка для ${address}:`, err.message);
      emptyCount++;
    }
    
    addressIndex++;
  }
  
  console.log(`\n✅ Просканировано change адресов: ${addressIndex}`);
  console.log(`📊 Общий баланс: ${totalBalance} BTC`);
  
  if (addressesWithBalance.length > 0) {
    console.log(`\n💰 Адреса с балансом:`);
    addressesWithBalance.forEach(a => {
      console.log(`  ${a.path}: ${a.balance} BTC`);
    });
  }
}

(async () => {
  const mnemonic = 'chalk cover vocal advice office close ring agree destroy pole invite tumble';
  const accountIndex = 1; // второй счёт (m/44'/1'/1'/...)
  await checkWallet(mnemonic, accountIndex);
})();
