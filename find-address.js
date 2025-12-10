const bip39 = require('bip39');
const BIP32Factory = require('bip32').BIP32Factory;
const ecc = require('tiny-secp256k1');
const bip32 = BIP32Factory(ecc);
const bitcoin = require('bitcoinjs-lib');

const NETWORK = bitcoin.networks.testnet;

async function deriveKeyAndAddress(mnemonic, accountIndex = 1, changeIndex = 0, addressIndex = 0) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const root = bip32.fromSeed(seed, NETWORK);
  const path = `m/44'/1'/${accountIndex}'/${changeIndex}/${addressIndex}`;
  const child = root.derivePath(path);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: NETWORK });
  return { address, path };
}

async function findAddress(mnemonic, targetAddress, maxIndex = 100) {
  console.log(`🔍 Поиск адреса: ${targetAddress}\n`);
  
  // Проверяем receiving (change=0)
  for (let i = 0; i < maxIndex; i++) {
    const { address, path } = await deriveKeyAndAddress(mnemonic, 1, 0, i);
    
    if (address === targetAddress) {
      console.log(`✅ Найден!`);
      console.log(`Путь: ${path}`);
      console.log(`Индекс: ${i}`);
      return;
    }
  }
  
  // Проверяем change (change=1)
  console.log('Проверяю change адреса...\n');
  for (let i = 0; i < maxIndex; i++) {
    const { address, path } = await deriveKeyAndAddress(mnemonic, 1, 1, i);
    
    if (address === targetAddress) {
      console.log(`✅ Найден!`);
      console.log(`Путь: ${path}`);
      console.log(`Индекс: ${i}`);
      return;
    }
  }
  
  console.log(`❌ Не найден в первых ${maxIndex} адресах (receiving + change)`);
}

(async () => {
  const mnemonic = 'chalk cover vocal advice office close rifle agree destroy pole invite tumble';
  await findAddress(mnemonic, 'tb1qq60unf5z3ssrzzk9gr6n0vpmlpnqdpd3u6xhrg', 100);
})();
